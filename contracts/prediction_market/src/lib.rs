#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, vec,
    Address, Env, IntoVal, String, Symbol, Val, Vec,
};

// ── Constants ─────────────────────────────────────────────────────────────────

/// 1 XLM expressed in stroops (7 decimals).
const ONE_XLM: i128 = 10_000_000;

/// Total fee in basis points (2%).
const TOTAL_FEE_BPS: i128 = 200;
/// Platform portion in basis points (1.5%).
const PLATFORM_FEE_BPS: i128 = 150;
/// Basis-point denominator.
const BPS_DENOM: i128 = 10_000;

/// Points awarded on claim.
const WIN_POINTS: u64 = 30;
const LOSE_POINTS: u64 = 10;
/// IPREDICT tokens awarded on claim (7 decimals).
const WIN_TOKENS: i128 = 10_0000000;
const LOSE_TOKENS: i128 = 2_0000000;

// ── Errors ────────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum MarketError {
    AlreadyInitialized    = 1,
    NotInitialized        = 2,
    NotAdmin              = 3,
    MarketNotFound        = 4,
    MarketExpired         = 5,
    MarketNotExpired      = 6,
    MarketResolved        = 7,
    MarketCancelled       = 8,
    MarketNotResolved     = 9,
    BetTooSmall           = 10,
    OppositeSideBet       = 11,
    AlreadyClaimed        = 12,
    NoBetFound            = 13,
    InvalidAmount         = 14,
    NoFeesToWithdraw      = 15,
}

// ── Storage Keys ──────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    MarketCount,
    Market(u64),
    Bet(u64, Address),
    BettorCount(u64),
    BettorAt(u64, u32),
    TokenContract,
    ReferralContract,
    LeaderboardContract,
    AccumulatedFees,
    XlmSacContract,
}

// ── Domain Structs ────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Market {
    pub id: u64,
    pub question: String,
    pub image_url: String,
    pub end_time: u64,
    pub total_yes: i128,
    pub total_no: i128,
    pub resolved: bool,
    pub outcome: bool,
    pub cancelled: bool,
    pub creator: Address,
    pub bet_count: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Bet {
    pub amount: i128,
    pub is_yes: bool,
    pub claimed: bool,
}

/// Returned by `get_odds`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Odds {
    pub yes_percent: u32,
    pub no_percent: u32,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct PredictionMarketContract;

#[contractimpl]
impl PredictionMarketContract {
    // ── Lifecycle ─────────────────────────────────────────────────────────

