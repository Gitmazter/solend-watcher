const action_logs =  {
    'Program log: Create':'create account',
    'Program log: Instruction: Liquidate Obligation and Redeem Reserve Collateral':'liquidate position',
    'Program log: Instruction: RedeemFees':'redeem fees',
    'Program log: Instruction: Withdraw Obligation Collateral and Redeem Reserve Collateral': "withdraw",
    'Program log: Instruction: Deposit Reserve Liquidity and Obligation Collateral': "deposit",
    'Program log: Instruction: Repay Obligation Liquidity': "repay",
    'Program log: Instruction: Borrow Obligation Liquidity': "borrow",
};

const error_logs = {
    'Program log: Switchboard oracle price is stale':'stale oracle'
}

const tokens = {
    "J9BcrQfX4p9D1bvLzRNCbMDv8f44a9LFdeqNE4Yk2WMD":"ISC",
    "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4":"JLP",
    "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm":"INF",
    "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v":"JupSOL",
    "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN":"JUP"
};


module.exports = {action_logs, tokens};