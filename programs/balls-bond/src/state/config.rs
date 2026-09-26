use anchor_lang::prelude::*;

/// Global settings. PDA seeds = [Config::SEED].
#[account]
pub struct Config {
    /// The admin wallet: may trigger `resolve_bond` and rotate resolver/keeper.
    /// It can NOT touch
    /// collateral: a resolve can only move a bond's collateral into
    /// pump.fun to buy-and-burn the coin. What this authority controls is
    /// only *whether/when* an expired, unmet bond gets burned — if it never
    /// acts, founders can reclaim after `STUCK_GRACE_SECS` (`refund_stuck`).
    pub resolver: Pubkey,
    /// A second wallet allowed ONLY to trigger `resolve_bond`, meant for the
    /// hot key of an automated keeper. It cannot change any setting, and a
    /// resolve can never move collateral anywhere but into the burn — so a
    /// leaked keeper key can only trigger burns that are due anyway.
    pub keeper: Pubkey,
    pub bump: u8,
}

impl Config {
    pub const SEED: &'static [u8] = b"config";
    pub const SIZE: usize = 8 + 32 + 32 + 1;
}
