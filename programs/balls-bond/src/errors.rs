use anchor_lang::prelude::*;

#[error_code]
pub enum BallsError {
    #[msg("The provided account is not a valid pump.fun bonding curve for this mint")]
    InvalidPumpCurve,
    #[msg("Only the wallet that created this coin on pump.fun can post a bond for it")]
    NotCoinCreator,
    #[msg("This coin has already graduated from the pump.fun curve")]
    CoinGraduated,
    #[msg("Target market cap must be above the coin's current market cap")]
    TargetTooLow,
    #[msg("Collateral is below the minimum")]
    CollateralTooLow,
    #[msg("This bond is no longer active")]
    BondNotActive,
    #[msg("The bond's market-cap target has not been reached")]
    TargetNotReached,
    #[msg("The bond's target is reached - the founder can claim it, it cannot be burned")]
    TargetReached,
    #[msg("The bond's deadline has not passed yet")]
    NotExpired,
    #[msg("Only the wallet that posted this bond may do this")]
    NotFounder,
    #[msg("The buy on pump.fun returned no tokens")]
    NothingBought,
    #[msg("Slippage: pump.fun returned fewer tokens than allowed")]
    SlippageExceeded,
    #[msg("The stuck-bond grace period has not passed yet")]
    GraceNotElapsed,
    #[msg("A supplied pump.fun account does not match the expected address")]
    BadPumpAccount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Only the resolver wallet may trigger a burn")]
    NotResolver,
    #[msg("Only the program's upgrade authority may initialize the config")]
    NotUpgradeAuthority,
    #[msg("Address must not be the zero/default pubkey")]
    InvalidAddress,
}
