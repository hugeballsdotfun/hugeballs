use anchor_lang::prelude::*;

#[event]
pub struct BondCreated {
    pub mint: Pubkey,
    pub founder: Pubkey,
    pub target_mcap: u64,
    pub collateral: u64,
    pub deadline: i64,
}

#[event]
pub struct BondClaimed {
    pub mint: Pubkey,
    pub founder: Pubkey,
    pub amount: u64,
}

#[event]
pub struct BondBurned {
    pub mint: Pubkey,
    pub founder: Pubkey,
    pub collateral: u64,
    pub tokens_burned: u64,
}

#[event]
pub struct BondRefunded {
    pub mint: Pubkey,
    pub founder: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ResolverChanged {
    pub old: Pubkey,
    pub new: Pubkey,
}

#[event]
pub struct KeeperChanged {
    pub old: Pubkey,
    pub new: Pubkey,
}
