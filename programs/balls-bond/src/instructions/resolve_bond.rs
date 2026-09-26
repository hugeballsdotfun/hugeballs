use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_interface::{burn, Burn, Mint, TokenAccount, TokenInterface};

use crate::errors::BallsError;
use crate::events::BondBurned;
use crate::pump::{read_curve, BUY_EXACT_SOL_IN_DISCRIMINATOR, PUMP_PROGRAM_ID};
use crate::state::bond::{Bond, BondStatus};
use crate::state::config::Config;

/// Fee headroom assumed when estimating what a pump.fun buy should return —
/// deliberately above pump.fun's real total fee so the slippage floor below
/// never rejects an honest buy.
const ASSUMED_FEE_BPS: u128 = 300;
/// The buy must return at least this share (in bps) of the fee-adjusted
/// estimate. Bounds how much a sandwich around a resolve can extract.
const MIN_OUT_FLOOR_BPS: u128 = 9000;
/// Lamports held back from the buy — see the comment where it's used. Kept
/// well under `MIN_COLLATERAL_LAMPORTS`, so a bond always has something to buy with.
const BUY_RESERVE_LAMPORTS: u64 = 4_000_000;

#[derive(Accounts)]
pub struct ResolveBond<'info> {
    /// Only the resolver or keeper wallet named in Config may trigger a burn. It pays the tx
    /// fee (and the vault token account's rent if it doesn't exist yet) and
    /// cannot redirect any value — see the handler.
    #[account(mut)]
    pub resolver: Signer<'info>,

    #[account(
        seeds = [Config::SEED],
        bump = config.bump,
        constraint = config.resolver == resolver.key() || config.keeper == resolver.key() @ BallsError::NotResolver,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [Bond::SEED, bond.mint.as_ref()],
        bump = bond.bump,
    )]
    pub bond: Account<'info, Bond>,

    #[account(mut, seeds = [Bond::VAULT_SEED, bond.key().as_ref()], bump = bond.vault_bump)]
    pub vault: SystemAccount<'info>,

    /// Receives whatever lamports the buy leaves in the vault (rent dust).
    /// CHECK: pinned to bond.founder, only ever credited lamports.
    #[account(mut, address = bond.founder)]
    pub founder: UncheckedAccount<'info>,

    #[account(mut, address = bond.mint)]
    pub mint: InterfaceAccount<'info, Mint>,

    /// The vault's own token account for the coin — it receives the bought
    /// tokens and they are burned straight out of it. Must already exist
    /// (the client creates it in the same transaction).
    #[account(
        mut,
        token::mint = mint,
        token::authority = vault,
        token::token_program = token_program,
    )]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,

    // ---- pump.fun `buy_exact_sol_in` accounts. Pump validates its own; we
    // ---- pin the ones that decide where value goes (see handler).
    /// CHECK: the pump.fun program.
    #[account(address = PUMP_PROGRAM_ID)]
    pub pump_program: UncheckedAccount<'info>,
    /// CHECK: pump.fun `global` PDA; validated by pump.fun.
    pub pump_global: UncheckedAccount<'info>,
    /// CHECK: one of pump.fun's fee recipients; validated by pump.fun.
    #[account(mut)]
    pub pump_fee_recipient: UncheckedAccount<'info>,
    /// CHECK: verified in the handler (owner, PDA address, layout).
    #[account(mut)]
    pub pump_curve: UncheckedAccount<'info>,
    /// CHECK: the curve's token account; validated by pump.fun.
    #[account(mut)]
    pub pump_curve_token_account: UncheckedAccount<'info>,
    /// CHECK: pump.fun creator-fee vault; validated by pump.fun.
    #[account(mut)]
    pub pump_creator_vault: UncheckedAccount<'info>,
    /// CHECK: pump.fun event authority; validated by pump.fun.
    pub pump_event_authority: UncheckedAccount<'info>,
    /// CHECK: validated by pump.fun.
    pub pump_global_volume_accumulator: UncheckedAccount<'info>,
    /// CHECK: validated by pump.fun.
    #[account(mut)]
    pub pump_user_volume_accumulator: UncheckedAccount<'info>,
    /// CHECK: validated by pump.fun.
    pub pump_fee_config: UncheckedAccount<'info>,
    /// CHECK: pump.fun's fee program; validated by pump.fun.
    pub pump_fee_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// After the deadline, if the coin's market cap is still below target, spends
