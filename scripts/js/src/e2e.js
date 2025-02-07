const fs = require('fs');
const crypto = require('crypto');

const {ApiPromise, WsProvider, Keyring} = require('@polkadot/api');
const {ContractPromise} = require('@polkadot/api-contract');
const Phala = require('@phala/sdk');

const { TxQueue, checkUntil, checkUntilEq, blockBarrier, hex } = require('./utils.js');

const CONTRACT_NAMES = [
    ['fat_badges', 'FatBadges'],
    ['easy_oracle', 'EasyOracle'],
    ['advanced_judger', 'AdvancedJudger'],
]

function loadContract(name) {
    const wasmPath = `../../target/ink/${name}/${name}.wasm`;
    const metadataPath = `../../target/ink/${name}/metadata.json`;
    const wasm = hex(fs.readFileSync(wasmPath, 'hex'));
    const metadata = JSON.parse(fs.readFileSync(metadataPath));
    const constructor = metadata.V3.spec.constructors.find(c => c.label == 'new').selector;
    return {wasm, metadata, constructor};
}


async function getWorkerPubkey(api) {
    const workers = await api.query.phalaRegistry.workers.entries();
    const worker = workers[0][0].args[0].toString();
    return worker;
}

async function setupGatekeeper(api, txpool, pair, worker) {
    if ((await api.query.phalaRegistry.gatekeeper()).length > 0) {
        return;
    }
    console.log('Gatekeeper: registering');
    await txpool.submit(
        api.tx.sudo.sudo(
            api.tx.phalaRegistry.registerGatekeeper(worker)
        ),
        pair,
    );
    await checkUntil(
        async () => (await api.query.phalaRegistry.gatekeeper()).length == 1,
        4 * 6000
    );
    console.log('Gatekeeper: added');
    await checkUntil(
        async () => (await api.query.phalaRegistry.gatekeeperMasterPubkey()).isSome,
        4 * 6000
    );
    console.log('Gatekeeper: master key ready');
}

async function deployCluster(api, txqueue, pair, worker, defaultCluster = '0x0000000000000000000000000000000000000000000000000000000000000000') {
    if ((await api.query.phalaRegistry.clusterKeys(defaultCluster)).isSome) {
        return defaultCluster;
    }
    console.log('Cluster: creating');
    // crete contract cluster and wait for the setup
    const { events } = await txqueue.submit(
        api.tx.phalaFatContracts.addCluster(
            'Public', // can be {'OnlyOwner': accountId}
            [worker]
        ),
        pair
    );
    const ev = events[1].event;
    console.assert(ev.section == 'phalaFatContracts' && ev.method == 'ClusterCreated');
    const clusterId = ev.data[0].toString();
    console.log('Cluster: created', clusterId)
    await checkUntil(
        async () => (await api.query.phalaRegistry.clusterKeys(clusterId)).isSome,
        4 * 6000
    );
    return clusterId;
}

async function deployContracts(api, txqueue, pair, artifacts, clusterId) {
    console.log('Contracts: uploading');
    // upload contracts
    const contractNames = Object.keys(artifacts);
    const { events: deployEvents } = await txqueue.submit(
        api.tx.utility.batchAll(
            Object.entries(artifacts).flatMap(([_k, v]) => [
                api.tx.phalaFatContracts.uploadCodeToCluster(v.wasm, clusterId),
                api.tx.phalaFatContracts.instantiateContract(
                    { WasmCode: v.metadata.source.hash },
                    v.constructor,
                    hex(crypto.randomBytes(4).toString('hex')), // salt
                    clusterId,
                )
            ])
        ),
        pair
    );
    const contractIds = deployEvents
        .filter(ev => ev.event.section == 'phalaFatContracts' && ev.event.method == 'Instantiating')
        .map(ev => ev.event.data[0].toString());
    const numContracts = contractNames.length;
    console.assert(contractIds.length == numContracts, 'Incorrect length:', `${contractIds.length} vs ${numContracts}`);
    for (const [i, id] of contractIds.entries()) {
        artifacts[contractNames[i]].address = id;
    }
    await checkUntilEq(
        async () => (await api.query.phalaFatContracts.clusterContracts(clusterId))
            .filter(c => contractIds.includes(c.toString()) )
            .length,
        numContracts,
        4 * 6000
    );
    console.log('Contracts: uploaded');
    for (const [name, contract] of Object.entries(artifacts)) {
        await checkUntil(
            async () => (await api.query.phalaRegistry.contractKeys(contract.address)).isSome,
            4 * 6000
        );
        console.log('Contracts:', contract.address, name, 'key ready');
    }
    console.log('Contracts: deployed');
}

