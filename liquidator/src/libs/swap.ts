/* eslint-disable prefer-promise-reject-errors */
import { Jupiter } from '@jup-ag/core';
import {
    Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction,
} from '@solana/web3.js';
import JSBI from 'jsbi';
import { sendLiquidationWarn } from './tg';
import { getRecentPrioritizationFee } from './utils';

const SLIPPAGE = 20;
const SWAP_TIMEOUT_SEC = 40;
const PRIORITY_RATE = 200000;

export async function swap(connection: Connection, wallet: Keypair, jupiter: Jupiter, fromTokenInfo, toTokenInfo, amount: number) {
    console.log({
        fromToken: fromTokenInfo.symbol,
        toToken: toTokenInfo.symbol,
        amount: amount.toString(),
    }, 'swapping tokens');

    const inputMint = new PublicKey(fromTokenInfo.mintAddress);
    const outputMint = new PublicKey(toTokenInfo.mintAddress);
    const routes = await jupiter.computeRoutes({
        inputMint, // Mint address of the input token
        outputMint, // Mint address of the output token
        amount: JSBI.BigInt(amount), // raw input amount of tokens
        slippageBps: SLIPPAGE, // The slippage in % terms
    });

    // Prepare execute exchange
    const { execute } = await jupiter.exchange({
        routeInfo: routes.routesInfos[0],
        computeUnitPriceMicroLamports:PRIORITY_RATE
    });

    // Execute swap
    await new Promise((resolve, reject) => {
        // sometime jup hangs hence the timeout here.
        let timedOut = false;
        const timeoutHandle = setTimeout(() => {
            timedOut = true;
            console.error(`Swap took longer than ${SWAP_TIMEOUT_SEC} seconds to complete.`);
            reject('Swap timed out');
        }, SWAP_TIMEOUT_SEC * 1000);

        execute().then(async (swapResult: any) => {
            if (!timedOut) {
                clearTimeout(timeoutHandle);
                await sendLiquidationWarn(
                    `successfully swapped token ${
                        JSON.stringify({
                            tx: swapResult.txid,
                            inputAddress: swapResult.inputAddress.toString(),
                            outputAddress: swapResult.outputAddress.toString(),
                            inputAmount: swapResult.inputAmount / fromTokenInfo.decimals,
                            outputAmount: swapResult.outputAmount / toTokenInfo.decimals,
                            inputToken: fromTokenInfo.symbol,
                            outputToken: toTokenInfo.symbol,
                        })
                    }`
                )
                resolve(swapResult);
            }
        }).catch((swapError) => {
            if (!timedOut) {
                clearTimeout(timeoutHandle);
                console.error({
                err: swapError.error,
                tx: swapError.txid,
                fromToken: fromTokenInfo.symbol,
                toToken: toTokenInfo.symbol,
                }, 'error swapping');
                resolve(swapError);
            }
        });
    });
}

