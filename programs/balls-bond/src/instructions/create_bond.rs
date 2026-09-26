use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::errors::BallsError;
use crate::events::BondCreated;
use crate::pump::read_curve;
use crate::state::bond::{Bond, BondStatus};
use crate::{BOND_DURATION_SECS, MIN_COLLATERAL_LAMPORTS};

#[derive(Accounts)]
pub struct CreateBond<'info> {
    #[account(mut)]
    pub founder: Signer<'info>,

    /// The pump.fun coin's mint.
    /// CHECK: only used as a seed and to locate/verify the pump.fun curve.
    pub mint: UncheckedAccount<'info>,

    /// The coin's pump.fun bonding curve.
    /// CHECK: verified in the handler (owner, PDA address, layout).
    pub pump_curve: UncheckedAccount<'info>,

    #[account(
        init,
        payer = founder,
        space = Bond::SIZE,
        seeds = [Bond::SEED, mint.key().as_ref()],
        bump,
    )]
    pub bond: Account<'info, Bond>,

    #[account(mut, seeds = [Bond::VAULT_SEED, bond.key().as_ref()], bump)]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Locks `collateral` lamports against a market-cap `target_mcap` (lamports).
/// Only the wallet pump.fun recorded as the coin's creator may post one, so
/// a bond is always the launching dev's own stake. The bond can also only be
/// posted while the coin is still on the curve and below the target.
pub fn handler(ctx: Context<CreateBond>, target_mcap: u64, collateral: u64) -> Result<()> {
    require!(collateral >= MIN_COLLATERAL_LAMPORTS, BallsError::CollateralTooLow);

    let curve = read_curve(&ctx.accounts.mint.key(), &ctx.accounts.pump_curve.to_account_info())?;
    require_keys_eq!(curve.creator, ctx.accounts.founder.key(), BallsError::NotCoinCreator);
    require!(!curve.complete, BallsError::CoinGraduated);
    require!(!curve.reached(target_mcap), BallsError::TargetTooLow);

    transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.founder.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        collateral,
    )?;

    let deadline = Clock::get()?
        .unix_timestamp
        .checked_add(BOND_DURATION_SECS)
        .ok_or(BallsError::MathOverflow)?;

    let bond = &mut ctx.accounts.bond;
    bond.founder = ctx.accounts.founder.key();
    bond.mint = ctx.accounts.mint.key();
    bond.target_mcap = target_mcap;
    bond.collateral = collateral;
    bond.deadline = deadline;
    bond.status = BondStatus::Active;
    bond.bump = ctx.bumps.bond;
    bond.vault_bump = ctx.bumps.vault;

    emit!(BondCreated {
        mint: bond.mint,
        founder: bond.founder,
        target_mcap,
        collateral,
        deadline,
    });
    Ok(())
}
