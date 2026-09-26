//! Read-only view of pump.fun's on-chain bonding curve, plus the constants
//! needed to CPI its `buy_exact_sol_in`. Nothing here trusts the caller: the
//! curve account is only accepted if it is owned by the pump.fun program AND
//! sits at the exact PDA derived from the mint.
//!
//! Layout source: pump.fun's public IDL (pump-fun/pump-public-docs). The
//! fields this program reads are the stable prefix of `BondingCurve`;
//! pump.fun has only ever appended fields after it.

use anchor_lang::prelude::*;

use crate::errors::BallsError;

pub const PUMP_PROGRAM_ID: Pubkey = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
pub const CURVE_SEED: &[u8] = b"bonding-curve";
pub const CURVE_DISCRIMINATOR: [u8; 8] = [23, 183, 248, 55, 96, 216, 172, 96];
/// Anchor discriminator of pump.fun's `buy_exact_sol_in`.
pub const BUY_EXACT_SOL_IN_DISCRIMINATOR: [u8; 8] = [56, 252, 116, 8, 158, 223, 205, 95];

// Byte offsets into the account data (8-byte discriminator first).
const VIRTUAL_TOKEN_RESERVES: usize = 8;
const VIRTUAL_SOL_RESERVES: usize = 16;
const TOKEN_TOTAL_SUPPLY: usize = 40;
const COMPLETE: usize = 48;
const CREATOR: usize = 49;
const MIN_LEN: usize = CREATOR + 32;

pub struct PumpCurve {
    pub virtual_token_reserves: u64,
    pub virtual_sol_reserves: u64,
    pub token_total_supply: u64,
    /// True once the coin has graduated off the curve (its liquidity moved
    /// to an AMM pool) — the curve is frozen from then on.
    pub complete: bool,
    pub creator: Pubkey,
}

impl PumpCurve {
    /// Market cap in lamports: spot price (virtual SOL / virtual tokens)
    /// times total supply. u128 so the product can't overflow.
    pub fn market_cap(&self) -> Option<u128> {
        (self.virtual_sol_reserves as u128)
            .checked_mul(self.token_total_supply as u128)?
            .checked_div(self.virtual_token_reserves as u128)
    }

    /// The bond's "target reached" test: a graduated coin always counts (it
    /// necessarily passed every mcap a curve can reach).
    pub fn reached(&self, target_mcap: u64) -> bool {
        self.complete || self.market_cap().map_or(false, |m| m >= target_mcap as u128)
    }
}

pub fn curve_address(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[CURVE_SEED, mint.as_ref()], &PUMP_PROGRAM_ID).0
}

pub fn read_curve(mint: &Pubkey, info: &AccountInfo) -> Result<PumpCurve> {
    require_keys_eq!(*info.owner, PUMP_PROGRAM_ID, BallsError::InvalidPumpCurve);
    require_keys_eq!(info.key(), curve_address(mint), BallsError::InvalidPumpCurve);
    let data = info.try_borrow_data()?;
    require!(data.len() >= MIN_LEN, BallsError::InvalidPumpCurve);
    require!(data[..8] == CURVE_DISCRIMINATOR, BallsError::InvalidPumpCurve);

    let u64_at = |o: usize| u64::from_le_bytes(data[o..o + 8].try_into().unwrap());
    Ok(PumpCurve {
        virtual_token_reserves: u64_at(VIRTUAL_TOKEN_RESERVES),
        virtual_sol_reserves: u64_at(VIRTUAL_SOL_RESERVES),
        token_total_supply: u64_at(TOKEN_TOTAL_SUPPLY),
        complete: data[COMPLETE] != 0,
        creator: Pubkey::new_from_array(data[CREATOR..CREATOR + 32].try_into().unwrap()),
    })
}