    pub fn initialize(
        env: Env,
        admin: Address,
        token_contract: Address,
        referral_contract: Address,
        leaderboard_contract: Address,
        xlm_sac: Address,
    ) -> Result<(), MarketError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(MarketError::AlreadyInitialized);
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::TokenContract, &token_contract);
        env.storage()
            .instance()
            .set(&DataKey::ReferralContract, &referral_contract);
        env.storage()
            .instance()
            .set(&DataKey::LeaderboardContract, &leaderboard_contract);
        env.storage()
            .instance()
            .set(&DataKey::XlmSacContract, &xlm_sac);
        env.storage()
            .instance()
            .set(&DataKey::MarketCount, &0_u64);
        env.storage()
            .instance()
            .set(&DataKey::AccumulatedFees, &0_i128);

        env.events()
            .publish((symbol_short!("init"), symbol_short!("market")), admin);

        Ok(())
    }

    // ── Market Management (admin) ─────────────────────────────────────────

    pub fn create_market(
        env: Env,
        admin: Address,
        question: String,
        image_url: String,
        duration_secs: u64,
    ) -> Result<u64, MarketError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::MarketCount)
            .unwrap_or(0);
        let market_id = count + 1;

        let end_time = env.ledger().timestamp() + duration_secs;

        let market = Market {
            id: market_id,
            question: question.clone(),
            image_url,
            end_time,
            total_yes: 0,
            total_no: 0,
            resolved: false,
            outcome: false,
            cancelled: false,
            creator: admin.clone(),
            bet_count: 0,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Market(market_id), &market);
        env.storage()
            .persistent()
            .set(&DataKey::BettorCount(market_id), &0_u32);
        env.storage()
            .instance()
            .set(&DataKey::MarketCount, &market_id);

        env.events().publish(
            (symbol_short!("mkt"), symbol_short!("created")),
            (market_id, question, end_time),
        );

        Ok(market_id)
    }

    // ── Betting ───────────────────────────────────────────────────────────

    pub fn place_bet(
        env: Env,
        user: Address,
        market_id: u64,
        is_yes: bool,
        amount: i128,
    ) -> Result<(), MarketError> {
        user.require_auth();

        // Validate amount
        if amount < ONE_XLM {
            return Err(MarketError::BetTooSmall);
        }

        // Load & validate market
        let mut market = Self::load_market(&env, market_id)?;
        if market.cancelled {
            return Err(MarketError::MarketCancelled);
        }
        if market.resolved {
            return Err(MarketError::MarketResolved);
        }
        if env.ledger().timestamp() >= market.end_time {
            return Err(MarketError::MarketExpired);
        }

        // Check existing bet — allow same-side increase, reject opposite
        let bet_key = DataKey::Bet(market_id, user.clone());
        let existing_bet: Option<Bet> = env.storage().persistent().get(&bet_key);
        let is_increase = existing_bet.is_some();

        if let Some(ref existing) = existing_bet {
            if existing.is_yes != is_yes {
                return Err(MarketError::OppositeSideBet);
            }
        }

        // ── Fee calculation ───────────────────────────────────────────────
        let total_fee = amount * TOTAL_FEE_BPS / BPS_DENOM;
        let platform_fee = amount * PLATFORM_FEE_BPS / BPS_DENOM;
        let referral_fee = total_fee - platform_fee;
        let net = amount - total_fee;

        // ── SAC transfer: full amount XLM user → this contract ────────────
        let xlm_sac: Address = env
            .storage()
            .instance()
            .get(&DataKey::XlmSacContract)
            .unwrap();
        let xlm = token::Client::new(&env, &xlm_sac);
        xlm.transfer(&user, &env.current_contract_address(), &amount);

        // ── Platform fee → AccumulatedFees ────────────────────────────────
        let mut acc_fees: i128 = env
            .storage()
            .instance()
            .get(&DataKey::AccumulatedFees)
            .unwrap_or(0);
        acc_fees += platform_fee;

        // ── Inter-contract: ReferralRegistry.credit() ─────────────────────
        let referral_contract: Address = env
            .storage()
            .instance()
            .get(&DataKey::ReferralContract)
            .unwrap();

        // Transfer referral_fee XLM to the referral contract so it can pay out
        if referral_fee > 0 {
            xlm.transfer(
                &env.current_contract_address(),
                &referral_contract,
                &referral_fee,
            );
        }

        // Call credit — returns bool
        let has_referrer: bool = env.invoke_contract(
            &referral_contract,
            &Symbol::new(&env, "credit"),
            vec![
                &env,
                env.current_contract_address().into_val(&env),
                user.clone().into_val(&env),
                referral_fee.into_val(&env),
            ],
        );

        if !has_referrer {
            // No referrer — the referral_fee we sent to the referral contract
            // was not forwarded to anyone. Add it to platform fee accounting.
            acc_fees += referral_fee;
        }

        env.storage()
            .instance()
            .set(&DataKey::AccumulatedFees, &acc_fees);

        // ── Store / update Bet ────────────────────────────────────────────
        let new_bet = if let Some(mut existing) = existing_bet {
            existing.amount += net;
            existing
        } else {
            Bet {
                amount: net,
                is_yes,
                claimed: false,
            }
        };
        env.storage().persistent().set(&bet_key, &new_bet);

        // ── Bettor index (only for new bettors) ──────────────────────────
        if !is_increase {
            let count: u32 = env
                .storage()
                .persistent()
                .get(&DataKey::BettorCount(market_id))
                .unwrap_or(0);
            env.storage()
                .persistent()
                .set(&DataKey::BettorAt(market_id, count), &user.clone());
            env.storage()
                .persistent()
                .set(&DataKey::BettorCount(market_id), &(count + 1));
            market.bet_count += 1;
        }

        // ── Update market totals with net ─────────────────────────────────
        if is_yes {
            market.total_yes += net;
        } else {
            market.total_no += net;
        }
        env.storage()
            .persistent()
            .set(&DataKey::Market(market_id), &market);

        // ── Inter-contract: Leaderboard.record_bet() ──────────────────────
        let leaderboard: Address = env
            .storage()
            .instance()
            .get(&DataKey::LeaderboardContract)
            .unwrap();
        let _: Val = env.invoke_contract(
            &leaderboard,
            &Symbol::new(&env, "record_bet"),
            vec![
                &env,
                env.current_contract_address().into_val(&env),
                user.clone().into_val(&env),
            ],
        );

        env.events().publish(
            (symbol_short!("bet"),),
            (market_id, user, is_yes, amount, net, total_fee, is_increase),
        );

        Ok(())
    }

    // ── Resolution ────────────────────────────────────────────────────────

    pub fn resolve_market(
        env: Env,
        admin: Address,
        market_id: u64,
        outcome: bool,
    ) -> Result<(), MarketError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();

        let mut market = Self::load_market(&env, market_id)?;
        if market.resolved {
            return Err(MarketError::MarketResolved);
        }
        if market.cancelled {
            return Err(MarketError::MarketCancelled);
        }
        if env.ledger().timestamp() < market.end_time {
            return Err(MarketError::MarketNotExpired);
        }

        market.resolved = true;
        market.outcome = outcome;
        env.storage()
            .persistent()
            .set(&DataKey::Market(market_id), &market);

        env.events().publish(
            (symbol_short!("mkt"), symbol_short!("resolved")),
            (market_id, outcome),
        );

        Ok(())
    }

    // ── Cancellation ──────────────────────────────────────────────────────

    pub fn cancel_market(
        env: Env,
        admin: Address,
        market_id: u64,
    ) -> Result<(), MarketError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();

        let mut market = Self::load_market(&env, market_id)?;
        if market.resolved {
            return Err(MarketError::MarketResolved);
        }
        if market.cancelled {
            return Err(MarketError::MarketCancelled);
        }

        market.cancelled = true;
        env.storage()
            .persistent()
            .set(&DataKey::Market(market_id), &market);

        // Refund each bettor's net amount
        let xlm_sac: Address = env
            .storage()
            .instance()
            .get(&DataKey::XlmSacContract)
            .unwrap();
        let xlm = token::Client::new(&env, &xlm_sac);
        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::BettorCount(market_id))
            .unwrap_or(0);

        let mut refunded: u32 = 0;
        for i in 0..count {
            let bettor: Address = env
                .storage()
                .persistent()
                .get(&DataKey::BettorAt(market_id, i))
                .unwrap();
            let bet: Bet = env
                .storage()
                .persistent()
                .get(&DataKey::Bet(market_id, bettor.clone()))
                .unwrap();

            if bet.amount > 0 {
                xlm.transfer(
                    &env.current_contract_address(),
                    &bettor,
                    &bet.amount,
                );
                refunded += 1;
            }
        }

        env.events().publish(
            (symbol_short!("mkt"), symbol_short!("cancel")),
            (market_id, refunded),
        );

        Ok(())
    }

    // ── Claim ─────────────────────────────────────────────────────────────

    pub fn claim(
        env: Env,
        user: Address,
        market_id: u64,
    ) -> Result<(), MarketError> {
        user.require_auth();

        let market = Self::load_market(&env, market_id)?;
        if market.cancelled {
            return Err(MarketError::MarketCancelled);
        }
        if !market.resolved {
            return Err(MarketError::MarketNotResolved);
        }

        let bet_key = DataKey::Bet(market_id, user.clone());
        let mut bet: Bet = env
            .storage()
            .persistent()
            .get(&bet_key)
            .ok_or(MarketError::NoBetFound)?;

        if bet.claimed {
            return Err(MarketError::AlreadyClaimed);
        }

        let is_winner = bet.is_yes == market.outcome;

        let total_pool = market.total_yes + market.total_no;
        let winning_side_total = if market.outcome {
            market.total_yes
        } else {
            market.total_no
        };

        let this = env.current_contract_address();

        if is_winner && winning_side_total > 0 {
            // Payout = (user_net_bet / winning_side_total) × total_pool
            let payout = (bet.amount * total_pool) / winning_side_total;

            let xlm_sac: Address = env
                .storage()
                .instance()
                .get(&DataKey::XlmSacContract)
                .unwrap();
            let xlm = token::Client::new(&env, &xlm_sac);
            xlm.transfer(&this, &user, &payout);
        }

        // ── Inter-contract: Leaderboard.add_pts ──────────────────────────
        let leaderboard: Address = env
            .storage()
            .instance()
            .get(&DataKey::LeaderboardContract)
            .unwrap();

        let (points, is_winner_val): (u64, bool) = if is_winner {
            (WIN_POINTS, true)
        } else {
            (LOSE_POINTS, false)
        };

        let _: Val = env.invoke_contract(
            &leaderboard,
            &Symbol::new(&env, "add_pts"),
            vec![
                &env,
                this.clone().into_val(&env),
                user.clone().into_val(&env),
                points.into_val(&env),
                is_winner_val.into_val(&env),
            ],
        );

        // ── Inter-contract: IPredictToken.mint ───────────────────────────
        let token_contract: Address = env
            .storage()
            .instance()
            .get(&DataKey::TokenContract)
            .unwrap();

        let mint_amount: i128 = if is_winner {
            WIN_TOKENS
        } else {
            LOSE_TOKENS
        };

        let _: Val = env.invoke_contract(
            &token_contract,
            &Symbol::new(&env, "mint"),
            vec![
                &env,
                this.into_val(&env),
                user.clone().into_val(&env),
                mint_amount.into_val(&env),
            ],
        );

        // Mark claimed
        bet.claimed = true;
        env.storage().persistent().set(&bet_key, &bet);

        env.events().publish(
            (symbol_short!("claim"),),
            (market_id, user, is_winner, points, mint_amount),
        );

        Ok(())
    }

    // ── Admin: Withdraw Fees ──────────────────────────────────────────────

    pub fn withdraw_fees(env: Env, admin: Address) -> Result<i128, MarketError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();

        let fees: i128 = env
            .storage()
            .instance()
            .get(&DataKey::AccumulatedFees)
            .unwrap_or(0);

        if fees == 0 {
            return Err(MarketError::NoFeesToWithdraw);
        }

        let xlm_sac: Address = env
            .storage()
            .instance()
            .get(&DataKey::XlmSacContract)
            .unwrap();
        let xlm = token::Client::new(&env, &xlm_sac);
        xlm.transfer(&env.current_contract_address(), &admin, &fees);

        env.storage()
            .instance()
            .set(&DataKey::AccumulatedFees, &0_i128);

        env.events().publish(
            (symbol_short!("fees"), symbol_short!("withdraw")),
            (admin, fees),
        );

        Ok(fees)
    }

    // ── View Functions ────────────────────────────────────────────────────

    pub fn get_market(env: Env, market_id: u64) -> Result<Market, MarketError> {
        Self::load_market(&env, market_id)
    }

    pub fn get_bet(
        env: Env,
        market_id: u64,
        user: Address,
    ) -> Result<Bet, MarketError> {
        env.storage()
            .persistent()
            .get(&DataKey::Bet(market_id, user))
            .ok_or(MarketError::NoBetFound)
    }

    pub fn get_market_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::MarketCount)
            .unwrap_or(0)
    }

    pub fn get_odds(env: Env, market_id: u64) -> Result<Odds, MarketError> {
        let market = Self::load_market(&env, market_id)?;
        let total = market.total_yes + market.total_no;
        if total == 0 {
            return Ok(Odds {
                yes_percent: 50,
                no_percent: 50,
            });
        }
        let yes_pct = ((market.total_yes * 100) / total) as u32;
        let no_pct = 100 - yes_pct;
        Ok(Odds {
            yes_percent: yes_pct,
            no_percent: no_pct,
        })
    }

    pub fn get_market_bettors(
        env: Env,
        market_id: u64,
    ) -> Result<Vec<Address>, MarketError> {
        // Verify the market exists
        Self::load_market(&env, market_id)?;

        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::BettorCount(market_id))
            .unwrap_or(0);

        let mut result: Vec<Address> = Vec::new(&env);
        for i in 0..count {
            let addr: Address = env
                .storage()
                .persistent()
                .get(&DataKey::BettorAt(market_id, i))
                .unwrap();
            result.push_back(addr);
        }
        Ok(result)
    }

    pub fn get_accumulated_fees(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::AccumulatedFees)
            .unwrap_or(0)
    }

    // ── Internal Helpers ──────────────────────────────────────────────────

    fn load_market(env: &Env, market_id: u64) -> Result<Market, MarketError> {
        env.storage()
            .persistent()
            .get(&DataKey::Market(market_id))
            .ok_or(MarketError::MarketNotFound)
    }

    fn require_admin(env: &Env, caller: &Address) -> Result<(), MarketError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(MarketError::NotInitialized)?;
        if *caller != admin {
            return Err(MarketError::NotAdmin);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
