#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, vec,
    Address, Env, IntoVal, String, Symbol, Val,
};

// ── Constants ─────────────────────────────────────────────────────────────────

const WELCOME_BONUS_POINTS: u64 = 5;
const WELCOME_BONUS_TOKENS: i128 = 1_0000000; // 1 IPREDICT (7 decimals)
const REFERRAL_BET_POINTS: u64 = 3;

// ── Errors ────────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ReferralError {
    AlreadyInitialized = 1,
    NotInitialized     = 2,
    UnauthorizedCaller = 3,
    AlreadyRegistered  = 4,
    SelfReferral       = 5,
}

// ── Storage Keys ──────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    MarketContract,
    Referrer(Address),
    DisplayName(Address),
    ReferralCount(Address),
    ReferralEarnings(Address),
    Registered(Address),
    TokenContract,
    LeaderboardContract,
    XlmSacContract,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct ReferralRegistryContract;

#[contractimpl]
impl ReferralRegistryContract {
    // ── Lifecycle ─────────────────────────────────────────────────────────

    /// One-time initialization.
    /// `market_contract` — PredictionMarket address (authorized to call `credit`).
    /// `token_contract` — IPredictToken address (for minting welcome bonus).
    /// `leaderboard_contract` — Leaderboard address (for awarding welcome points).
    /// `xlm_sac` — Native XLM Stellar Asset Contract address (for fee transfers).
    pub fn initialize(
        env: Env,
        admin: Address,
        market_contract: Address,
        token_contract: Address,
        leaderboard_contract: Address,
        xlm_sac: Address,
    ) -> Result<(), ReferralError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(ReferralError::AlreadyInitialized);
        }

        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::MarketContract, &market_contract);
        env.storage()
            .instance()
            .set(&DataKey::TokenContract, &token_contract);
        env.storage()
            .instance()
            .set(&DataKey::LeaderboardContract, &leaderboard_contract);
        env.storage()
            .instance()
            .set(&DataKey::XlmSacContract, &xlm_sac);

        env.events().publish(
            (symbol_short!("init"), symbol_short!("referral")),
            admin,
        );

        Ok(())
    }

    // ── Registration ──────────────────────────────────────────────────────

    /// Register a user with a display name and an optional referrer.
    ///
    /// Awards a **welcome bonus** of 5 leaderboard points and 1 IPREDICT token
    /// via inter-contract calls. If `referrer` is `Some`, stores the referrer
    /// and increments their referral count.
    pub fn register_referral(
        env: Env,
        user: Address,
        display_name: String,
        referrer: Option<Address>,
    ) -> Result<(), ReferralError> {
        user.require_auth();

        // Prevent double registration
        if Self::is_registered(env.clone(), user.clone()) {
            return Err(ReferralError::AlreadyRegistered);
        }

        // Prevent self-referral
        if let Some(ref ref_addr) = referrer {
            if *ref_addr == user {
                return Err(ReferralError::SelfReferral);
            }
        }

        // Mark as registered
        env.storage()
            .persistent()
            .set(&DataKey::Registered(user.clone()), &true);

        // Store display name
        env.storage()
            .persistent()
            .set(&DataKey::DisplayName(user.clone()), &display_name);

        // Store referrer + increment referrer's count
        if let Some(ref ref_addr) = referrer {
            env.storage()
                .persistent()
                .set(&DataKey::Referrer(user.clone()), ref_addr);

            let count: u32 = env
                .storage()
                .persistent()
                .get(&DataKey::ReferralCount(ref_addr.clone()))
                .unwrap_or(0);
            env.storage()
                .persistent()
                .set(&DataKey::ReferralCount(ref_addr.clone()), &(count + 1));
        }

        // ── Inter-contract: welcome bonus ─────────────────────────────────

        let this = env.current_contract_address();

        // Leaderboard.add_bonus_pts(this_contract, user, 5)
        let leaderboard: Address = env
            .storage()
            .instance()
            .get(&DataKey::LeaderboardContract)
            .unwrap();
        let _: Val = env.invoke_contract(
            &leaderboard,
            &Symbol::new(&env, "add_bonus_pts"),
            vec![
                &env,
                this.clone().into_val(&env),
                user.clone().into_val(&env),
                WELCOME_BONUS_POINTS.into_val(&env),
            ],
        );

        // IPredictToken.mint(this_contract, user, 1_0000000)
        let token_contract: Address = env
            .storage()
            .instance()
            .get(&DataKey::TokenContract)
            .unwrap();
        let _: Val = env.invoke_contract(
            &token_contract,
            &Symbol::new(&env, "mint"),
            vec![
                &env,
                this.into_val(&env),
                user.clone().into_val(&env),
                WELCOME_BONUS_TOKENS.into_val(&env),
            ],
        );

        env.events().publish(
            (symbol_short!("referral"), symbol_short!("reg")),
            user,
        );

        Ok(())
    }

    // ── Credit (called by PredictionMarket) ───────────────────────────────

    /// Called by the **PredictionMarket** on every `place_bet`.
    ///
    /// If the bettor (`user`) has a custom referrer:
    ///   1. SAC-transfer `referral_fee` XLM from this contract → referrer
    ///   2. Award 3 bonus leaderboard points to the referrer
    ///   3. Accumulate referrer earnings
    ///   4. Return `true`
    ///
    /// If the bettor has **no** custom referrer, return `false` so the caller
    /// can add the fee to its own `AccumulatedFees`.
    pub fn credit(
        env: Env,
        caller: Address,
        user: Address,
        referral_fee: i128,
    ) -> Result<bool, ReferralError> {
        caller.require_auth();
        Self::require_market_contract(&env, &caller)?;

        // Look up custom referrer
        let referrer: Option<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::Referrer(user.clone()));

        match referrer {
            Some(ref_addr) => {
                // 1. SAC transfer: referral_fee XLM → referrer
                let xlm_sac: Address = env
                    .storage()
                    .instance()
                    .get(&DataKey::XlmSacContract)
                    .unwrap();
                let xlm_client = token::Client::new(&env, &xlm_sac);
                xlm_client.transfer(
                    &env.current_contract_address(),
                    &ref_addr,
                    &referral_fee,
                );

                // 2. Leaderboard.add_bonus_pts(this, referrer, 3)
                let leaderboard: Address = env
                    .storage()
                    .instance()
                    .get(&DataKey::LeaderboardContract)
                    .unwrap();
                let _: Val = env.invoke_contract(
                    &leaderboard,
                    &Symbol::new(&env, "add_bonus_pts"),
                    vec![
                        &env,
                        env.current_contract_address().into_val(&env),
                        ref_addr.clone().into_val(&env),
                        REFERRAL_BET_POINTS.into_val(&env),
                    ],
                );

                // 3. Accumulate earnings
                let earnings: i128 = env
                    .storage()
                    .persistent()
                    .get(&DataKey::ReferralEarnings(ref_addr.clone()))
                    .unwrap_or(0);
                env.storage().persistent().set(
                    &DataKey::ReferralEarnings(ref_addr.clone()),
                    &(earnings + referral_fee),
                );

                env.events().publish(
                    (symbol_short!("referral"), symbol_short!("credit")),
                    (user, ref_addr, referral_fee),
                );

                Ok(true)
            }
            None => {
                // No referrer — return the fee to the market contract
                if referral_fee > 0 {
                    let xlm_sac: Address = env
                        .storage()
                        .instance()
                        .get(&DataKey::XlmSacContract)
                        .unwrap();
                    let xlm_client = token::Client::new(&env, &xlm_sac);
                    xlm_client.transfer(
                        &env.current_contract_address(),
                        &caller,
                        &referral_fee,
                    );
                }
                Ok(false)
            }
        }
    }

    // ── View Functions ────────────────────────────────────────────────────

    /// Return the custom referrer for `user`, or `None` if none was set.
    pub fn get_referrer(env: Env, user: Address) -> Option<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::Referrer(user))
    }

    /// Return the display name for `user` (empty string if not registered).
    pub fn get_display_name(env: Env, user: Address) -> String {
        env.storage()
            .persistent()
            .get(&DataKey::DisplayName(user))
            .unwrap_or_else(|| String::from_str(&env, ""))
    }

    /// Return how many users have registered with `user` as their referrer.
    pub fn get_referral_count(env: Env, user: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::ReferralCount(user))
            .unwrap_or(0)
    }

    /// Return total XLM earned by `user` as a referrer.
    pub fn get_earnings(env: Env, user: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::ReferralEarnings(user))
            .unwrap_or(0)
    }

    /// Return `true` if `user` has a custom referrer.
    pub fn has_referrer(env: Env, user: Address) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Referrer(user))
    }

    /// Return `true` if `user` has called `register_referral`.
    pub fn is_registered(env: Env, user: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Registered(user))
            .unwrap_or(false)
    }

    // ── Internal Helpers ──────────────────────────────────────────────────

    fn require_market_contract(
        env: &Env,
        caller: &Address,
    ) -> Result<(), ReferralError> {
        let market: Address = env
            .storage()
            .instance()
            .get(&DataKey::MarketContract)
            .ok_or(ReferralError::NotInitialized)?;
        if *caller != market {
            return Err(ReferralError::UnauthorizedCaller);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
