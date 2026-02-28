#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Vec,
};

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_TOP_PLAYERS: u32 = 50;

// ── Errors ────────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum LeaderboardError {
    AlreadyInitialized = 1,
    NotInitialized     = 2,
    UnauthorizedCaller = 3,
    InvalidPoints      = 4,
}

// ── Storage Keys ──────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    MarketContract,
    ReferralContract,
    Points(Address),
    TotalBets(Address),
    WonBets(Address),
    LostBets(Address),
    TopPlayers,
}

// ── Domain Structs ────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlayerEntry {
    pub address: Address,
    pub points: u64,
}

/// Returned by `get_stats`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlayerStats {
    pub points: u64,
    pub total_bets: u32,
    pub won_bets: u32,
    pub lost_bets: u32,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct LeaderboardContract;

#[contractimpl]
impl LeaderboardContract {
    // ── Lifecycle ─────────────────────────────────────────────────────────

    /// One-time initialization.
    /// `market_contract` — PredictionMarket address (calls `add_pts`, `record_bet`).
    /// `referral_contract` — ReferralRegistry address (calls `add_bonus_pts`).
    pub fn initialize(
        env: Env,
        admin: Address,
        market_contract: Address,
        referral_contract: Address,
    ) -> Result<(), LeaderboardError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(LeaderboardError::AlreadyInitialized);
        }

        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::MarketContract, &market_contract);
        env.storage()
            .instance()
            .set(&DataKey::ReferralContract, &referral_contract);

        // Initialise empty top-players list in persistent storage
        let empty: Vec<PlayerEntry> = Vec::new(&env);
        env.storage()
            .persistent()
            .set(&DataKey::TopPlayers, &empty);

        env.events().publish(
            (symbol_short!("init"), symbol_short!("leader")),
            admin,
        );

        Ok(())
    }

    // ── Write Functions (authorized callers only) ─────────────────────────

    /// Called by **PredictionMarket** at claim time.
    /// Awards `points` to `user`, increments `won_bets` or `lost_bets`,
    /// and updates the sorted TopPlayers list.
    pub fn add_pts(
        env: Env,
        caller: Address,
        user: Address,
        points: u64,
        is_winner: bool,
    ) -> Result<(), LeaderboardError> {
        caller.require_auth();
        Self::require_market_contract(&env, &caller)?;

        if points == 0 {
            return Err(LeaderboardError::InvalidPoints);
        }

        // Accumulate points
        let new_total = Self::read_points(&env, &user) + points;
        env.storage()
            .persistent()
            .set(&DataKey::Points(user.clone()), &new_total);

        // Update win / loss counters
        if is_winner {
            let won: u32 = env
                .storage()
                .persistent()
                .get(&DataKey::WonBets(user.clone()))
                .unwrap_or(0);
            env.storage()
                .persistent()
                .set(&DataKey::WonBets(user.clone()), &(won + 1));
        } else {
            let lost: u32 = env
                .storage()
                .persistent()
                .get(&DataKey::LostBets(user.clone()))
                .unwrap_or(0);
            env.storage()
                .persistent()
                .set(&DataKey::LostBets(user.clone()), &(lost + 1));
        }

        // Update sorted leaderboard
        Self::upsert_top_players(&env, &user, new_total);

        env.events().publish(
            (symbol_short!("pts"),),
            (user, points, is_winner),
        );

        Ok(())
    }

    /// Called by **ReferralRegistry** for welcome bonus (5 pts) and referral
    /// bet rewards (3 pts per referred bet).
    /// Does **NOT** modify `won_bets` or `lost_bets`.
    pub fn add_bonus_pts(
        env: Env,
        caller: Address,
        user: Address,
        points: u64,
    ) -> Result<(), LeaderboardError> {
        caller.require_auth();
        Self::require_referral_contract(&env, &caller)?;

        if points == 0 {
            return Err(LeaderboardError::InvalidPoints);
        }

        let new_total = Self::read_points(&env, &user) + points;
        env.storage()
            .persistent()
            .set(&DataKey::Points(user.clone()), &new_total);

        Self::upsert_top_players(&env, &user, new_total);

        env.events().publish(
            (symbol_short!("pts"),),
            (user, points),
        );

        Ok(())
    }

    /// Called by **PredictionMarket** on every `place_bet`.
    /// Increments the user's `total_bets` counter.
    pub fn record_bet(
        env: Env,
        caller: Address,
        user: Address,
    ) -> Result<(), LeaderboardError> {
        caller.require_auth();
        Self::require_market_contract(&env, &caller)?;

        let bets: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalBets(user.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::TotalBets(user.clone()), &(bets + 1));

        Ok(())
    }

    // ── View Functions ────────────────────────────────────────────────────

    /// Return the total points for `user` (0 if never scored).
    pub fn get_points(env: Env, user: Address) -> u64 {
        Self::read_points(&env, &user)
    }

    /// Return full stats for `user`.
    pub fn get_stats(env: Env, user: Address) -> PlayerStats {
        PlayerStats {
            points: Self::read_points(&env, &user),
            total_bets: env
                .storage()
                .persistent()
                .get(&DataKey::TotalBets(user.clone()))
                .unwrap_or(0),
            won_bets: env
                .storage()
                .persistent()
                .get(&DataKey::WonBets(user.clone()))
                .unwrap_or(0),
            lost_bets: env
                .storage()
                .persistent()
                .get(&DataKey::LostBets(user))
                .unwrap_or(0),
        }
    }

    /// Return the top `limit` players (or fewer if the list is smaller).
    pub fn get_top_players(env: Env, limit: u32) -> Vec<PlayerEntry> {
        let list = Self::load_top_players(&env);
        let len = list.len();
        let cap = if limit < len { limit } else { len };
        let mut result = Vec::new(&env);
        for i in 0..cap {
            result.push_back(list.get(i).unwrap());
        }
        result
    }

    /// Return 1-based rank of `user` in the top players, or 0 if unranked.
    pub fn get_rank(env: Env, user: Address) -> u32 {
        let list = Self::load_top_players(&env);
        for i in 0..list.len() {
            let entry: PlayerEntry = list.get(i).unwrap();
            if entry.address == user {
                return i + 1; // 1-based
            }
        }
        0 // not in top list
    }

    // ── Internal Helpers ──────────────────────────────────────────────────

    fn read_points(env: &Env, user: &Address) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::Points(user.clone()))
            .unwrap_or(0)
    }

    fn load_top_players(env: &Env) -> Vec<PlayerEntry> {
        env.storage()
            .persistent()
            .get(&DataKey::TopPlayers)
            .unwrap_or_else(|| Vec::new(env))
    }

    /// Insert or update `user` with `new_points` in the sorted TopPlayers
    /// list. The list is sorted descending by points and capped at
    /// `MAX_TOP_PLAYERS` (50).
    fn upsert_top_players(env: &Env, user: &Address, new_points: u64) {
        let mut list = Self::load_top_players(env);

        // 1. Check if user already exists — if so, remove them first so we
        //    can re-insert at the correct position.
        let mut existing_idx: Option<u32> = None;
        for i in 0..list.len() {
            let entry: PlayerEntry = list.get(i).unwrap();
            if entry.address == *user {
                existing_idx = Some(i);
                break;
            }
        }
        if let Some(idx) = existing_idx {
            list.remove(idx);
        }

        // 2. Find insertion point via linear scan (descending order).
        //    We want the first index where the existing score is < new_points.
        let mut insert_at: u32 = list.len(); // default: append at end
        for i in 0..list.len() {
            let entry: PlayerEntry = list.get(i).unwrap();
            if new_points > entry.points {
                insert_at = i;
                break;
            }
        }

        // 3. If the list is already at capacity and we'd append at the end,
        //    only insert if the user was already in the list (updated) —
        //    otherwise their score isn't high enough.
        if insert_at >= MAX_TOP_PLAYERS && existing_idx.is_none() {
            // Score too low to enter the top 50 — nothing to do
            return;
        }

        // 4. Insert at the correct position
        let new_entry = PlayerEntry {
            address: user.clone(),
            points: new_points,
        };

        if insert_at >= list.len() {
            list.push_back(new_entry);
        } else {
            // Soroban Vec doesn't have insert(), so we rebuild
            let mut rebuilt: Vec<PlayerEntry> = Vec::new(env);
            for i in 0..list.len() {
                if i == insert_at {
                    rebuilt.push_back(new_entry.clone());
                }
                rebuilt.push_back(list.get(i).unwrap());
            }
            list = rebuilt;
        }

        // 5. Trim to MAX_TOP_PLAYERS
        while list.len() > MAX_TOP_PLAYERS {
            list.remove(list.len() - 1);
        }

        env.storage()
            .persistent()
            .set(&DataKey::TopPlayers, &list);
    }

    fn require_market_contract(
        env: &Env,
        caller: &Address,
    ) -> Result<(), LeaderboardError> {
        let market: Address = env
            .storage()
            .instance()
            .get(&DataKey::MarketContract)
            .ok_or(LeaderboardError::NotInitialized)?;
        if *caller != market {
            return Err(LeaderboardError::UnauthorizedCaller);
        }
        Ok(())
    }

    fn require_referral_contract(
        env: &Env,
        caller: &Address,
    ) -> Result<(), LeaderboardError> {
        let referral: Address = env
            .storage()
            .instance()
            .get(&DataKey::ReferralContract)
            .ok_or(LeaderboardError::NotInitialized)?;
        if *caller != referral {
            return Err(LeaderboardError::UnauthorizedCaller);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
