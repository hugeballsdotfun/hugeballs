use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::errors::BallsError;
use crate::events::BondRefunded;
use crate::state::bond::{Bond, BondStatus};
use crate::STUCK_GRACE_SECS;

#[derive(Accounts)]
pub struct RefundStuck<'info> {
    #[account(mut)]
    pub founder: Signer<'info>,

    #[account(
        mut,
        seeds = [Bond::SEED, bond.mint.as_ref()],
        bump = bond.bump,
        constraint = bond.founder == founder.key() @ BallsError::NotFounder,
    )]
    pub bond: Account<'info, Bond>,

    #[account(mut, seeds = [Bond::VAULT_SEED, bond.key().as_ref()], bump = bond.vault_bump)]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Escape hatch for a bond that expired unmet but that nobody could resolve
/// (e.g. pump.fun changed its `buy` interface and the burn CPI broke). Only
/// after a long grace period past the deadline does the founder get the
/// collateral back — long enough that the program can be upgraded to fix the
/// CPI first, and that skipping the burn isn't a viable strategy.
pub fn handler(ctx: Context<RefundStuck>) -> Result<()> {
    require!(ctx.accounts.bond.status == BondStatus::Active, BallsError::BondNotActive);
    let unlock_at = ctx
        .accounts
        .bond
        .deadline
        .checked_add(STUCK_GRACE_SECS)
        .ok_or(BallsError::MathOverflow)?;
    require!(Clock::get()?.unix_timestamp > unlock_at, BallsError::GraceNotElapsed);

    let amount = ctx.accounts.vault.lamports();
    let bond_key = ctx.accounts.bond.key();
    let seeds: &[&[u8]] = &[Bond::VAULT_SEED, bond_key.as_ref(), &[ctx.accounts.bond.vault_bump]];
    transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.founder.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;

    ctx.accounts.bond.status = BondStatus::Refunded;
    emit!(BondRefunded {
        mint: ctx.accounts.bond.mint,
        founder: ctx.accounts.founder.key(),
        amount,
    });
    Ok(())
}