export async function swapV6(connection: Connection, wallet: Keypair, fromTokenInfo, toTokenInfo, amount: number) {
    await sendLiquidationWarn(JSON.stringify({
        fromToken: fromTokenInfo.symbol,
        toToken: toTokenInfo.symbol,
        amount: amount.toString(),
    })+' swapping tokens');

    const quoteResponse = await (
        await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${fromTokenInfo.mintAddress}\&outputMint=${toTokenInfo.mintAddress}\&amount=${amount}\&slippageBps=200`)
    ).json();
    
    if(quoteResponse.error){await sendLiquidationWarn(`Couldn't Compute Route For Swap ${amount} ${fromTokenInfo.symbol} to ${toTokenInfo.symbol}`)};

    const { swapTransaction } = await (
        await fetch('https://quote-api.jup.ag/v6/swap', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                quoteResponse,
                userPublicKey: wallet.publicKey.toString(),
                wrapAndUnwrapSol: true,
                dynamicComputeUnitLimit: true, // allow dynamic compute limit instead of max 1,400,000
                prioritizationFeeLamports: 20000000 // or custom lamports: 20000000
            })
        })
    ).json();
    const blockhash = (await connection.getLatestBlockhash()).blockhash;
    //deserialize the transaction
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    // console.log(transaction);
    transaction.message.recentBlockhash = blockhash
    // sign the transactionsendLiquidation
    transaction.sign([wallet]);

    const simulation = await connection.simulateTransaction(transaction);

    if (simulation.value.err) {await sendLiquidationWarn('Simulation Returned Error' + JSON.stringify(simulation.value.err))}
    // Execute the transaction
    const rawTransaction = transaction.serialize()
    const txid = await connection.sendRawTransaction(rawTransaction, {
        skipPreflight: false,
        maxRetries: 2
    });
    try {
        const conf = await connection.confirmTransaction(txid, 'finalized');
        await sendLiquidationWarn(`https://solscan.io/tx/${txid}`);
    }
    catch(e) {
        await sendLiquidationWarn(`Transaction Confirmation Expired, please review priority fees` + e)
    }
 }

 async function estimateSlippage(
    connection: Connection, 
    wallet: Keypair, 
    fromTokenInfo:any, 
    toTokenInfo:any, 
    amount: number, 
 ){
    let slippageBps = 10;
    let slippageFound = false
    while (!slippageFound) {
        
        const quoteResponse = await (
            await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${fromTokenInfo.mintAddress}\&outputMint=${toTokenInfo.mintAddress}\&amount=${amount}\&slippageBps=${slippageBps}`)
        ).json();
    
        const { swapTransaction } = await (
            await fetch('https://quote-api.jup.ag/v6/swap', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    quoteResponse,
                    userPublicKey: wallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true, // allow dynamic compute limit instead of max 1,400,000
                    prioritizationFeeLamports: {
                      autoMultiplier: 4,
                    },
                })
            })
        ).json();
    
        const blockhash = (await connection.getLatestBlockhash()).blockhash;
        //deserialize the transaction
        const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
        var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        // console.log(transaction);
        transaction.message.recentBlockhash = blockhash
        // sign the transaction
        transaction.sign([wallet]);
    
        const simulation = await connection.simulateTransaction(transaction);
    
        if (simulation.value.err) {
            console.error(simulation.value.err)
            slippageBps+=10;
        }
        else {
            slippageFound = true;     
        }
    }
    // add 20% as padding
    const paddedBps = Math.ceil(slippageBps + 10)
    return paddedBps;
 }



 export async function swapV6DynamicParam(
        connection: Connection, 
        wallet: Keypair, 
        fromTokenInfo:any, 
        toTokenInfo:any, 
        amount: number, 
    ) {

    await sendLiquidationWarn(JSON.stringify({
        fromToken: fromTokenInfo.symbol,
        toToken: toTokenInfo.symbol,
        amount: amount.toString(),
    })+' swapping tokens');

    // estimate slippage
    // const estBps = await estimateSlippage(connection, wallet, fromTokenInfo, toTokenInfo, amount);
    // console.log({estBps});

    const quoteResponse = await (
        // await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${fromTokenInfo.mintAddress}\&outputMint=${toTokenInfo.mintAddress}\&amount=${amount}\&slippageBps=${estBps}`)
        await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${fromTokenInfo.mintAddress}\&outputMint=${toTokenInfo.mintAddress}\&amount=${amount}\&autoSlippage=true&autoSlippageCollisionUsdValue=1000`)
    ).json();
    
    if(quoteResponse.error){await sendLiquidationWarn(`Couldn't Compute Route For Swap ${amount} ${fromTokenInfo.symbol} to ${toTokenInfo.symbol}`); return false};
    console.log(quoteResponse);
        
    let prioFee = await getRecentPrioritizationFee(connection)
    console.log(prioFee);
    
    const res = await (
        await fetch('https://quote-api.jup.ag/v6/swap', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                quoteResponse,
                userPublicKey: wallet.publicKey.toString(),
                dynamicComputeUnitLimit: true, // allow dynamic compute limit instead of max 1,400,000
                computeUnitPriceMicroLamports: prioFee*10**6
            })
        })
    ).json();
    console.log(res);
    const {swapTransaction} = res
     
    const blockhash = (await connection.getLatestBlockhash('finalized')).blockhash;
    //deserialize the transaction
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.message.recentBlockhash = blockhash;


    // sign the transaction
    transaction.sign([wallet]);

    const simulation = await connection.simulateTransaction(transaction);

    if (simulation.value.err) {
        await sendLiquidationWarn('Simulation Returned Error' + JSON.stringify(simulation.value.err))
        return false;
    }
    else{
        console.log('Simulation successful');
    }
    // Execute the transaction
    const rawTransaction = transaction.serialize()
    const txid = await connection.sendRawTransaction(rawTransaction, {
        skipPreflight: true,
    });
    try {
        const conf = await connection.confirmTransaction(txid, 'max');
        console.log(conf);
        try {
            await sendLiquidationWarn(`https://solscan.io/tx/${txid}`);
        }
        catch(e) {
            console.log('failed to send confirmation');
            return true;
        }
        return true
    }
    catch(e) {
        await sendLiquidationWarn(`Transaction Confirmation Expired, please review priority fees` + e);
        return false
    }
 }
