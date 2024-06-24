const { 
    sleep, 
    get_obligations, 
    sendRequest, 
    sendTgMessage 
} = require('./src/utils.js');
const { 
    action_logs, 
    tokens 
} = require('./src/constants.js');
const { parseObligation } = require('@solendprotocol/solend-sdk');
const { MongoClient } = require('mongodb');
const web3 = require('@solana/web3.js');
const dotenv = require('dotenv');
const WebSocket = require('ws');

/* ENV VARS */
dotenv.config({path:'./.env'});
const SOLANA_RPC_WSS = process.env.SOLANA_RPC_WSS;
const SOLANA_RPC= process.env.SOLANA_RPC;
const MONGO_URL = process.env.MONGO_URL;

// Create a WebSocket connection
// const ws = new WebSocket(SOLANA_RPC_WSS);

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
function initWebsocket () {
    const ws = new WebSocket(SOLANA_RPC_WSS);
    ws.onopen = onOpen(ws);
    ws.onmessage = onMessage;
    ws.onerror = onError;
    ws.onclose = onClose;
}


// Define WebSocket event handlers
async function onOpen(ws) {
    await test_mongo_connection();

    console.log('Initializing Obligations');

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
};

async function onMessage(event) {
    const data = event.data
    console.log(data);
    const messageStr = data.toString('utf8');
    try {
        const messageObj = JSON.parse(messageStr);
        const data = messageObj.params;
        if (data) {
            const signature = messageObj.params.result.value.signature;
            console.log(`Received: ${signature}`);
            let tx_info;
            if(signature){
                tx_info = await handle_signature(signature);
                if(tx_info.eventType.indexOf('liquidate') != -1){
                    await sendTgMessage(tx_info);
                } 
                else {
                    console.log(tx_info)
                }
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
};

async function onError(err) {
    await sendTgMessage(`WebSocket error: ${err}`);
};

async function onClose() {
    console.log('WebSocket is closed, please restart solend_logging');
    clearInterval(interval_ping);
    initWebsocket()
}; 
initWebsocket()
/* UTILS */

class TxInfo {
    constructor(
        signature, 
        block_time, 
        pda, 
        actions, 
        transfers,
        err,
        status
    ) {
        this.blockTime = block_time
        this.date = new Date(block_time*1000).toISOString();
        this.eventType = actions;
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
        let actions = [];
        let err = tx.meta.err;
        let transfers = {};
        
        const user = tx.transaction.message.staticAccountKeys[0].toString();
        const logs = tx.meta.logMessages;
        const staticAccounts = tx.transaction.message.staticAccountKeys;
        
        for(let log of logs) {
            if((Object.keys(action_logs)).indexOf(log) > -1){
                actions.push(action_logs[log]);
            };
        };

        if(actions.indexOf('create') > -1) {
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
        let obligation_addr = 'not in list'
        try {
            obligation_addr = programAccount.pubkey.toString();
        }
        catch(e) {
            console.log(e);
        }
        if(actions.length == 0) {
            await sendTgMessage(`Unhandled event occured: ${logs}`);
        } 

        return new TxInfo(
            signature, 
            tx.blockTime, 
            obligation_addr, 
            actions, 
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
        console.log('Updating Obligations');
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
    console.log('Obligations Updated');
    return;
};


async function test_mongo_connection () {
    try {
        await collection_logs.findOne({})
        console.log('Mongo DB Connected');
    }
    catch (e) {
        await sendTgMessage(`Unable to communicate with MongoDb server at ${MONGO_URL}. Exiting with code 1, err: ${e}`)
        process.exit(1)
    }
};