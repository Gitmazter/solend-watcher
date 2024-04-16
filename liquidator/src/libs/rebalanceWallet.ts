/* eslint-disable no-lonely-if */
/* eslint-disable no-continue */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-param-reassign */
import { findWhere } from 'underscore';
import BigNumber from 'bignumber.js';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { TokenCount } from 'global';
import {swap, swapV6, swapV6DynamicParam }from './swap';
import { sendLiquidationError } from './tg';

// Padding so we rebalance only when abs(target-actual)/target is greater than PADDING
const PADDING = Number(process.env.REBALANCE_PADDING) || 0.2;

export async function betterRebalance(connection:Connection, payer:Keypair, tokensOracle:any[], walletBalances:any[], target:any[]) {
    const baseSymbol = 'ISC'
    const padding:number = Number(process.env.REBALANCE_PADDING);
    const baseInfo = tokensOracle.find(e => e.symbol === baseSymbol);
    
    for(let i in walletBalances) {
        const balance = walletBalances[i];

        // ignore if base currency  
        if(balance.symbol !== baseSymbol) {
            const oracle = tokensOracle.find(e => e.symbol === balance.symbol);
            const tokenTarget = target.find(e => e.symbol === balance.symbol).target;
            const tokenBalance = balance.balance
            const upperBound:number = Number(tokenTarget)*Number(1+padding)
            const lowerBound:number = Number(tokenTarget)*Number(1-padding)

            // skip if balance is within target
            if(lowerBound <= tokenBalance && tokenBalance <= upperBound) {
                // console.log(`${balance.symbol} within bound`);
                continue;
            }

            // rebalance
            // console.log(`${balance.symbol} outside bound`);
            const decimals = oracle.decimals.toNumber();
            const diff = balance.balanceBase - tokenTarget*decimals;
            console.log({target:tokenTarget*decimals, balance:balance.balanceBase, diff});
            if (diff > 0) {
                // sell token for base
                let swapped = false;
                while (!swapped) {
                    swapped = await swapV6DynamicParam(connection, payer, oracle, baseInfo, Math.floor(diff));
                }
            }
            else {
                // sell base for token
                const usdVal = -(diff/decimals * oracle.price.toNumber());
                const amount =  Math.floor((usdVal / baseInfo.price.toNumber())*baseInfo.decimals.toNumber()); 
                let swapped = false;
                while (!swapped) {
                    swapped = await swapV6DynamicParam(connection, payer, baseInfo, oracle, amount);
                }
            }
        }
    }
}



export async function rebalanceWallet(connection, payer, tokensOracle, walletBalances, target) {
  const info = await aggregateInfo(tokensOracle, walletBalances, connection, payer, target);
  // calculate token diff between current & target value
  
  info.forEach((tokenInfo) => {
    tokenInfo.diff = tokenInfo.balance - tokenInfo.target;
    tokenInfo.diffUSD = tokenInfo.diff * tokenInfo.price;
  });

  // Sort in decreasing order so we sell first then buy
  info.sort((a, b) => b.diffUSD - a.diffUSD);

//   console.log(info);
//   console.log(findWhere(info, {symbol:'ISC'}));

  for (const tokenInfo of info) {
    // skip usdc since it is our base currency
    if (tokenInfo.symbol === 'ISC') {
      continue;
    }

    // skip if exchange amount is too little
    if (Math.abs(tokenInfo.diff) <= PADDING * tokenInfo.target) {
      continue;
    }

    let fromTokenInfo;
    let toTokenInfo;
    let amount;
    const ISCTokenInfo = findWhere(info, { symbol:'ISC' });
    if (!ISCTokenInfo) {
      console.error('failed to find ISC token info');
    }

    // negative diff means we need to buy
    if (tokenInfo.diff < 0) {
      fromTokenInfo = ISCTokenInfo;
      toTokenInfo = tokenInfo;
      amount = (new BigNumber(tokenInfo.diffUSD).multipliedBy(fromTokenInfo.decimals)).abs();

      // positive diff means we sell
    } else {
      fromTokenInfo = tokenInfo;
      toTokenInfo = ISCTokenInfo;
      amount = new BigNumber(tokenInfo.diff).multipliedBy(fromTokenInfo.decimals);
    }

    try {
      await swapV6(connection, payer, fromTokenInfo, toTokenInfo, Math.floor(amount.toNumber()));
    } catch (error) {
      console.log(error);
      sendLiquidationError({error} + 'failed to swap tokens')
    }
  }
}

function aggregateInfo(tokensOracle, walletBalances, connection, wallet, target) {
  const info: any = [];
  target.forEach(async (tokenDistribution: TokenCount) => {
    const { symbol, target: tokenTarget } = tokenDistribution;
    const tokenOracle = findWhere(tokensOracle, { symbol });
    const walletBalance = findWhere(walletBalances, { symbol });

    if (walletBalance) {
      // -1 as sentinel value for account not available
      if (walletBalance.balance === -1) {
        const token = new Token(
          connection,
          new PublicKey(tokenOracle.mintAddress),
          TOKEN_PROGRAM_ID,
          wallet,
        );

        // create missing ATA for token
        const ata = await token.createAssociatedTokenAccount(wallet.publicKey);
        walletBalance.ata = ata.toString();
        walletBalance.balance = 0;
      }

      const usdValue = new BigNumber(walletBalance.balance).multipliedBy(tokenOracle.price);
      info.push({
        symbol,
        target: tokenTarget,
        mintAddress: tokenOracle.mintAddress,
        ata: walletBalance.ata?.toString(),
        balance: walletBalance.balance,
        usdValue: usdValue.toNumber(),
        price: tokenOracle.price.toNumber(),
        decimals: tokenOracle.decimals,
        reserveAddress: tokenOracle.reserveAddress,
      });
    }
  });

  return info;
}
