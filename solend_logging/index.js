const { 
    OBLIGATION_SIZE, 
    SOLEND_PRODUCTION_PROGRAM_ID, 
    parseObligation 
} = require('@solendprotocol/solend-sdk');
const { 
    MongoClient 
} = require('mongodb');
const web3 = require('@solana/web3.js');
const WebSocket = require('ws');

const action_logs =  {
    'create':'create',
    'liquidate':'liquidate',
    'Program log: Instruction: RedeemFees':'Redeem Fees',
    'Program log: Instruction: Withdraw Obligation Collateral and Redeem Reserve Collateral': "Withdraw",
    'Program log: Instruction: Deposit Reserve Liquidity and Obligation Collateral': "Deposit",
    'Program log: Instruction: Repay Obligation Liquidity': "Repay",
    'Program log: Instruction: Borrow Obligation Liquidity': "Borrow",
};

const tokens = {
    "J9BcrQfX4p9D1bvLzRNCbMDv8f44a9LFdeqNE4Yk2WMD":"ISC",
    "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4":"JLP",
    "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm":"INF",
    "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v":"JupSOL",
    "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN":"JUP"
};

const SOLANA_RPC= "https://mainnet.helius-rpc.com/?api-key=917c06ec-3dc6-4d3d-af9d-6e7d8c9d971d";
const SOLANA_RPC_WSS = "wss://mainnet.helius-rpc.com/?api-key=917c06ec-3dc6-4d3d-af9d-6e7d8c9d971d";
const LENDING_POOL = "HeVhqRY3i22om5a7WGYftAJ2NjJJ3Cg5jnmMCsfFhRG8";
const MONGO_URL = 'mongodb://localhost:27017';

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

const ping_interval = 3000; // ms
const conn = new web3.Connection(SOLANA_RPC, 'confirmed');
let obligations = undefined;
let interval_obligations = undefined;
let interval_ping = undefined;


/* WEBSOCKET */

// Define WebSocket event handlers
ws.on('open', async function open() {
    await test_mongo_connection();

    console.log('Initializing Obligations');

    try{
        await update_obligations();
    }
    catch(e) {
        console.error('Failed to update obligations');
        console.error(e);
    };
    
    interval_obligations = setInterval(async () => {
        await update_obligations();
    }, 900000);

    console.log('WebSocket is open');
    
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
            console.log('Received:', signature);
            let tx_info;
            if(signature){
                tx_info = await handle_signature(signature);
                console.log(tx_info);
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
        console.error('Failed to parse JSON:', e);
    };
});

ws.on('error', function error(err) {
    console.error('WebSocket error:', err);
});

ws.on('close', function close() {
    console.log('WebSocket is closed');
    clearInterval(interval_obligations);
    clearInterval(interval_ping);
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

const sleep = (delay) =>
    new Promise((resolve) => setTimeout(resolve, delay));

async function handle_signature (signature) {
    await sleep(1000);
    const tx = await conn.getTransaction(signature, {maxSupportedTransactionVersion:0});
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
        console.log(tx.meta.logMessages);
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
        console.log('Updating Obligations');
    };

    let raw_obligations;

    try{
        raw_obligations = await get_obligations();
    }
    catch(e) {
        console.error('Failed to update obligations');
        console.error(e);
    };

    const parsedObligations = raw_obligations.map(
        (account) => parseObligation(account.pubkey, account.account));
    obligations = parsedObligations;
    console.log('Obligations Updated');
    return;
};

const get_obligations = async () => {
    return await conn.getProgramAccounts(SOLEND_PRODUCTION_PROGRAM_ID, {
        commitment: conn.commitment,
        filters: [
        {
            memcmp: {
                offset: 10,
                bytes: LENDING_POOL,
            },
        },
        {
            dataSize: OBLIGATION_SIZE,
        }],
        encoding: 'base64',
    });
};

async function test_mongo_connection () {
    try {
        await collection.findOne({})
        console.log('Mongo DB Connected');
    }
    catch (e) {
        console.error(`Unable to communicate with MongoDb server at ${MONGO_URL}. Exiting with code 1`)
        process.exit(1)
    }
}

// Function to send a request to the WebSocket server
function sendRequest(ws) {
    const request = {
        jsonrpc: "2.0",
        id: 42069,
        method: "logsSubscribe",
        params: [
            {
                "mentions": [ LENDING_POOL ]
            },
            {
                "commitment": "finalized"
            }
        ]
    };
    ws.send(JSON.stringify(request));
};