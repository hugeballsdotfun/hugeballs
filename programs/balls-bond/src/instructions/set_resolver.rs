use anchor_lang::prelude::*;

use crate::errors::BallsError;
use crate::events::{KeeperChanged, ResolverChanged};
use crate::state::config::Config;

#[derive(Accounts)]
pub struct SetResolver<'info> {
    pub resolver: Signer<'info>,

    #[account(
        mut,
        seeds = [Config::SEED],
        bump = config.bump,
        constraint = config.resolver == resolver.key() @ BallsError::NotResolver,
    )]
    pub config: Account<'info, Config>,
}

/// The current resolver hands the role to another wallet (e.g. rotating to a
/// safer key). Takes effect immediately.
pub fn handler(ctx: Context<SetResolver>, new_resolver: Pubkey) -> Result<()> {
    require!(new_resolver != Pubkey::default(), BallsError::InvalidAddress);
    let old = ctx.accounts.config.resolver;
    ctx.accounts.config.resolver = new_resolver;
    emit!(ResolverChanged { old, new: new_resolver });
    Ok(())
}

#[derive(Accounts)]
pub struct SetKeeper<'info> {
    pub resolver: Signer<'info>,

    #[account(
        mut,
        seeds = [Config::SEED],
        bump = config.bump,
        constraint = config.resolver == resolver.key() @ BallsError::NotResolver,
    )]
    pub config: Account<'info, Config>,
}

/// The resolver swaps the keeper's hot key (e.g. after rotating a server).
pub fn set_keeper_handler(ctx: Context<SetKeeper>, new_keeper: Pubkey) -> Result<()> {
    require!(new_keeper != Pubkey::default(), BallsError::InvalidAddress);
    let old = ctx.accounts.config.keeper;
    ctx.accounts.config.keeper = new_keeper;
    emit!(KeeperChanged { old, new: new_keeper });
    Ok(())
}
