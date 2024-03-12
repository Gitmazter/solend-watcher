/* eslint-disable no-continue */
/* eslint-disable no-restricted-syntax */
import {
  Connection,
} from '@solana/web3.js';
import dotenv from 'dotenv';
import {
  getObligations, getReserves, getWalletDistTarget, toHuman,  wait,
} from 'libs/utils';
import { getTokensOracleData } from 'libs/pyth';
import { calculateRefreshedObligation } from 'libs/refreshObligation';
import { ObligationCollateral, parseObligation } from '@solendprotocol/solend-sdk';
import { getMarkets } from './config';
import { findWhere } from 'underscore';
import { BN } from 'bn.js';
import BigNumber from 'bignumber.js';
dotenv.config();
// group
// const CHAT_ID = -4183196144
// Andzie
const CHAT_ID = process.env.CHAT_ID
const BOT_USERNAME = process.env.BOT_USERNAME
const BOT_TOKEN = process.env.BOT_TOKEN

async function sendLiquidationWarn(message:string) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=${CHAT_ID}&text=${encodeURIComponent(message)}`;
    await fetch(url);
}

// list to track which position has received a near liquidation warning
let notifiedPositions:string[] = [];


async function runLiquidator() {
  await sendLiquidationWarn(`Hello There`);
  const rpcEndpoint = process.env.RPC_ENDPOINT;
  if (!rpcEndpoint) {
    throw new Error('Pls provide an private RPC endpoint in docker-compose.yaml');
  }
  const markets = await getMarkets();
  const connection = new Connection(rpcEndpoint, 'confirmed');

  const target = getWalletDistTarget();

/*   wallet: ${payer.publicKey.toBase58()} */
  console.log(`
    app: ${process.env.APP}
    rpc: ${rpcEndpoint}
    auto-rebalancing: ${target.length > 0 ? 'ON' : 'OFF'}
    rebalancingDistribution: ${process.env.TARGETS}
    
    Running against ${markets.length} pools
  `);

  for (let epoch = 0; ; epoch += 1) {
    for (const market of markets) {
      const tokensOracle = await getTokensOracleData(connection, market);
      const allObligations = await getObligations(connection, market.address);
      const allReserves = await getReserves(connection, market.address);

      console.clear()
      for (let obligation of allObligations) {
        try {
          while (obligation) {
            const {
              borrowedValue,
              unhealthyBorrowValue,
              utilizationRatio,
            } = calculateRefreshedObligation(
              obligation.info,
              allReserves,
              tokensOracle,
            );
            
            const index = notifiedPositions.indexOf(obligation.pubkey.toString())
            if (borrowedValue.div(unhealthyBorrowValue).toNumber() < Number(process.env.NOTIFICATION_BREAKPOINT) && index > -1) {
                // Send all clear msg
                await sendLiquidationWarn(`Obligation ${obligation.pubkey.toString()} is no longer near its liquidation level`)
                // remove from notifiedPositions
                notifiedPositions.splice(index, 1);
            }

            if (borrowedValue.div(unhealthyBorrowValue).toNumber() >= Number(process.env.NOTIFICATION_BREAKPOINT)) {
                
                let deposit_value = 0;
                let depositString = 'Deposits: '
                obligation.info.deposits.forEach((deposit: ObligationCollateral)  => {
                    const { price, decimals, symbol } = findWhere(tokensOracle, { reserveAddress: deposit.depositReserve.toString() });
                    deposit_value += (deposit.depositedAmount.toNumber()*price.toString())/decimals;
                    obligation?.info.owner
                    depositString += `${symbol}: ${deposit.depositedAmount.toNumber()/decimals}`
                });
                
                
                // if (deposit_value > Number(process.env.MIN_DEPOSIT_VAL)) {
                    let borrowString = ''
                    let borrowTotal = new BigNumber(0);

                    obligation.info.borrows.forEach((borrow) => {

                        const reserve = findWhere(tokensOracle, { reserveAddress: borrow.borrowReserve.toString()});
                        const {price, decimals, symbol} = reserve
                        // const borrow_amount = new BigNumber(borrow.borrowedAmountWads.toString())
                        // .shiftedBy(-18 - decimals)
                        // .times(new BigNumber(borrow.cumulativeBorrowRateWads.toString()).shiftedBy(-18))
                        // .dividedBy(
                        //   new BigNumber(borrow.cumulativeBorrowRateWads.toString()).shiftedBy(-18)
                        // );
                        
                        
                        
                        
                        // console.log({borrow_amount});
                        
                        // borrowString += `${symbol}: ${borrow_amount.toString()}`
                    })
    
                    console.log({borrowString});
                    if (index === -1) {
                        await sendLiquidationWarn(
`Obligation\n${obligation.pubkey.toString()} is near its liquidation level
                  
Owner: ${obligation.info.owner}
${depositString}

borrowed/LiquidationLevel: ${Number(borrowedValue.div(unhealthyBorrowValue).toFixed(6))*100}
borrowed/deposited: ${utilizationRatio}
depositedValue: ${deposit_value} USD
borrowedValue: ${deposit_value*(utilizationRatio/100)} USD
market name: ${market.name} Pool
market address: ${market.address}
`);

                        notifiedPositions.push(obligation.pubkey.toString());
                    }

                    console.log(`Obligation ${obligation.pubkey.toString()} is near its liquidation level
                    borrowed/LiquidationLevel: ${Number(borrowedValue.div(unhealthyBorrowValue).toFixed(6))*100}
                    depositedValue: ${deposit_value}
                    borrowedValue: ${borrowedValue.toFixed(6)}
                    borrowed/deposited: ${utilizationRatio}
                    market address: ${market.address}`);
                // }
            }

            // Do nothing if obligation is healthy
            if (borrowedValue.isLessThanOrEqualTo(unhealthyBorrowValue)) {
                break;
            }

            console.log(`Obligation ${obligation.pubkey.toString()} is underwater
                        borrowedValue: ${borrowedValue.toFixed(6)}
                        unhealthyBorrowValue: ${unhealthyBorrowValue.toFixed(6)}
                        market address: ${market.address}`);

          }
        } catch (err) {
          console.error(`error liquidating ${obligation!.pubkey.toString()}: `, err);
          continue;
        }
      }

      // Throttle to avoid rate limiter
      if (process.env.THROTTLE) {
        await wait(Number(process.env.THROTTLE));
      }
    }
  }
}

runLiquidator();
