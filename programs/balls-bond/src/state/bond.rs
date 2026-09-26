use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BondStatus {
    /// Collateral is locked in the bond's vault.
    Active,
    /// Target reached; the founder took the collateral back.
    Claimed,
    /// Deadline passed unmet; the collateral bought the coin on pump.fun and
    /// the tokens were burned.
    Burned,
    /// Unresolved past the grace period; the founder reclaimed it.
    Refunded,
}

/// A founder's bond on a pump.fun coin. PDA seeds = [Bond::SEED, mint]; the
/// collateral itself sits in a separate system-owned PDA,
/// [Bond::VAULT_SEED, bond], so it can act as the `user` of a pump.fun buy.
///
/// Target and collateral are lamports: pump.fun curves are SOL-quoted, and
/// market cap is read straight from the pump.fun curve account, never from
/// any oracle or off-chain input.
#[account]
pub struct Bond {
    pub founder: Pubkey,
    pub mint: Pubkey,
    pub target_mcap: u64,
    pub collateral: u64,
    pub deadline: i64,
    pub status: BondStatus,
    pub bump: u8,
    pub vault_bump: u8,
}

impl Bond {
    pub const SEED: &'static [u8] = b"bond";
    pub const VAULT_SEED: &'static [u8] = b"vault";
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 8 + 8 + 1 + 1 + 1;
}
