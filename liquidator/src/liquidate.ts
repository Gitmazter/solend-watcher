/* eslint-disable no-continue */
/* eslint-disable no-restricted-syntax */

import {
  Connection,
  Keypair,
  PublicKey,
} from '@solana/web3.js';

import dotenv from 'dotenv';

import {
    getObligations, 
    getReserves, getWalletBalancesForMarkets, getWalletDistTarget, getWalletTokenData, sortBorrows, wait,
} from './libs/utils';
import { Borrow, calculateRefreshedObligation } from './libs/refreshObligation';
import { liquidateAndRedeem } from './libs/actions/liquidateAndRedeem';
import { sendLiquidationError, sendLiquidationWarn } from './libs/tg';
import { ObligationCollateral, parseObligation  } from '@solendprotocol/solend-sdk';
import { betterRebalance } from './libs/rebalanceWallet';
import { unwrapTokens } from './libs/unwrap/unwrapToken';
import { getTokensOracleData } from './libs/pyth';
import { readSecret } from './libs/secret';
import { getMarkets } from './config';
import BigNumber from 'bignumber.js';
import { findWhere } from 'underscore';

dotenv.config();
const NOTIX_BP = Number(process.env.NOTIFICATION_BREAKPOINT);
const ANTI_SPAM = Number(process.env.ANTI_SPAM_SPREAD);

// list to track which position has received a near liquidation warning
let notifiedPositions:string[] = [];