async function main() {
    const artifacts = Object.assign(
        {}, ...CONTRACT_NAMES.map(
            ([filename, name]) => ({[name]: loadContract(filename)})
        )
    );

    // connect to the chain
    const wsProvider = new WsProvider('ws://localhost:19944');
    const api = await ApiPromise.create({
        provider: wsProvider,
        types: {
            ...Phala.types,
            'GistQuote': {
                username: 'String',
                accountId: 'AccountId',
            },
        }
    });
    const txqueue = new TxQueue(api);

    // prepare accounts
    const keyring = new Keyring({type: 'sr25519'})
    const alice = keyring.addFromUri('//Alice')
    const bob = keyring.addFromUri('//Bob')
    const certAlice = await Phala.signCertificate({api, pair: alice});
    const certBob = await Phala.signCertificate({api, pair: bob});

    // connect to pruntime
    const pruntimeURL = 'http://localhost:18000';
    const prpc = Phala.createPruntimeApi(pruntimeURL);
    const worker = await getWorkerPubkey(api);
    const connectedWorker = hex((await prpc.getInfo({})).publicKey);
    console.log('Worker:', worker);
    console.log('Connected worker:', connectedWorker);

    // basic phala network setup
    await setupGatekeeper(api, txqueue, alice, worker);
    const clusterId = await deployCluster(api, txqueue, alice, worker);

    // contracts
    await deployContracts(api, txqueue, bob, artifacts, clusterId);
    
    // create Fat Contract objects
    const contracts = {};
    for (const [name, contract] of Object.entries(artifacts)) {
        const contractId = contract.address;
        const newApi = await api.clone().isReady;
        contracts[name] = new ContractPromise(
            await Phala.create({api: newApi, baseURL: pruntimeURL, contractId}),
            contract.metadata,
            contractId
        );
    }
    console.log('Fat Contract: connected');
    const { FatBadges, EasyOracle, AdvancedJudger } = contracts;
    
    // set up the contracts
    const easyBadgeId = 0;
    const advBadgeId = 1;
    await txqueue.submit(
        api.tx.utility.batchAll([
            // set up the badges; assume the ids are 0 and 1.
            FatBadges.tx.newBadge({}, 'fat-easy-challenge'),
            FatBadges.tx.newBadge({}, 'fat-adv-challenge'),
            // fill with code
            FatBadges.tx.addCode({}, easyBadgeId, ['easy1', 'easy2']),
            FatBadges.tx.addCode({}, advBadgeId, ['adv1', 'adv2']),
            // set the issuers
            FatBadges.tx.addIssuer({}, easyBadgeId, artifacts.EasyOracle.address),
            FatBadges.tx.addIssuer({}, advBadgeId, artifacts.AdvancedJudger.address),
            // config the issuers
            EasyOracle.tx.configIssuer({}, artifacts.FatBadges.address, easyBadgeId),
            AdvancedJudger.tx.configIssuer({}, artifacts.FatBadges.address, advBadgeId),
        ]),
        bob,
        true,
    );

    // wait for the worker to sync to the bockchain
    await blockBarrier(api, prpc);

    // basic checks
    console.log('Fat Contract: basic checks');
    const opt = { value: 0, gasLimit: -1 };
    console.assert(
        (await FatBadges.query.getTotalBadges(certAlice, opt)).output.toNumber() == 2,
        'Should have two badges created'
    );

    const easyInfo = await FatBadges.query.getBadgeInfo(certAlice, opt, easyBadgeId)
    console.log('Easy badge:', easyInfo.output.toHuman());

    const advInfo = await FatBadges.query.getBadgeInfo(certAlice, opt, advBadgeId)
    console.log('Adv badge:', advInfo.output.toHuman());

    // create an attestation
    const attest = await EasyOracle.query.attest(
        certAlice, opt,
        'https://gist.githubusercontent.com/h4x3rotab/4b6bb4aa8dc9956af9c976a906daaa2a/raw/80da37a6e9e91b9e3929ba284c826631644f7d1a/test'
    );
    console.log(
        'Easy attestation:',
        attest.result.isOk ? attest.output.toHuman() : attest.result.toHuman()
    );
    console.log(EasyOracle.registry.createType('GistQuote', attest.output.asOk.data.toHex()).toHuman());
    const attestObj = attest.output.asOk;

    // submit attestation
    await txqueue.submit(
        EasyOracle.tx.redeem({}, attestObj),
        alice,
        true,
    );
    await blockBarrier(api, prpc);

    const aliceBadge = await FatBadges.query.get(certAlice, opt, easyBadgeId);
    console.log('Alice won:', aliceBadge.output.toHuman());

    // now we can use:
    // contract.query.xxxYyy(cert, {}, ...args)
    // contract.tx.xxxYyy({}, ...args).signAndSend(alice)
}

main().then(process.exit).catch(err => console.error('Crashed', err)).finally(() => process.exit(-1));