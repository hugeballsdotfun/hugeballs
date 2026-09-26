use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod pump;
pub mod state;

// `pub use` all the way to the crate root: Anchor's #[program] macro
// generates crate-root-relative paths for each Accounts struct's sibling
// `__client_accounts_*` module (see solana-foundation/anchor#3690).
pub use instructions::*;

declare_id!("3VQsTJGWQ1L4t312R527475JKUuSjsbSjbQoKbFqKoQS");

/// How long a bond stays open before an unmet one can be burned.
#[cfg(not(feature = "devnet-short-deadline"))]
pub const BOND_DURATION_SECS: i64 = 48 * 60 * 60;
#[cfg(feature = "devnet-short-deadline")]
pub const BOND_DURATION_SECS: i64 = 60;

/// If an expired, unmet bond still hasn't been resolved this long after its
/// deadline, the founder may reclaim it. Exists only as an escape hatch for
/// the case where pump.fun changes its `buy` interface and the burn CPI
/// stops working — see `refund_stuck`.
#[cfg(not(feature = "devnet-short-deadline"))]
pub const STUCK_GRACE_SECS: i64 = 7 * 24 * 60 * 60;
#[cfg(feature = "devnet-short-deadline")]
pub const STUCK_GRACE_SECS: i64 = 120;

/// Smallest collateral accepted (0.01 SOL) — keeps the burn's pump.fun buy
/// comfortably above rent and dust thresholds.
pub const MIN_COLLATERAL_LAMPORTS: u64 = 10_000_000;

#[program]
pub mod balls_bond {
    use super::*;

    /// One-time setup by the program's upgrade authority: names the admin
    /// `resolver` wallet and the automated `keeper` wallet — the only two
    /// that may trigger burns of expired, unmet bonds.
    pub fn init_config(ctx: Context<InitConfig>, resolver: Pubkey, keeper: Pubkey) -> Result<()> {
        instructions::init_config::handler(ctx, resolver, keeper)
    }

    /// Resolver swaps the keeper's hot key.
    pub fn set_keeper(ctx: Context<SetKeeper>, new_keeper: Pubkey) -> Result<()> {
        instructions::set_resolver::set_keeper_handler(ctx, new_keeper)
    }

    /// Current resolver hands the admin role to another wallet.
    pub fn set_resolver(ctx: Context<SetResolver>, new_resolver: Pubkey) -> Result<()> {
        instructions::set_resolver::handler(ctx, new_resolver)
    }

    /// Founder-only. Locks `collateral` lamports against a market-cap
    /// `target_mcap` (lamports) for a coin the founder created on pump.fun.
    /// Rides in the same transaction as pump.fun's `create_v2`.
    pub fn create_bond(ctx: Context<CreateBond>, target_mcap: u64, collateral: u64) -> Result<()> {
        instructions::create_bond::handler(ctx, target_mcap, collateral)
    }

    /// Founder takes the collateral back once the coin's market cap has
    /// reached the target (or the coin graduated off the pump.fun curve).
    pub fn claim_bond(ctx: Context<ClaimBond>) -> Result<()> {
        instructions::claim_bond::handler(ctx)
    }

    /// Resolver- or keeper-only, after the deadline and only if the target is unmet:
    /// buys the coin on pump.fun with the collateral and burns every token
    /// bought.
    pub fn resolve_bond<'info>(
        ctx: Context<'_, '_, '_, 'info, ResolveBond<'info>>,
        min_tokens_out: u64,
    ) -> Result<()> {
        instructions::resolve_bond::handler(ctx, min_tokens_out)
    }

    /// Founder escape hatch: reclaim an expired, unmet bond that nobody
    /// managed to resolve for `STUCK_GRACE_SECS`.
    pub fn refund_stuck(ctx: Context<RefundStuck>) -> Result<()> {
        instructions::refund_stuck::handler(ctx)
    }
}