async function runLiquidator() {
    const rpcEndpoint = process.env.RPC_ENDPOINT;
    if (!rpcEndpoint) {
        throw new Error('Pls provide a private RPC endpoint in docker-compose.yaml');
    }
    const markets = await getMarkets();
    const connection = new Connection(rpcEndpoint, 'confirmed');
     
    // liquidator's keypair.
    const payer = Keypair.fromSeed(Uint8Array.from(JSON.parse(readSecret('keypair')).slice(0,32)));

    const target = getWalletDistTarget();
    const introStr = `
    app: ${process.env.APP}
    rpc: ${rpcEndpoint}
    wallet: ${payer.publicKey.toBase58()}
    auto-rebalancing: ${target.length > 0 ? 'ON' : 'OFF'}
    rebalancingDistribution: ${process.env.TARGETS}
    
    Running against ${markets.length} pools
    `

    await sendLiquidationWarn(introStr)

    // rebalance once at start if needed
    if(target.length > 0) {
        let allOracles:any = [];
        for (const market of markets) {
            try {
                let tokensOracle = await getTokensOracleData(connection, market);
                allOracles = [...allOracles, ...tokensOracle];
            }
            catch(e) {
                await sendLiquidationError('Failed to load oracle data. Reason: ' + e)
            } 
        }
        try {
            const walletBalances = await getWalletBalancesForMarkets(connection, payer, allOracles, markets);                
            await betterRebalance(connection, payer, allOracles, walletBalances, target);
        }
        catch (e) {
            console.log(e);   
        }
    }


    for (let epoch = 0; ; epoch += 1) {
        let allOracles:any = [];
        for (const market of markets) {
            try {
                let tokensOracle = await getTokensOracleData(connection, market);
                allOracles = [...allOracles, ...tokensOracle];
            }
            catch(e) {
                await sendLiquidationError('Failed to load oracle data. Reason: ' + e)
            } 
        };

        for (const market of markets) {
            let tokensOracle:any[] = []
            let allObligations, allReserves;
            if(!allObligations){
                try {
                    allObligations = await getObligations(connection, market.address);
                }
                catch(e) {
                    await sendLiquidationError('Failed to load Obligation data. Reason: ' + e);
                    continue;
                } 
            }
            if(!allReserves){
                try {
                    allReserves = await getReserves(connection, market.address);
                }
                catch(e) {
                    await sendLiquidationError('Failed to load Reserve data. Reason: ' + e);
                    continue;
                } 
            }
            try {
                tokensOracle = await getTokensOracleData(connection, market);
            }
            catch(e) {
                await sendLiquidationError('Failed to load oracles. Reason: ' + e);
                continue;
            } 
            
            for (let obligation of allObligations) {
                try {
                    while (obligation) {
                        const {
                            borrowedValue,
                            unhealthyBorrowValue,
                            deposits,
                            borrows,
                        } = calculateRefreshedObligation(
                            obligation.info,
                            allReserves,
                            tokensOracle,
                        );      
                        
                        const index = notifiedPositions.indexOf(obligation.pubkey.toString())

                        const borrowHealthRatio =borrowedValue.div(unhealthyBorrowValue).toNumber()
                        if (borrowHealthRatio < NOTIX_BP-ANTI_SPAM && index > -1) {
                            await sendLiquidationWarn(`Obligation ${obligation.pubkey.toString()} is no longer near its liquidation level`)
                            notifiedPositions.splice(index, 1);
                        }

                        if (borrowHealthRatio > NOTIX_BP && index == -1 && borrowedValue.isLessThan(unhealthyBorrowValue)) {
                            await sendLiquidationWarn(`Obligation ${obligation.pubkey.toString()} is at ${borrowedValue.div(unhealthyBorrowValue).toNumber()*100}% of its liquidation level`)
                            notifiedPositions.push(obligation.pubkey.toString())
                        }   

                        let borrow_value = 0;
                        
                        let borrowString = 'Deposits: ';

                        let deposit_value = 0;
                        let depositString = 'Deposits: '
                        obligation.info.deposits.forEach((deposit: ObligationCollateral)  => {
                            const { price, decimals, symbol } = findWhere(tokensOracle, { reserveAddress: deposit.depositReserve.toString() });
                            deposit_value += (deposit.depositedAmount.toNumber()*price.toString())/decimals;
                            obligation?.info.owner
                            depositString += `${symbol}: ${deposit.depositedAmount.toNumber()/decimals}`
                        });
                        if(deposit_value < 0.01) {
                            break;
                        }
                        
                        
                        
                        // Do nothing if obligation is healthy
                        if (borrowedValue.isLessThanOrEqualTo(unhealthyBorrowValue)) {
                            break;
                        }
                        console.log(depositString);

                        // select repay token that has the highest market value
                        const selectedBorrow: Borrow | undefined = sortBorrows(borrows)[0];

                        // select the withdrawal collateral token with the highest market value
                        let selectedDeposit;
                        deposits.forEach((deposit) => {
                            if (!selectedDeposit || deposit.marketValue.gt(selectedDeposit.marketValue)) {
                                selectedDeposit = deposit;
                            };
                        });
                        

                        if (!selectedBorrow || !selectedDeposit) {
                            // skip toxic obligations caused by toxic oracle data
                            break;
                        }
                        const underwaterStr = `Obligation ${obligation.pubkey.toString()} is underwater
                        borrowedValue: ${borrowedValue.toString()}
                        unhealthyBorrowValue: ${unhealthyBorrowValue.toString()}
                        market address: ${market.address}`;
                        await sendLiquidationWarn(underwaterStr);

                        // get wallet balance for selected borrow token
                        const { balanceBase } = await getWalletTokenData(connection, market, payer, selectedBorrow.mintAddress, selectedBorrow.symbol);

                        // // get max amount to liquidate
                        // const MAX_LIQ = "50% of borrow base value"
                        // // swap into amount if wallet doesn't have enough
                        // if(MAX_LIQ < "50%") {
                        //     // swap 
                        // }

                        if (balanceBase) {
                            // await sendLiquidationWarn(`insufficient ${selectedBorrow.symbol} to liquidate obligation ${obligation.pubkey.toString()} in market: ${market.address}`);
                            // break;
                        } else if (balanceBase < 0) {
                            await sendLiquidationWarn(`failed to get wallet balance for ${selectedBorrow.symbol} to liquidate obligation ${obligation.pubkey.toString()} in market: ${market.address}. 
                                Potentially network error or token account does not exist in wallet`);
                            break;
                        };

                        // Set super high liquidation amount which acts as u64::MAX as program will only liquidate max
                        // 50% val of all borrowed assets.
                        // swap into amt
                        const res = await liquidateAndRedeem(
                            connection,
                            payer,
                            balanceBase,
                            selectedBorrow.symbol,
                            selectedDeposit.symbol,
                            market,
                            obligation,
                        );
                        

                        if(res == null) {
                            continue;
                        }
                        // swap back to base token
                            
                        const postLiquidationObligation = await connection.getAccountInfo(
                            new PublicKey(obligation.pubkey),
                        );
                        
                        obligation = parseObligation(obligation.pubkey, postLiquidationObligation!);
                        await sendLiquidationWarn(`obligation successfully liquidated ${res.toString()}`);
                        await unwrapTokens(connection, payer);

                        // Rebalancing
                        if(target.length > 0) {
                            try {
                                const walletBalances = await getWalletBalancesForMarkets(connection, payer, allOracles, markets);                
                                await betterRebalance(connection, payer, allOracles, walletBalances, target);
                            }
                            catch (e) {
                                console.log(e);   
                            };
                        };
                    };
                } 
                catch (err) {
                    await sendLiquidationError(`error liquidating ${obligation!.pubkey.toString()}: ` + err);
                    continue;
                };
            };
            // Throttle
            if (process.env.THROTTLE) {await wait(Number(process.env.THROTTLE));};
        };
    };
};

runLiquidator();