/// the whole collateral buying the coin on pump.fun (the vault PDA is the
/// buyer) and burns every token bought.
///
/// The value-routing accounts are pinned here rather than trusted from the
/// caller: the buyer is always the vault PDA, and the tokens can only land in
/// the vault's own associated token account, which this program then burns
/// from. The burn is of the account's whole balance, so nothing is left for
/// anyone to take.
///
/// Known limitation: a permissionless public buy can be sandwiched. The
/// slippage floor below bounds the loss to a few percent of the collateral.
pub fn handler<'info>(ctx: Context<'_, '_, '_, 'info, ResolveBond<'info>>, min_tokens_out: u64) -> Result<()> {
    let bond = &ctx.accounts.bond;
    require!(bond.status == BondStatus::Active, BallsError::BondNotActive);
    require!(Clock::get()?.unix_timestamp > bond.deadline, BallsError::NotExpired);

    let curve = read_curve(&bond.mint, &ctx.accounts.pump_curve.to_account_info())?;
    // A reached bond belongs to the founder (claim_bond) and can never be
    // burned; this also covers a graduated coin, which can't be bought on
    // the curve any more.
    require!(!curve.reached(bond.target_mcap), BallsError::TargetReached);

    // The bought tokens must land in the vault's own token account.
    // (`token::authority = vault` above already guarantees the account
    // passed as `vault_token_account` is owned by the vault; pump.fun is
    // handed exactly that account below.)
    let expected_ata = get_associated_token_address_with_program_id(
        &ctx.accounts.vault.key(),
        &ctx.accounts.mint.key(),
        &ctx.accounts.token_program.key(),
    );
    require_keys_eq!(ctx.accounts.vault_token_account.key(), expected_ata, BallsError::BadPumpAccount);

    // Spend the collateral minus a reserve. The reserve covers what pump.fun
    // charges the buyer ON TOP of the spend (found on devnet: its buy debits
    // the user for more than `spendable_sol_in` — e.g. rent for a first-time
    // buyer's volume-accumulator account — and fails outright if the vault
    // can't cover it). Whatever the buy leaves of the reserve is swept back
    // to the founder at the end.
    let spend = ctx
        .accounts
        .vault
        .lamports()
        .checked_sub(BUY_RESERVE_LAMPORTS)
        .ok_or(BallsError::MathOverflow)?;

    // Estimated tokens from the pre-buy reserves (constant product), net of
    // an assumed fee, then floored: the buy must return at least
    // MIN_OUT_FLOOR_BPS of that.
    let vs = curve.virtual_sol_reserves as u128;
    let vt = curve.virtual_token_reserves as u128;
    let net = (spend as u128) * (10_000 - ASSUMED_FEE_BPS) / 10_000;
    let new_vs = vs.checked_add(net).ok_or(BallsError::MathOverflow)?;
    let new_vt = vs
        .checked_mul(vt)
        .ok_or(BallsError::MathOverflow)?
        .checked_div(new_vs)
        .ok_or(BallsError::MathOverflow)?;
    let estimate = vt.saturating_sub(new_vt);
    let floor = u64::try_from(estimate * MIN_OUT_FLOOR_BPS / 10_000).map_err(|_| BallsError::MathOverflow)?;
    let effective_min = min_tokens_out.max(floor);

    // ---- CPI: pump.fun buy_exact_sol_in, signed by the vault PDA ----
    let mut data = Vec::with_capacity(8 + 8 + 8 + 1);
    data.extend_from_slice(&BUY_EXACT_SOL_IN_DISCRIMINATOR);
    data.extend_from_slice(&spend.to_le_bytes());
    data.extend_from_slice(&effective_min.to_le_bytes());
    data.push(0); // track_volume: OptionBool(false)

    let vault_key = ctx.accounts.vault.key();
    let a = &ctx.accounts;
    let metas = vec![
        AccountMeta::new_readonly(a.pump_global.key(), false),
        AccountMeta::new(a.pump_fee_recipient.key(), false),
        AccountMeta::new_readonly(a.mint.key(), false),
        AccountMeta::new(a.pump_curve.key(), false),
        AccountMeta::new(a.pump_curve_token_account.key(), false),
        AccountMeta::new(a.vault_token_account.key(), false),
        AccountMeta::new(vault_key, true),
        AccountMeta::new_readonly(a.system_program.key(), false),
        AccountMeta::new_readonly(a.token_program.key(), false),
        AccountMeta::new(a.pump_creator_vault.key(), false),
        AccountMeta::new_readonly(a.pump_event_authority.key(), false),
        AccountMeta::new_readonly(PUMP_PROGRAM_ID, false),
        AccountMeta::new_readonly(a.pump_global_volume_accumulator.key(), false),
        AccountMeta::new(a.pump_user_volume_accumulator.key(), false),
        AccountMeta::new_readonly(a.pump_fee_config.key(), false),
        AccountMeta::new_readonly(a.pump_fee_program.key(), false),
    ];
    let infos = vec![
        a.pump_global.to_account_info(),
        a.pump_fee_recipient.to_account_info(),
        a.mint.to_account_info(),
        a.pump_curve.to_account_info(),
        a.pump_curve_token_account.to_account_info(),
        a.vault_token_account.to_account_info(),
        a.vault.to_account_info(),
        a.system_program.to_account_info(),
        a.token_program.to_account_info(),
        a.pump_creator_vault.to_account_info(),
        a.pump_event_authority.to_account_info(),
        a.pump_program.to_account_info(),
        a.pump_global_volume_accumulator.to_account_info(),
        a.pump_user_volume_accumulator.to_account_info(),
        a.pump_fee_config.to_account_info(),
        a.pump_fee_program.to_account_info(),
    ];
    // pump.fun's buy also reads a couple of trailing accounts that its public
    // IDL doesn't list (currently the curve-v2 PDA and a buyback fee
    // recipient). Forward whatever the caller appended, verbatim and never as
    // signers, so a pump.fun change to those doesn't need a program upgrade.
    // pump.fun validates them itself; extras can't redirect value because
    // pump.fun only pays out to accounts it derives/validates on its own.
    let mut metas = metas;
    let mut infos = infos;
    for extra in ctx.remaining_accounts.iter() {
        metas.push(if extra.is_writable {
            AccountMeta::new(extra.key(), false)
        } else {
            AccountMeta::new_readonly(extra.key(), false)
        });
        infos.push(extra.clone());
    }
    let bond_key = ctx.accounts.bond.key();
    let vault_seeds: &[&[u8]] = &[Bond::VAULT_SEED, bond_key.as_ref(), &[ctx.accounts.bond.vault_bump]];
    invoke_signed(
        &Instruction { program_id: PUMP_PROGRAM_ID, accounts: metas, data },
        &infos,
        &[vault_seeds],
    )?;

    // ---- burn every token the buy delivered ----
    ctx.accounts.vault_token_account.reload()?;
    let bought = ctx.accounts.vault_token_account.amount;
    require!(bought > 0, BallsError::NothingBought);
    require!(bought >= effective_min, BallsError::SlippageExceeded);
    burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.mint.to_account_info(),
                from: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[vault_seeds],
        ),
        bought,
    )?;

    // ---- sweep leftover lamports (rent dust) back to the founder ----
    let leftover = ctx.accounts.vault.lamports();
    if leftover > 0 {
        transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.founder.to_account_info(),
                },
                &[vault_seeds],
            ),
            leftover,
        )?;
    }

    let bond = &mut ctx.accounts.bond;
    bond.status = BondStatus::Burned;
    emit!(BondBurned {
        mint: bond.mint,
        founder: bond.founder,
        collateral: bond.collateral,
        tokens_burned: bought,
    });
    Ok(())
}
