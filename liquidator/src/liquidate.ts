/* eslint-disable no-continue */
/* eslint-disable no-restricted-syntax */
import {
  Account,
  Connection,
  Keypair,
  PublicKey,
} from '@solana/web3.js';
import dotenv from 'dotenv';
import {
  getObligations, getReserves, getWalletBalances, getWalletDistTarget, getWalletTokenData, sortBorrows, wait,
} from 'libs/utils';
import { getTokensOracleData } from 'libs/pyth';
import { Borrow, calculateRefreshedObligation } from 'libs/refreshObligation';
import { readSecret } from 'libs/secret';
import { liquidateAndRedeem } from 'libs/actions/liquidateAndRedeem';
import { rebalanceWallet } from 'libs/rebalanceWallet';
import { unwrapTokens } from 'libs/unwrap/unwrapToken';
import { parseObligation } from '@solendprotocol/solend-sdk';
import { getMarkets } from './config';
import axios, { Axios } from 'axios';
import { Jupiter } from '@jup-ag/core';

const CHAT_ID = process.env.CHAT_ID
const BOT_TOKEN = process.env.BOT_TOKEN
const NOTIX_BP = Number(process.env.NOTIFICATION_BREAKPOINT)
const ANTI_SPAM = Number(process.env.ANTI_SPAM_SPREAD)

async function sendLiquidationWarn(message:string) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=${CHAT_ID}&text=${encodeURIComponent(message)}`;
    await axios.get(url);
}

// list to track which position has received a near liquidation warning
let notifiedPositions:string[] = [];

dotenv.config();

async function runLiquidator() {
  const rpcEndpoint = process.env.RPC_ENDPOINT;
  if (!rpcEndpoint) {
    throw new Error('Pls provide an private RPC endpoint in docker-compose.yaml');
  }
  const markets = await getMarkets();
  const connection = new Connection(rpcEndpoint, 'confirmed');
  // liquidator's keypair.
  
  const payer = Keypair.fromSeed(Uint8Array.from(JSON.parse(readSecret('keypair')).slice(0,32)));
  console.log(payer.publicKey);
  
  const jupiter = await Jupiter.load({
    connection,
    cluster: 'mainnet-beta',
    user: payer,
    wrapUnwrapSOL: false,
  });

  const target = getWalletDistTarget();
  const introStr = `
  app: ${process.env.APP}
  rpc: ${rpcEndpoint}
  wallet: ${payer.publicKey.toBase58()}
  auto-rebalancing: ${target.length > 0 ? 'ON' : 'OFF'}
  rebalancingDistribution: ${process.env.TARGETS}
  
  Running against ${markets.length} pools
  `
  console.log(introStr);
  await sendLiquidationWarn(introStr)

  for (let epoch = 0; ; epoch += 1) {
    for (const market of markets) {
      const tokensOracle = await getTokensOracleData(connection, market);
      const allObligations = await getObligations(connection, market.address);
      const allReserves = await getReserves(connection, market.address);


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
            // Send all clear msg for a position that is no longer unhealthy and has passed the anti spam spread
            // To avoid updated each time the Breakpoint is crossed in case a Position hovers at the BP
            const borrowHealthRatio =borrowedValue.div(unhealthyBorrowValue).toNumber()
            if (borrowHealthRatio < NOTIX_BP-ANTI_SPAM && index > -1) {
                // Send all clear msg
                await sendLiquidationWarn(`Obligation ${obligation.pubkey.toString()} is no longer near its liquidation level`)
                console.log(`Obligation ${obligation.pubkey.toString()} is no longer near its liquidation level`)
                // remove from notifiedPositions
                notifiedPositions.splice(index, 1);
            }

            if (borrowHealthRatio > NOTIX_BP && index == -1 && borrowedValue.isLessThan(unhealthyBorrowValue)) {
                // Position is no0t at liquidation but has passed notification BP
                await sendLiquidationWarn(`Obligation ${obligation.pubkey.toString()} is at ${borrowedValue.div(unhealthyBorrowValue).toNumber()*100}% of its liquidation level`)
                console.log(`Obligation ${obligation.pubkey.toString()} is at ${borrowedValue.div(unhealthyBorrowValue).toNumber()*100}% of its liquidation level`)
                // Send message and add to notified pos
                notifiedPositions.push(obligation.pubkey.toString())
            }   

            // Do nothing if obligation is healthy
            if (borrowedValue.isLessThanOrEqualTo(unhealthyBorrowValue)) {
              break;
            }

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
            market address: ${market.address}`
            console.log(underwaterStr);
            await sendLiquidationWarn(underwaterStr);

            // get wallet balance for selected borrow token
            const { balanceBase } = await getWalletTokenData(connection, market, payer, selectedBorrow.mintAddress, selectedBorrow.symbol);
            console.log(balanceBase);
            
            if (balanceBase === 0) {
              console.log(`insufficient ${selectedBorrow.symbol} to liquidate obligation ${obligation.pubkey.toString()} in market: ${market.address}`);
              await sendLiquidationWarn(`insufficient ${selectedBorrow.symbol} to liquidate obligation ${obligation.pubkey.toString()} in market: ${market.address}`);
              break;
            } else if (balanceBase < 0) {
              console.log(`failed to get wallet balance for ${selectedBorrow.symbol} to liquidate obligation ${obligation.pubkey.toString()} in market: ${market.address}. 
                Potentially network error or token account does not exist in wallet`);
              await sendLiquidationWarn(`failed to get wallet balance for ${selectedBorrow.symbol} to liquidate obligation ${obligation.pubkey.toString()} in market: ${market.address}. 
                Potentially network error or token account does not exist in wallet`);
              break;
            }

            // Set super high liquidation amount which acts as u64::MAX as program will only liquidate max
            // 50% val of all borrowed assets.
            const res = await liquidateAndRedeem(
              connection,
              payer,
              balanceBase,
              selectedBorrow.symbol,
              selectedDeposit.symbol,
              market,
              obligation,
            );

            

            const postLiquidationObligation = await connection.getAccountInfo(
              new PublicKey(obligation.pubkey),
            );
            obligation = parseObligation(obligation.pubkey, postLiquidationObligation!);
            console.log(`obligation successfully liquidated`);
            await sendLiquidationWarn(`obligation successfully liquidated ${res.toString()}`);
          }
        } catch (err) {
          console.error(`error liquidating ${obligation!.pubkey.toString()}: `, err);
          continue;
        }
      }

      await unwrapTokens(connection, payer);

      if (target.length > 0) {
        const walletBalances = await getWalletBalances(connection, payer, tokensOracle, market);
        console.log(walletBalances);
        // await sendLiquidationWarn(JSON.stringify(walletBalances))
        console.log(target);
            
        await rebalanceWallet(connection, payer, jupiter, tokensOracle, walletBalances, target);
      }

      // Throttle to avoid rate limiter
      if (process.env.THROTTLE) {
        await wait(Number(process.env.THROTTLE));
      }
    }
  }
}

runLiquidator();
