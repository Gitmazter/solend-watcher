const { 
    OBLIGATION_SIZE, 
    SOLEND_PRODUCTION_PROGRAM_ID, 
    parseObligation 
} = require('@solendprotocol/solend-sdk');
const { 
    action_logs, 
    tokens 
} = require('./src/constants');
const { MongoClient } = require('mongodb');
const web3 = require('@solana/web3.js');
const dotenv = require('dotenv');
const WebSocket = require('ws');
const { sleep, get_obligations, sendRequest, sendTgMessage } = require('./src/utils');

/* ENV VARS */
dotenv.config({path:'./.env'});
const SOLANA_RPC_WSS = process.env.SOLANA_RPC_WSS;
const SOLANA_RPC= process.env.SOLANA_RPC;
const MONGO_URL = process.env.MONGO_URL;

// Create a WebSocket connection
const ws = new WebSocket(SOLANA_RPC_WSS);

// Create a Mongo Connection
const client = new MongoClient(MONGO_URL);

const collection_logs = client
    .db('isc')
    .collection('solend_logs');

const collection_unhandled = client
    .db('isc')
    .collection('solend_logs_unhandled');


/* GLOBALS */
const ping_interval = 3000; // ms
const connection= new web3.Connection(SOLANA_RPC, 'confirmed');
let obligations = undefined;
let interval_obligations = undefined;
let interval_ping = undefined;

/* WEBSOCKET */

// Define WebSocket event handlers
ws.on('open', async function open() {
    await test_mongo_connection();

    await sendTgMessage('Initializing Obligations');

    try{
        await update_obligations();
    }
    catch(e) {
        await sendTgMessage('Failed to update obligations');
        await sendTgMessage(e);
    };
    
    interval_obligations = setInterval(async () => {
        await update_obligations();
    }, 900000);

    await sendTgMessage('WebSocket is open');
    
    sendRequest(ws);  // Send a request once the WebSocket is open

    // Keep the connection alive
    interval_ping = setInterval(() => {
        ws.ping('1');
    }, ping_interval);
});

ws.on('message', async function incoming(data) {
    const messageStr = data.toString('utf8');
    try {
        const messageObj = JSON.parse(messageStr);
        const data = messageObj.params;
        if (data) {
            const signature = messageObj.params.result.value.signature;
            await sendTgMessage(`Received: ${signature}`);
            let tx_info;
            if(signature){
                tx_info = await handle_signature(signature);
                await sendTgMessage(tx_info);
            };
            // Handle info
            if(tx_info !== null){
                // Verify that signature hasn't been stored already
                if (await collection_logs.findOne({signature:signature}) === null) {
                    await collection_logs.insertOne(tx_info);
                };
            }
            else {
                await collection_unhandled.insertOne(signature);
            };
        };
    } catch (e) {
        sendTgMessage(`Failed to parse JSON: ${e}`);
    };
});

ws.on('error', async function error(err) {
    await sendTgMessage(`WebSocket error: ${err}`);
});

ws.on('close',async function close() {
    await sendTgMessage('WebSocket is closed, please restart solend_logging');
    clearInterval(interval_obligations);
    clearInterval(interval_ping);
    process.exit(2)
}); 

/* UTILS */

class TxInfo {
    constructor(
        signature, 
        block_time, 
        pda, 
        action, 
        transfers,
        err,
        status
    ) {
        this.blockTime = block_time
        this.date = new Date(block_time*1000).toISOString();
        this.eventType = action;
        this.transfers = transfers;
        this.account = pda ;
        this.status = status;
        this.error = err;
        this.txid = signature;
    };
};

async function handle_signature (signature) {
    await sleep(1000);
    const tx = await connection.getTransaction(signature, {maxSupportedTransactionVersion:0});
    if(tx){
        let programAccount = '';
        let action = 'unhandled';
        let err = tx.meta.err;
        let transfers = {};
        
        const user = tx.transaction.message.staticAccountKeys[0].toString();
        const logs = tx.meta.logMessages;
        const staticAccounts = tx.transaction.message.staticAccountKeys;
        
        for(let log of logs) {
            if((Object.keys(action_logs)).indexOf(log) > -1){
                action = action_logs[log];
            };
        };

        if(action == 'create') {
            await update_obligations();
        };
        
        for (let bal of tx.meta.preTokenBalances) {
            let amt = null;
            let mint = bal.mint.toString();
            if (bal.owner == user && tokens[mint] !== undefined) {
                const token = tokens[mint] ? tokens[mint] : mint;
                amt = bal.uiTokenAmount.uiAmount;
                if(amt == null) {amt = 0};
                transfers[token] = +amt;
            };
        };
        
        for (let bal of tx.meta.postTokenBalances) {
            let amt = null;
            let mint = bal.mint.toString();
            if (bal.owner == user && tokens[mint] !== undefined) {
                const token = tokens[mint] ? tokens[mint] : mint;
                amt = bal.uiTokenAmount.uiAmount;
                if(amt == null) {amt = 0};
                if (transfers[token]) {
                    transfers[token] -= amt;
                }
                else {
                    transfers[token] = -amt;
                };

                const decimals = bal.uiTokenAmount.decimals;
                transfers[token] = Number(transfers[token]).toFixed(decimals);
            };
        };
        
        obligations.map((account) => {
            for(let acc of staticAccounts) {
                if(acc.toString() == account.pubkey.toString()) {
                    programAccount = account;
                };
            };
        });

        const obligation_addr = programAccount.pubkey.toString()
        if(action == 'unhandled') {
            await sendTgMessage(`Unhandled event occured: ${logs}`);
        }
        return new TxInfo(
            signature, 
            tx.blockTime, 
            obligation_addr, 
            action, 
            transfers,
            err, 
            'finalized'
        );
    }
    else { 
        return null;
    };
};

async function update_obligations () {
    if(obligations) {
        await sendTgMessage('Updating Obligations');
    };

    let raw_obligations;

    try{
        raw_obligations = await get_obligations(connection);
    }
    catch(e) {
        await sendTgMessage('Failed to update obligations');
        await sendTgMessage(e);
    };

    const parsedObligations = raw_obligations.map(
        (account) => parseObligation(account.pubkey, account.account));
    obligations = parsedObligations;
    await sendTgMessage('Obligations Updated');
    return;
};


async function test_mongo_connection () {
    try {
        await collection_logs.findOne({})
        await sendTgMessage('Mongo DB Connected');
    }
    catch (e) {
        await sendTgMessage(`Unable to communicate with MongoDb server at ${MONGO_URL}. Exiting with code 1, err: ${e}`)
        process.exit(1)
    }
};