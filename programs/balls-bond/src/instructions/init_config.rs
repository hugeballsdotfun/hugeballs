use anchor_lang::prelude::*;

use crate::errors::BallsError;
use crate::events::ResolverChanged;
use crate::state::config::Config;

#[derive(Accounts)]
pub struct InitConfig<'info> {
    /// Must be the program's upgrade authority — otherwise anyone could
    /// front-run the deployer and install themselves as resolver.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(init, payer = authority, space = Config::SIZE, seeds = [Config::SEED], bump)]
    pub config: Account<'info, Config>,

    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, crate::program::BallsBond>,

    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ BallsError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitConfig>, resolver: Pubkey, keeper: Pubkey) -> Result<()> {
    require!(resolver != Pubkey::default() && keeper != Pubkey::default(), BallsError::InvalidAddress);
    let config = &mut ctx.accounts.config;
    config.resolver = resolver;
    config.keeper = keeper;
    config.bump = ctx.bumps.config;
    emit!(ResolverChanged { old: Pubkey::default(), new: resolver });
    Ok(())
}
