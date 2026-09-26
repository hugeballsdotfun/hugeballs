use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::errors::BallsError;
use crate::events::BondClaimed;
use crate::pump::read_curve;
use crate::state::bond::{Bond, BondStatus};

#[derive(Accounts)]
pub struct ClaimBond<'info> {
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

    /// CHECK: verified in the handler (owner, PDA address, layout).
    pub pump_curve: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Founder takes the collateral back once the pump.fun curve's market cap is
/// at/above the target (a graduated coin always counts). Judged live from
/// the curve account; while the bond is Active and the target is met the
/// founder can claim — the deadline only decides when an UNMET bond becomes
/// burnable.
pub fn handler(ctx: Context<ClaimBond>) -> Result<()> {
    require!(ctx.accounts.bond.status == BondStatus::Active, BallsError::BondNotActive);

    let curve = read_curve(&ctx.accounts.bond.mint, &ctx.accounts.pump_curve.to_account_info())?;
    require!(curve.reached(ctx.accounts.bond.target_mcap), BallsError::TargetNotReached);

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

    ctx.accounts.bond.status = BondStatus::Claimed;
    emit!(BondClaimed {
        mint: ctx.accounts.bond.mint,
        founder: ctx.accounts.founder.key(),
        amount,
    });
    Ok(())
}
