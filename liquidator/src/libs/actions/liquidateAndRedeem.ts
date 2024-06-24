import {
  ASSOCIATED_TOKEN_PROGRAM_ID, Token, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  Keypair,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  getTokenInfoFromMarket,
} from 'libs/utils';
import { findWhere, map } from 'underscore';
import { refreshReserveInstruction } from 'models/instructions/refreshReserve';
import { LiquidateObligationAndRedeemReserveCollateral } from 'models/instructions/LiquidateObligationAndRedeemReserveCollateral';
import { refreshObligationInstruction } from 'models/instructions/refreshObligation';
import { MarketConfig, MarketConfigReserve } from 'global';
import { sendLiquidationError } from 'libs/tg';

export const liquidateAndRedeem = async (
  connection: Connection,
  payer: Keypair,
  liquidityAmount: number | string,
  repayTokenSymbol: string,
  withdrawTokenSymbol: string,
  lendingMarket: MarketConfig,
  obligation: any,
) => {
  const ixs: TransactionInstruction[] = [];

  const depositReserves = map(obligation.info.deposits, (deposit) => deposit.depositReserve);
  const borrowReserves = map(obligation.info.borrows, (borrow) => borrow.borrowReserve);
  const uniqReserveAddresses = [...new Set<String>(map(depositReserves.concat(borrowReserves), (reserve) => reserve.toString()))];
  
  uniqReserveAddresses.forEach((reserveAddress) => {
    const reserveInfo: MarketConfigReserve = findWhere(lendingMarket!.reserves, {
      address: reserveAddress,
    });
    
    const refreshReserveIx = refreshReserveInstruction(
      new PublicKey(reserveAddress),
      new PublicKey(reserveInfo.pythOracle),
      new PublicKey(reserveInfo.switchboardOracle),
    );
    ixs.push(refreshReserveIx);
  });

  const refreshObligationIx = refreshObligationInstruction(
    obligation.pubkey,
    depositReserves,
    borrowReserves,
  );
  ixs.push(refreshObligationIx);

  const repayTokenInfo = getTokenInfoFromMarket(lendingMarket, repayTokenSymbol);

  // get account that will be repaying the reserve liquidity
  const repayAccount = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    new PublicKey(repayTokenInfo.mintAddress),
    payer.publicKey,
  );

  const reserveSymbolToReserveMap = new Map<string, MarketConfigReserve>(
    lendingMarket.reserves.map((reserve) => [reserve.liquidityToken.symbol, reserve]),
  );

  const repayReserve: MarketConfigReserve | undefined = reserveSymbolToReserveMap.get(repayTokenSymbol);
  const withdrawReserve: MarketConfigReserve | undefined = reserveSymbolToReserveMap.get(withdrawTokenSymbol);
  const withdrawTokenInfo = getTokenInfoFromMarket(lendingMarket, withdrawTokenSymbol);

  if (!withdrawReserve || !repayReserve) {
    throw new Error('reserves are not identified');
  }

  const rewardedWithdrawalCollateralAccount = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    new PublicKey(withdrawReserve.collateralMintAddress),
    payer.publicKey,
  );
  const rewardedWithdrawalCollateralAccountInfo = await connection.getAccountInfo(
    rewardedWithdrawalCollateralAccount,
  );
  if (!rewardedWithdrawalCollateralAccountInfo) {
    const createUserCollateralAccountIx = Token.createAssociatedTokenAccountInstruction(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      new PublicKey(withdrawReserve.collateralMintAddress),
      rewardedWithdrawalCollateralAccount,
      payer.publicKey,
      payer.publicKey,
    );
    ixs.push(createUserCollateralAccountIx);
  }

  const rewardedWithdrawalLiquidityAccount = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    new PublicKey(withdrawTokenInfo.mintAddress),
    payer.publicKey,
  );
  const rewardedWithdrawalLiquidityAccountInfo = await connection.getAccountInfo(
    rewardedWithdrawalLiquidityAccount,
  );
  if (!rewardedWithdrawalLiquidityAccountInfo) {
    const createUserCollateralAccountIx = Token.createAssociatedTokenAccountInstruction(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      new PublicKey(withdrawTokenInfo.mintAddress),
      rewardedWithdrawalLiquidityAccount,
      payer.publicKey,
      payer.publicKey,
    );
    ixs.push(createUserCollateralAccountIx);
  }

  ixs.push(
    LiquidateObligationAndRedeemReserveCollateral(
      liquidityAmount,
      repayAccount,
      rewardedWithdrawalCollateralAccount,
      rewardedWithdrawalLiquidityAccount,
      new PublicKey(repayReserve.address),
      new PublicKey(repayReserve.liquidityAddress),
      new PublicKey(withdrawReserve.address),
      new PublicKey(withdrawReserve.collateralMintAddress),
      new PublicKey(withdrawReserve.collateralSupplyAddress),
      new PublicKey(withdrawReserve.liquidityAddress),
      new PublicKey(withdrawReserve.liquidityFeeReceiverAddress),
      obligation.pubkey,
      new PublicKey(lendingMarket.address),
      new PublicKey(lendingMarket.authorityAddress),
      payer.publicKey,
    ),
  );

  const tx = new Transaction().add(...ixs);
  
  const { blockhash } = await connection.getLatestBlockhash();

  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);

  const PRIORITY_RATE = 100;
  const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({ 
    microLamports: PRIORITY_RATE 
  });
  tx.add(addPriorityFee);
  
  const simulation = await connection.simulateTransaction(tx);
  if(simulation.value.err == null) {
      const txHash = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      await connection.confirmTransaction(txHash);
      return txHash
  }
  else {
    sendLiquidationError(`error liquidating ${obligation!.pubkey.toString()}: ` + simulation.value.err)
    return null
  }
};
