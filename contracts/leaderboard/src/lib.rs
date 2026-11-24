#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, vec, Address, BytesN, Env, IntoVal, Symbol, Val, Vec,
};

const MAX_TOP_PLAYERS: u32 = 50;
const MAX_PAGE_SIZE: u32   = 20;
const TTL_BUMP: u32 = 3_153_600;
const TTL_HIGH: u32 = 6_307_200;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum LeaderboardError {
    AlreadyInitialized = 1,
    NotInitialized     = 2,
    UnauthorizedCaller = 3,
    InvalidPoints      = 4,
    NotAdmin           = 5,
    NoPendingAdmin     = 6,
}

// OPT: was 4 separate keys per user (Points, TotalBets, WonBets, LostBets).
//      Now 1 key per user (Stats) — saves 3 storage reads + 3 writes on
//      every add_pts call and 3 reads on every get_stats call.
//      TopPlayerSlot retained as a reverse lookup for O(1) in-place update.
//      TopPlayerCount moves to instance storage (free to read with other keys).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    PendingAdmin,
    MarketContract,
    ReferralContract,
    // Lever G: token address so reward() can mint IPRED internally — one
    // cross-call from the market instead of two (add_pts + mint).
    TokenContract,
    Stats(Address),        // was: Points + TotalBets + WonBets + LostBets (4 keys → 1)
    TopPlayerAt(u32),
    TopPlayerCount,
    TopPlayerSlot(Address),
    MinPoints,             // u64 — points of the weakest entry currently in the top list
    MinSlot,               // u32 — slot index of that weakest entry
}

// OPT: PlayerEntry now embeds points directly (avoids a Stats read during sort)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlayerEntry {
    pub address: Address,
    pub points:  u64,
}

// External-facing stats struct (ABI stable)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlayerStats {
    pub points:     u64,
    pub total_bets: u32,
    pub won_bets:   u32,
    pub lost_bets:  u32,
}

// Internal packed stats — single storage slot per user
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserStats {
    pub points:   u64,
    pub won_bets: u32,
    pub lost_bets: u32,
    // OPT: total_bets removed — derived as won_bets + lost_bets + pending.
    //      Since prediction_market no longer calls record_bet, we compute
    //      total_bets at read time: won + lost (fully settled bets only).
    //      This eliminates the won_bets vs total_bets drift issue too.
}

// ── Events (#775) ─────────────────────────────────────────────────────────────

#[contractevent(topics = ["leaderboard", "points_added"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PointsAddedEvent {
    pub user: Address,
    pub points: u64,
    pub total_points: u64,
    pub is_winner: bool,
}

#[contractevent(topics = ["leaderboard", "reward"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardEvent {
    pub user: Address,
    pub points: u64,
    pub tokens: i128,
    pub total_points: u64,
    pub is_winner: bool,
}

#[contractevent(topics = ["leaderboard", "bonus_added"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BonusPointsAddedEvent {
    pub user: Address,
    pub points: u64,
    pub total_points: u64,
}

#[contractevent(topics = ["leaderboard", "reward_bonus"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardBonusEvent {
    pub user: Address,
    pub points: u64,
    pub tokens: i128,
    pub total_points: u64,
}

#[contract]
pub struct LeaderboardContract;

