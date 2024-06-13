const { SOLEND_PRODUCTION_PROGRAM_ID, OBLIGATION_SIZE } = require("@solendprotocol/solend-sdk");
const { configDotenv } = require("dotenv");
configDotenv();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const LENDING_POOL =process.env.LENDING_POOL;

const sleep = (delay) =>
    new Promise((resolve) => setTimeout(resolve, delay));

const get_obligations = async (connection) => {
    return await connection.getProgramAccounts(SOLEND_PRODUCTION_PROGRAM_ID, {
        commitment: connection.commitment,
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

async function sendTgMessage(message) {
    console.log(message);
    if(typeof(message) == 'object') {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=${CHAT_ID}&text=${encodeURIComponent(formatted_message)}`;
        await fetch(url);
    }
    else {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=${CHAT_ID}&text=${encodeURIComponent(message)}`;
        await fetch(url);
    }
}

module.exports = {sleep, get_obligations, sendRequest, sendTgMessage}
