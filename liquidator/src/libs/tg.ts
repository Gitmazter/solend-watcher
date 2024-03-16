import axios from "axios";
import dotenv from 'dotenv';
dotenv.config();

const CHAT_ID = process.env.CHAT_ID
const BOT_TOKEN = process.env.BOT_TOKEN

export async function sendLiquidationWarn(message:string) {
    console.log(message);
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=${CHAT_ID}&text=${encodeURIComponent(message)}`;
    await axios.get(url);
}

export async function sendLiquidationError(message:string) {
    console.error(message);
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=${CHAT_ID}&text=${encodeURIComponent(message)}`;
    await axios.get(url);
}