#[contractimpl]
impl LeaderboardContract {

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
        env.storage().instance().set(&DataKey::MarketContract, &market_contract);
        env.storage().instance().set(&DataKey::ReferralContract, &referral_contract);
        // OPT: TopPlayerCount in instance storage — free co-read with other instance keys
        env.storage().instance().set(&DataKey::TopPlayerCount, &0_u32);
        Ok(())
    }

    // ── Upgradeability & Config (admin only) ──────────────────────────────────

    /// Replace this contract's WASM in place. Admin only. Storage preserved.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), LeaderboardError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    /// Re-point the trusted market and referral contracts. Admin only.
    /// Needed if the market/referral are redeployed to new addresses.
    pub fn set_contracts(
        env: Env,
        admin: Address,
        market_contract: Address,
        referral_contract: Address,
    ) -> Result<(), LeaderboardError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::MarketContract, &market_contract);
        env.storage().instance().set(&DataKey::ReferralContract, &referral_contract);
        Ok(())
    }

    pub fn set_token(env: Env, admin: Address, token_contract: Address) -> Result<(), LeaderboardError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::TokenContract, &token_contract);
        Ok(())
    }

    pub fn reward(
        env: Env,
        caller: Address,
        user: Address,
        points: u64,
        tokens: i128,
        is_winner: bool,
    ) -> Result<(), LeaderboardError> {
        caller.require_auth();
        Self::require_market_contract(&env, &caller)?;
        if points == 0 { return Err(LeaderboardError::InvalidPoints); }

        // 1) Points / win-loss — identical to add_pts.
        let sk = DataKey::Stats(user.clone());
        let mut s: UserStats = env.storage().persistent().get(&sk)
            .unwrap_or(UserStats { points: 0, won_bets: 0, lost_bets: 0 });
        s.points += points;
        if is_winner { s.won_bets += 1; } else { s.lost_bets += 1; }
        env.storage().persistent().set(&sk, &s);
        env.storage().persistent().extend_ttl(&sk, TTL_BUMP, TTL_HIGH);
        Self::upsert_top(&env, &user, s.points);

        RewardEvent {
            user: user.clone(),
            points,
            tokens,
            total_points: s.points,
            is_winner,
        }
        .publish(&env);

        // 2) Mint IPRED internally (the second cross-call the market used to make).
        if tokens > 0 {
            let token: Address = env.storage().instance().get(&DataKey::TokenContract)
                .ok_or(LeaderboardError::NotInitialized)?;
            let this = env.current_contract_address();
            let _: Val = env.invoke_contract(
                &token,
                &Symbol::new(&env, "mint"),
                vec![&env, this.into_val(&env), user.into_val(&env), tokens.into_val(&env)],
            );
        }
        Ok(())
    }

    // OPT: 1 storage read+write instead of 4 separate reads + 2 writes
    pub fn add_pts(
        env: Env,
        caller: Address,
        user: Address,
        points: u64,
        is_winner: bool,
    ) -> Result<(), LeaderboardError> {
        caller.require_auth();
        Self::require_market_contract(&env, &caller)?;
        if points == 0 { return Err(LeaderboardError::InvalidPoints); }

        let sk = DataKey::Stats(user.clone());
        let mut s: UserStats = env.storage().persistent().get(&sk)
            .unwrap_or(UserStats { points: 0, won_bets: 0, lost_bets: 0 });

        s.points += points;
        if is_winner { s.won_bets += 1; } else { s.lost_bets += 1; }
        env.storage().persistent().set(&sk, &s);
        env.storage().persistent().extend_ttl(&sk, TTL_BUMP, TTL_HIGH);

        Self::upsert_top(&env, &user, s.points);

        PointsAddedEvent {
            user: user.clone(),
            points,
            total_points: s.points,
            is_winner,
        }
        .publish(&env);

        Ok(())
    }

    pub fn reward_bonus(
        env: Env,
        caller: Address,
        user: Address,
        points: u64,
        tokens: i128,
    ) -> Result<(), LeaderboardError> {
        caller.require_auth();
        Self::require_referral_contract(&env, &caller)?;
        if points == 0 { return Err(LeaderboardError::InvalidPoints); }

        let sk = DataKey::Stats(user.clone());
        let mut s: UserStats = env.storage().persistent().get(&sk)
            .unwrap_or(UserStats { points: 0, won_bets: 0, lost_bets: 0 });
        s.points += points;
        env.storage().persistent().set(&sk, &s);
        env.storage().persistent().extend_ttl(&sk, TTL_BUMP, TTL_HIGH);
        Self::upsert_top(&env, &user, s.points);

        RewardBonusEvent {
            user: user.clone(),
            points,
            tokens,
            total_points: s.points,
        }
        .publish(&env);

        if tokens > 0 {
            let token: Address = env.storage().instance().get(&DataKey::TokenContract)
                .ok_or(LeaderboardError::NotInitialized)?;
            let this = env.current_contract_address();
            let _: Val = env.invoke_contract(
                &token,
                &Symbol::new(&env, "mint"),
                vec![&env, this.into_val(&env), user.into_val(&env), tokens.into_val(&env)],
            );
        }
        Ok(())
    }

    // OPT: same 1-read pattern for bonus points
    pub fn add_bonus_pts(
        env: Env,
        caller: Address,
        user: Address,
        points: u64,
    ) -> Result<(), LeaderboardError> {
        caller.require_auth();
        Self::require_referral_contract(&env, &caller)?;
        if points == 0 { return Err(LeaderboardError::InvalidPoints); }

        let sk = DataKey::Stats(user.clone());
        let mut s: UserStats = env.storage().persistent().get(&sk)
            .unwrap_or(UserStats { points: 0, won_bets: 0, lost_bets: 0 });
        s.points += points;
        env.storage().persistent().set(&sk, &s);
        env.storage().persistent().extend_ttl(&sk, TTL_BUMP, TTL_HIGH);

        Self::upsert_top(&env, &user, s.points);

        BonusPointsAddedEvent {
            user: user.clone(),
            points,
            total_points: s.points,
        }
        .publish(&env);

        Ok(())
    }

    // OPT: record_bet is kept for ABI compatibility but now a no-op —
    //      we removed the cross-contract call from place_bet so this is
    //      never called. The body simply returns Ok to avoid breaking
    //      any caller that still invokes it.
    pub fn record_bet(
        env: Env,
        caller: Address,
        _user: Address,
    ) -> Result<(), LeaderboardError> {
        caller.require_auth();
        Self::require_market_contract(&env, &caller)?;
        // No-op: total_bets derived from won_bets + lost_bets at read time
        Ok(())
    }

    pub fn get_points(env: Env, user: Address) -> u64 {
        env.storage().persistent()
            .get::<DataKey, UserStats>(&DataKey::Stats(user))
            .map(|s| s.points)
            .unwrap_or(0)
    }

    // OPT: 1 read instead of 4; total_bets = won + lost (settled bets)
    pub fn get_stats(env: Env, user: Address) -> PlayerStats {
        let s: UserStats = env.storage().persistent()
            .get(&DataKey::Stats(user))
            .unwrap_or(UserStats { points: 0, won_bets: 0, lost_bets: 0 });
        PlayerStats {
            points:     s.points,
            total_bets: s.won_bets + s.lost_bets,
            won_bets:   s.won_bets,
            lost_bets:  s.lost_bets,
        }
    }

    // FIX (#778): Keep the list sorted on write instead of sorting on every read.
    //      
    //      BEFORE: The old implementation loaded all 50 entries, ran O(n²) selection  
    //      sort with full Vec rebuilds on EVERY get_top_players call, even when the
    //      list was already sorted. This was extremely expensive.
    //      
    //      AFTER: The TopPlayerAt(slot) entries are now maintained in descending
    //      order by points during upsert_top. Reads simply slice the pre-sorted list.
    //      No sorting happens in get_top_players.
    //      
    //      Trade-off: Writes now do O(n) work to maintain sort order (find insertion  
    //      point + shift entries), but this is WAY cheaper than O(n²) sorts on every
    //      read, since reads happen far more frequently than writes.
    //      
    //      Result: Reads are now O(page_size) with just storage lookups, no sorting.
    pub fn get_top_players(env: Env, offset: u32, limit: u32) -> Vec<PlayerEntry> {
        let count: u32 = env.storage().instance().get(&DataKey::TopPlayerCount).unwrap_or(0);
        if count == 0 || offset >= count { return Vec::new(&env); }

        let page_size = if limit == 0 || limit > MAX_PAGE_SIZE { MAX_PAGE_SIZE } else { limit };

        // The list is already sorted in descending order by points in storage.
        // Simply read the requested slice directly without any sorting.
        let end = {
            let e = offset + page_size;
            if e < count { e } else { count }
        };
        
        let mut result: Vec<PlayerEntry> = Vec::new(&env);
        for i in offset..end {
            if let Some(e) = env.storage().persistent().get::<DataKey, PlayerEntry>(&DataKey::TopPlayerAt(i)) {
                result.push_back(e);
            }
        }
        result
    }

    pub fn get_rank(env: Env, user: Address) -> u32 {
        // OPT: early exit if user not in top list
        let slot: Option<u32> = env.storage().persistent().get(&DataKey::TopPlayerSlot(user.clone()));
        if slot.is_none() { return 0; }

        let user_pts: u64 = env.storage().persistent()
            .get::<DataKey, UserStats>(&DataKey::Stats(user.clone()))
            .map(|s| s.points)
            .unwrap_or(0);

        let count: u32 = env.storage().instance().get(&DataKey::TopPlayerCount).unwrap_or(0);
        let mut rank: u32 = 1;
        for i in 0..count {
            if let Some(e) = env.storage().persistent().get::<DataKey, PlayerEntry>(&DataKey::TopPlayerAt(i)) {
                if e.address != user && e.points > user_pts { rank += 1; }
            }
        }
        rank
    }

    pub fn get_player_count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::TopPlayerCount).unwrap_or(0)
    }

    fn upsert_top(env: &Env, user: &Address, new_points: u64) {
        let count: u32 = env.storage().instance().get(&DataKey::TopPlayerCount).unwrap_or(0);
        let slot: Option<u32> = env.storage().persistent().get(&DataKey::TopPlayerSlot(user.clone()));

        if let Some(old_slot) = slot {
            // User already in list — update their points and restore sort order.
            // Strategy: Remove from old position, find new sorted position, insert there.
            
            // Create updated entry
            let new_entry = PlayerEntry { address: user.clone(), points: new_points };
            
            // Find the correct position for new_points in sorted order (descending)
            let mut new_slot = 0;
            for i in 0..count {
                if let Some(e) = env.storage().persistent().get::<DataKey, PlayerEntry>(&DataKey::TopPlayerAt(i)) {
                    // Skip the current user's old entry in the comparison
                    if e.address == *user {
                        continue;
                    }
                    // Found first entry with points <= new_points, insert before it
                    if e.points <= new_points {
                        new_slot = i;
                        break;
                    }
                    new_slot = i + 1; // Insert after all higher entries
                }
            }
            
            // If the slot would be the same, just update in place
            if new_slot == old_slot {
                env.storage().persistent().set(&DataKey::TopPlayerAt(old_slot), &new_entry);
                env.storage().persistent().extend_ttl(&DataKey::TopPlayerAt(old_slot), TTL_BUMP, TTL_HIGH);
            } else {
                // Remove from old position and shift entries
                // Then insert at new position
                if new_slot < old_slot {
                    // Moving up: shift [new_slot..old_slot) down by 1
                    for i in (new_slot..old_slot).rev() {
                        if let Some(e) = env.storage().persistent().get::<DataKey, PlayerEntry>(&DataKey::TopPlayerAt(i)) {
                            env.storage().persistent().set(&DataKey::TopPlayerAt(i + 1), &e);
                            env.storage().persistent().extend_ttl(&DataKey::TopPlayerAt(i + 1), TTL_BUMP, TTL_HIGH);
                            env.storage().persistent().set(&DataKey::TopPlayerSlot(e.address.clone()), &(i + 1));
                            env.storage().persistent().extend_ttl(&DataKey::TopPlayerSlot(e.address), TTL_BUMP, TTL_HIGH);
                        }
                    }
                } else {
                    // Moving down: shift (old_slot..new_slot] up by 1
                    for i in (old_slot + 1)..=new_slot {
                        if let Some(e) = env.storage().persistent().get::<DataKey, PlayerEntry>(&DataKey::TopPlayerAt(i)) {
                            env.storage().persistent().set(&DataKey::TopPlayerAt(i - 1), &e);
                            env.storage().persistent().extend_ttl(&DataKey::TopPlayerAt(i - 1), TTL_BUMP, TTL_HIGH);
                            env.storage().persistent().set(&DataKey::TopPlayerSlot(e.address.clone()), &(i - 1));
                            env.storage().persistent().extend_ttl(&DataKey::TopPlayerSlot(e.address), TTL_BUMP, TTL_HIGH);
                        }
                    }
                }
                
                // Insert at new position
                env.storage().persistent().set(&DataKey::TopPlayerAt(new_slot), &new_entry);
                env.storage().persistent().extend_ttl(&DataKey::TopPlayerAt(new_slot), TTL_BUMP, TTL_HIGH);
                env.storage().persistent().set(&DataKey::TopPlayerSlot(user.clone()), &new_slot);
                env.storage().persistent().extend_ttl(&DataKey::TopPlayerSlot(user.clone()), TTL_BUMP, TTL_HIGH);
            }
            
            // Recompute min if at capacity
            if count >= MAX_TOP_PLAYERS {
                Self::recompute_min(env, count);
            }
            return;
        }

        // User not in list — try to add them
        if count < MAX_TOP_PLAYERS {
            // Room available — find correct sorted position and insert
            let mut insert_pos = count; // Default: append at end
            for i in 0..count {
                if let Some(entry) = env.storage().persistent().get::<DataKey, PlayerEntry>(&DataKey::TopPlayerAt(i)) {
                    if new_points > entry.points {
                        insert_pos = i;
                        break;
                    }
                }
            }
            
            let new_entry = PlayerEntry { address: user.clone(), points: new_points };
            
            // Shift existing entries down from insert_pos to make room
            for i in (insert_pos..count).rev() {
                if let Some(entry) = env.storage().persistent().get::<DataKey, PlayerEntry>(&DataKey::TopPlayerAt(i)) {
                    env.storage().persistent().set(&DataKey::TopPlayerAt(i + 1), &entry);
                    env.storage().persistent().extend_ttl(&DataKey::TopPlayerAt(i + 1), TTL_BUMP, TTL_HIGH);
                    env.storage().persistent().set(&DataKey::TopPlayerSlot(entry.address.clone()), &(i + 1));
                    env.storage().persistent().extend_ttl(&DataKey::TopPlayerSlot(entry.address), TTL_BUMP, TTL_HIGH);
                }
            }
            
            // Insert new entry
            env.storage().persistent().set(&DataKey::TopPlayerAt(insert_pos), &new_entry);
            env.storage().persistent().extend_ttl(&DataKey::TopPlayerAt(insert_pos), TTL_BUMP, TTL_HIGH);
            env.storage().persistent().set(&DataKey::TopPlayerSlot(user.clone()), &insert_pos);
            env.storage().persistent().extend_ttl(&DataKey::TopPlayerSlot(user.clone()), TTL_BUMP, TTL_HIGH);
            
            let new_count = count + 1;
            env.storage().instance().set(&DataKey::TopPlayerCount, &new_count);
            
            // Update cached min
            if new_count >= MAX_TOP_PLAYERS {
                Self::recompute_min(env, new_count);
            }
            return;
        }

        // List is full — check if new entry beats the minimum
        let mut min_pts: u64 = env.storage().instance().get(&DataKey::MinPoints).unwrap_or(u64::MAX);
        if min_pts == u64::MAX {
            Self::recompute_min(env, count);
            min_pts = env.storage().instance().get(&DataKey::MinPoints).unwrap_or(u64::MAX);
        }
        
        if new_points <= min_pts {
            return; // Not good enough to make the list
        }

        // Remove the weakest entry and insert the new one in sorted position
        let min_slot: u32 = env.storage().instance().get(&DataKey::MinSlot).unwrap_or(count - 1);
        if let Some(old) = env.storage().persistent().get::<DataKey, PlayerEntry>(&DataKey::TopPlayerAt(min_slot)) {
            env.storage().persistent().remove(&DataKey::TopPlayerSlot(old.address));
        }
        
        // Find correct position for new entry
        let mut insert_pos = min_slot; // Default: insert where min was
        for i in 0..count {
            if let Some(entry) = env.storage().persistent().get::<DataKey, PlayerEntry>(&DataKey::TopPlayerAt(i)) {
                if new_points > entry.points {
                    insert_pos = i;
                    break;
                }
            }
        }
        
        let new_entry = PlayerEntry { address: user.clone(), points: new_points };
        
        // Shift entries to make room (only if not inserting at min_slot)
        if insert_pos < min_slot {
            for i in (insert_pos..min_slot).rev() {
                if let Some(entry) = env.storage().persistent().get::<DataKey, PlayerEntry>(&DataKey::TopPlayerAt(i)) {
                    env.storage().persistent().set(&DataKey::TopPlayerAt(i + 1), &entry);
                    env.storage().persistent().extend_ttl(&DataKey::TopPlayerAt(i + 1), TTL_BUMP, TTL_HIGH);
                    env.storage().persistent().set(&DataKey::TopPlayerSlot(entry.address.clone()), &(i + 1));
                    env.storage().persistent().extend_ttl(&DataKey::TopPlayerSlot(entry.address), TTL_BUMP, TTL_HIGH);
                }
            }
        } else if insert_pos > min_slot {
            // Shift up from min_slot to insert_pos-1
            for i in min_slot..insert_pos {
                if let Some(entry) = env.storage().persistent().get::<DataKey, PlayerEntry>(&DataKey::TopPlayerAt(i + 1)) {
                    env.storage().persistent().set(&DataKey::TopPlayerAt(i), &entry);
                    env.storage().persistent().extend_ttl(&DataKey::TopPlayerAt(i), TTL_BUMP, TTL_HIGH);
                    env.storage().persistent().set(&DataKey::TopPlayerSlot(entry.address.clone()), &i);
                    env.storage().persistent().extend_ttl(&DataKey::TopPlayerSlot(entry.address), TTL_BUMP, TTL_HIGH);
                }
            }
        }
        
        // Insert new entry
        env.storage().persistent().set(&DataKey::TopPlayerAt(insert_pos), &new_entry);
        env.storage().persistent().extend_ttl(&DataKey::TopPlayerAt(insert_pos), TTL_BUMP, TTL_HIGH);
        env.storage().persistent().set(&DataKey::TopPlayerSlot(user.clone()), &insert_pos);
        env.storage().persistent().extend_ttl(&DataKey::TopPlayerSlot(user.clone()), TTL_BUMP, TTL_HIGH);
        
        // Recompute min
        Self::recompute_min(env, count);
    }

    fn recompute_min(env: &Env, count: u32) {
        let mut min_pts = u64::MAX;
        let mut min_slot: u32 = 0;
        for i in 0..count {
            if let Some(e) = env.storage().persistent().get::<DataKey, PlayerEntry>(&DataKey::TopPlayerAt(i)) {
                if e.points < min_pts {
                    min_pts = e.points;
                    min_slot = i;
                }
            }
        }
        env.storage().instance().set(&DataKey::MinPoints, &min_pts);
        env.storage().instance().set(&DataKey::MinSlot, &min_slot);
    }

    #[inline]
    fn require_market_contract(env: &Env, caller: &Address) -> Result<(), LeaderboardError> {
        let mkt: Address = env.storage().instance().get(&DataKey::MarketContract)
            .ok_or(LeaderboardError::NotInitialized)?;
        if *caller != mkt { return Err(LeaderboardError::UnauthorizedCaller); }
        Ok(())
    }

    #[inline]
    fn require_referral_contract(env: &Env, caller: &Address) -> Result<(), LeaderboardError> {
        let ref_: Address = env.storage().instance().get(&DataKey::ReferralContract)
            .ok_or(LeaderboardError::NotInitialized)?;
        if *caller != ref_ { return Err(LeaderboardError::UnauthorizedCaller); }
        Ok(())
    }

    /// Two-step admin transfer, step 1: current admin nominates `new_admin`.
    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) -> Result<(), LeaderboardError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::PendingAdmin, &new_admin);
        Ok(())
    }

    /// Two-step admin transfer, step 2: the nominee accepts and becomes admin.
    pub fn accept_admin(env: Env, new_admin: Address) -> Result<(), LeaderboardError> {
        new_admin.require_auth();
        let pending: Address = env.storage().instance().get(&DataKey::PendingAdmin)
            .ok_or(LeaderboardError::NoPendingAdmin)?;
        if pending != new_admin { return Err(LeaderboardError::NotAdmin); }
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        Ok(())
    }

    fn require_admin(env: &Env, caller: &Address) -> Result<(), LeaderboardError> {
        let admin: Address = env.storage().instance().get(&DataKey::Admin)
            .ok_or(LeaderboardError::NotInitialized)?;
        if *caller != admin { return Err(LeaderboardError::NotAdmin); }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
