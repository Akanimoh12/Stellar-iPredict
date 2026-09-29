#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, vec,
    Address, BytesN, Env, IntoVal, String, Symbol, Val, Vec,
};

// ── Constants ─────────────────────────────────────────────────────────────────

const MIN_BET: i128 = 10_000_000; // 1 XLM in stroops

const MAX_BETS_PER_USER: u32 = 20;
const MAX_MARKETS_PER_HOUR: u32 = 10;

// Fee constants — multiply before divide to avoid precision loss
const TOTAL_FEE_BPS: i128 = 200;
const PLATFORM_FEE_BPS: i128 = 150;
const BPS_DENOM: i128 = 10_000;
const NET_NUMERATOR: i128 = 9_800;

const WIN_POINTS: u64 = 30;
const LOSE_POINTS: u64 = 10;
const WIN_TOKENS: i128 = 10_0000000;
const LOSE_TOKENS: i128 = 2_0000000;

// ── Storage TTL and Archival Strategy (Issue #533) ──────────────────────────
// All persistent storage entries require explicit TTL management. Soroban entries
// expire and are archived after TTL_BUMP seconds; archived entries can be restored
// but incur significant gas costs. The oracle uses a two-level TTL strategy:
//
// TTL_BUMP (3,153,600 seconds ≈ 36.5 days):
//   Initial TTL set on each storage write. Short enough to clean up abandoned
//   entries within ~36 days, but sufficient for normal market operation.
//
// TTL_HIGH (6,307,200 seconds ≈ 73 days):
//   Extended TTL when calling extend_ttl(). Markets and submissions remain alive
//   for up to 73 days, comfortably exceeding the maximum submission lifetime:
//   - Market expiry to submission window: immediate
//   - Submission window (CHALLENGE_WINDOW): 24 hours
//   - Council window (COUNCIL_WINDOW): 72 hours
//   - Maximum total: 96 hours (4 days) from submission to finalization
//
// Every state transition extends TTL to prevent expiry during long disputes:
// - submit_outcome() → extend_ttl (submission active)
// - challenge() → extend_ttl (escalated, awaiting council)
// - resolve_challenge() → extend_ttl (finalized, settlement happens)
// - finalize_outcome() → extend_ttl (unchallenged finalization)
// - finalize_challenge_timeout() → extend_ttl (timeout fallback)
//
// Cost implications:
// - Each extend_ttl call costs ~1000-2000 gas; network writes ~$0.0001 at 10 stroops/op
// - A typical 4-day dispute costs ~4 TTL extensions ≈ $0.0004
// - Storage is restored from archival on demand (~5000 gas per restore)
// - Expected cost for oracle operations: <$0.001 per transaction in 2025 conditions
//
// Monitoring: If a market approaches deadline and TTL is not extended, finalization
// may fail with archival restoration costs. Entries in archive for >30 days are deleted.

const TTL_BUMP: u32 = 3_153_600;
const TTL_HIGH: u32 = 6_307_200;

// ── Optimistic oracle (docs/ORACLE_AND_BACKEND.md — Option B) ─────────────────
// Anyone may post an outcome with a bond once a market has expired. If nobody
// challenges inside CHALLENGE_WINDOW the outcome finalizes and the bond is
// returned. A challenger posting a strictly larger bond escalates the market to
// the resolution council.

const SUBMITTER_BOND: i128 = 100_0000000; // 100 XLM — minimum submitter bond
const DISPUTER_BOND: i128  = 200_0000000; // 200 XLM — minimum disputer bond
const CHALLENGE_WINDOW: u64 = 86_400;     // 24h to challenge a submission
const COUNCIL_WINDOW: u64   = 259_200;    // 72h for the council to rule
const COUNCIL_FEE_BPS: i128 = 1_000;      // 10% of the loser's bond
const CANCELLATION_DEADLINE: u64 = 604_800; // 7d after expiry before permissionless cancellation

// ── Errors ────────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum MarketError {
    AlreadyInitialized = 1,
    NotInitialized     = 2,
    NotAdmin           = 3,
    MarketNotFound     = 4,
    MarketExpired      = 5,
    MarketNotExpired   = 6,
    MarketResolved     = 7,
    MarketCancelled    = 8,
    MarketNotResolved  = 9,
    BetTooSmall        = 10,
    OppositeSideBet    = 11,
    AlreadyClaimed     = 12,
    NoBetFound         = 13,
    InvalidAmount      = 14,
    NoFeesToWithdraw   = 15,
    NotResolver        = 16,
    TooManyBets        = 17,
    NotAuthorized      = 18,
    MarketNotCancelled = 19,
    RateLimitExceeded  = 20,
    // ── Optimistic oracle ──
    SubmissionExists   = 21,          // a submission already exists for this market
    SubmissionNotFound = 22,          // no submission exists for this market
    AlreadyChallenged  = 23,          // the submission has already been disputed
    ChallengeWindowNotElapsed = 24,   // challenge window has not elapsed yet
    OracleWindowClosed = 25,          // challenge window has already elapsed
    OracleInvalidState = 26,          // transition not legal from the current state
    OracleBondTooSmall = 27,          // bond below the minimum / not larger than submitter's
}

// ── Storage Keys ──────────────────────────────────────────────────────────────
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    // Config addresses — all in instance storage (shared, cheap)
    Cfg,                   // single packed Config struct — 1 read instead of 5
    MarketCount,
    AccumulatedFees,
    Market(u64),
    Bet(u64, Address),     // net + gross + count packed; see BetEntry
    BettorCount(u64),
    BettorAt(u64, u32),
    Resolver(Address),
    Resolvers,
    FeeRecipient(Address),
    HasReferrer(Address),
    RateWindow,            // packed u64: high32=window_start_hi, low32=count
    Submission(u64),       // market_id → OracleSubmission (optimistic oracle)
    // Configurable oracle parameters (Issue #525, #526)
    SubmitterBond,         // i128: configurable submitter bond minimum
    DisputerBond,          // i128: configurable disputer bond minimum
    ChallengeWindow,       // u64: challenge window in seconds
    CouncilWindow,         // u64: council window in seconds
    // Multisig voting (Issue #527)
    CouncilVote(u64, Address),  // market_id, member → CouncilVoteRecord
    CouncilVoteCount(u64),      // market_id → vote count
}

// ── Config packed into one instance storage slot ───────────────────────────
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub token:      Address,
    pub referral:   Address,
    pub leaderboard: Address,
    pub xlm_sac:    Address,
}

// ── BetEntry: Bet + Gross + BetCount in one slot ──────────────────────────
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BetEntry {
    pub net:     i128, // post-fee amount bet (used for payout)
    pub gross:   i128, // pre-fee amount sent (used for cancel_refund)
    pub is_yes:  bool,
    pub claimed: bool,
    pub count:   u32,  // how many times this user has bet on this market
}

// ── Domain Structs ────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Category {
    Crypto,
    Sports,
    Politics,
    Entertainment,
    Science,
    Other,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Market {
    pub id:        u64,
    pub question:  String,
    pub image_url: String,
    pub category:  Category,
    pub end_time:  u64,
    pub total_yes: i128,
    pub total_no:  i128,
    pub resolved:  bool,
    pub outcome:   bool,
    pub cancelled: bool,
    pub creator:   Address,
    pub bet_count: u32,
}

// Kept for ABI compatibility — frontend reads Bet fields
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Bet {
    pub amount:  i128,
    pub is_yes:  bool,
    pub claimed: bool,
}

// ── Optimistic Oracle State Machine ───────────────────────────────────────────
//
//   OPEN → SUBMITTED (anyone posts outcome + bond)
//        → CHALLENGED (disputer posts larger bond within CHALLENGE_WINDOW)
//          → ESCALATED (council rules within COUNCIL_WINDOW)
//            → FINALIZED (council decision, bonds distributed)
//        → FINALIZED (unchallenged after CHALLENGE_WINDOW)
//
// `Challenged` is the instant a disputer's bond lands; the same call escalates
// to the council, so it is only ever observed through the `challenged` event.

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OracleState {
    Submitted,
    Challenged,
    Escalated,
    Finalized,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleSubmission {
    pub market_id:          u64,
    pub submitter:          Address,
    pub outcome:            bool,    // outcome asserted by the submitter
    pub bond:               i128,    // submitter bond held in escrow
    pub state:              OracleState,
    pub submitted_at:       u64,
    pub challenge_deadline: u64,     // submitted_at + CHALLENGE_WINDOW
    pub challenger:         Option<Address>,
    pub challenger_bond:    i128,    // 0 while unchallenged
    pub escalated_at:       u64,     // 0 while unchallenged
    pub council_deadline:   u64,     // escalated_at + COUNCIL_WINDOW, 0 while unchallenged
    pub finalized_at:       u64,     // 0 until finalized
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CouncilVoteRecord {
    pub member:    Address,
    pub outcome:   bool,
    pub voted_at:  u64,
}

// ── Oracle Events ─────────────────────────────────────────────────────────────
// Topics are (Symbol "oracle", Symbol <action>) so the indexer can route on
// domain/action exactly as it does for "mkt"/"referral". Payload structs are
// emitted as maps — field names below are the indexer contract.
// See docs/ORACLE_AND_BACKEND.md → "Oracle Event Topics".

#[contractevent(topics = ["oracle", "submitted"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleSubmittedEvent {
    pub market_id:          u64,
    pub submitter:          Address,
    pub outcome:            bool,
    pub bond:               i128,
    pub submitted_at:       u64,
    pub challenge_deadline: u64,
}

#[contractevent(topics = ["oracle", "challenged"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleChallengedEvent {
    pub market_id:      u64,
    pub challenger:     Address,
    pub outcome:        bool, // outcome asserted by the challenger (opposite side)
    pub bond:           i128,
    pub submitter:      Address,
    pub submitter_bond: i128,
    pub challenged_at:  u64,
}

#[contractevent(topics = ["oracle", "escalated"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleEscalatedEvent {
    pub market_id:        u64,
    pub submitter:        Address,
    pub challenger:       Address,
    pub outcome:          bool, // outcome under dispute (the submitter's)
    pub total_bond:       i128, // submitter bond + challenger bond in escrow
    pub escalated_at:     u64,
    pub council_deadline: u64,
}

#[contractevent(topics = ["oracle", "finalized"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleFinalizedEvent {
    pub market_id:         u64,
    pub outcome:           bool,
    pub challenged:        bool, // false = unchallenged auto-finalize, true = council ruling
    pub submitter:         Address,
    pub challenger:        Option<Address>,
    pub submitter_payout:  i128,
    pub challenger_payout: i128,
    pub council_fee:       i128, // 10% of the loser's bond (0 when unchallenged)
    pub protocol_credit:   i128, // total added to AccumulatedFees (fee + residual)
    pub finalized_at:      u64,
}

#[contractevent(topics = ["oracle", "timedout"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChallengeTimedOutEvent {
    pub market_id:         u64,
    pub outcome:           bool,
    pub submitter:         Address,
    pub submitter_payout:  i128,
    pub challenger:        Address,
    pub challenger_payout: i128,
    pub finalized_at:      u64,
}

#[contractevent(topics = ["oracle", "vote_cast"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VoteCastEvent {
    pub market_id:  u64,
    pub member:     Address,
    pub outcome:    bool,
    pub voted_at:   u64,
}

#[contractevent(topics = ["oracle", "bond_minimums_updated"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondMinimumsUpdatedEvent {
    pub old_submitter_bond: i128,
    pub new_submitter_bond: i128,
    pub old_disputer_bond:  i128,
    pub new_disputer_bond:  i128,
    pub updated_at:         u64,
}

#[contractevent(topics = ["oracle", "window_updated"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WindowUpdatedEvent {
    pub window_type:    Symbol,
    pub old_value:      u64,
    pub new_value:      u64,
    pub updated_at:     u64,
}

#[contractevent(topics = ["oracle", "cancelled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketCancelledEvent {
    pub market_id:     u64,
    pub cancelled_at:  u64,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct PredictionMarketContract;

#[contractimpl]
impl PredictionMarketContract {

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
        // OPT: pack all 4 contract addresses into one slot
        env.storage().instance().set(&DataKey::Cfg, &Config {
            token: token_contract,
            referral: referral_contract,
            leaderboard: leaderboard_contract,
            xlm_sac,
        });
        env.storage().instance().set(&DataKey::MarketCount, &0_u64);
        env.storage().instance().set(&DataKey::AccumulatedFees, &0_i128);
        // Initialize configurable oracle parameters with defaults (Issue #525, #526)
        env.storage().instance().set(&DataKey::SubmitterBond, &SUBMITTER_BOND);
        env.storage().instance().set(&DataKey::DisputerBond, &DISPUTER_BOND);
        env.storage().instance().set(&DataKey::ChallengeWindow, &CHALLENGE_WINDOW);
        env.storage().instance().set(&DataKey::CouncilWindow, &COUNCIL_WINDOW);
        Ok(())
    }

    // ── Upgradeability & Config (admin only) ──────────────────────────────────
    // Allows fixing a bad config (e.g. wrong XLM SAC) or shipping a bug fix
    // without redeploying and losing all markets/bets/contract address.

    /// Replace this contract's WASM bytecode in place. Admin only.
    /// Storage is preserved — only the executable changes.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), MarketError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    /// Update the packed Config (token / referral / leaderboard / xlm_sac). Admin only.
    /// Used to correct an address set at initialize time.
    pub fn set_config(
        env: Env,
        admin: Address,
        token_contract: Address,
        referral_contract: Address,
        leaderboard_contract: Address,
        xlm_sac: Address,
    ) -> Result<(), MarketError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::Cfg, &Config {
            token: token_contract,
            referral: referral_contract,
            leaderboard: leaderboard_contract,
            xlm_sac,
        });
        Ok(())
    }

    /// Read the current Config (for verification/admin tooling).
    pub fn get_config(env: Env) -> Config {
        env.storage().instance().get(&DataKey::Cfg).unwrap()
    }

    /// Set bond minimums for optimistic oracle submissions. Admin only. (Issue #525)
    pub fn set_bond_minimums(
        env: Env,
        admin: Address,
        submitter_bond: i128,
        disputer_bond: i128,
    ) -> Result<(), MarketError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();

        if submitter_bond <= 0 || disputer_bond <= 0 {
            return Err(MarketError::InvalidAmount);
        }
        if disputer_bond <= submitter_bond {
            return Err(MarketError::OracleBondTooSmall);
        }

        let old_submitter: i128 = env.storage().instance().get(&DataKey::SubmitterBond).unwrap_or(SUBMITTER_BOND);
        let old_disputer: i128 = env.storage().instance().get(&DataKey::DisputerBond).unwrap_or(DISPUTER_BOND);

        env.storage().instance().set(&DataKey::SubmitterBond, &submitter_bond);
        env.storage().instance().set(&DataKey::DisputerBond, &disputer_bond);

        BondMinimumsUpdatedEvent {
            old_submitter_bond: old_submitter,
            new_submitter_bond: submitter_bond,
            old_disputer_bond: old_disputer,
            new_disputer_bond: disputer_bond,
            updated_at: env.ledger().timestamp(),
        }
        .publish(&env);
        Ok(())
    }

    /// Get current submitter bond minimum.
    pub fn get_submitter_bond(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::SubmitterBond).unwrap_or(SUBMITTER_BOND)
    }

    /// Get current disputer bond minimum.
    pub fn get_disputer_bond(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::DisputerBond).unwrap_or(DISPUTER_BOND)
    }

    /// Set challenge window duration in seconds. Admin only. (Issue #526)
    pub fn set_challenge_window(
        env: Env,
        admin: Address,
        window_secs: u64,
    ) -> Result<(), MarketError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();

        if window_secs == 0 {
            return Err(MarketError::InvalidAmount);
        }

        let old_window: u64 = env.storage().instance().get(&DataKey::ChallengeWindow).unwrap_or(CHALLENGE_WINDOW);
        env.storage().instance().set(&DataKey::ChallengeWindow, &window_secs);

        WindowUpdatedEvent {
            window_type: Symbol::new(&env, "challenge"),
            old_value: old_window,
            new_value: window_secs,
            updated_at: env.ledger().timestamp(),
        }
        .publish(&env);
        Ok(())
    }

    /// Set council window duration in seconds. Admin only. (Issue #526)
    pub fn set_council_window(
        env: Env,
        admin: Address,
        window_secs: u64,
    ) -> Result<(), MarketError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();

        if window_secs == 0 {
            return Err(MarketError::InvalidAmount);
        }

        let old_window: u64 = env.storage().instance().get(&DataKey::CouncilWindow).unwrap_or(COUNCIL_WINDOW);
        env.storage().instance().set(&DataKey::CouncilWindow, &window_secs);

        WindowUpdatedEvent {
            window_type: Symbol::new(&env, "council"),
            old_value: old_window,
            new_value: window_secs,
            updated_at: env.ledger().timestamp(),
        }
        .publish(&env);
        Ok(())
    }

    /// Get current challenge window in seconds.
    pub fn get_challenge_window(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::ChallengeWindow).unwrap_or(CHALLENGE_WINDOW)
    }

    /// Get current council window in seconds.
    pub fn get_council_window(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::CouncilWindow).unwrap_or(COUNCIL_WINDOW)
    }

    // ── Resolver Management ───────────────────────────────────────────────

    pub fn add_resolver(env: Env, admin: Address, resolver: Address) -> Result<(), MarketError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();
        let key = DataKey::Resolver(resolver);
        let mut resolvers: Vec<Address> = env.storage().instance().get(&DataKey::Resolvers).unwrap_or(Vec::new(&env));
        if !resolvers.iter().any(|current| current == resolver) {
            resolvers.push_back(resolver.clone());
            env.storage().instance().set(&DataKey::Resolvers, &resolvers);
        }
        env.storage().instance().extend_ttl(TTL_BUMP, TTL_HIGH);
        env.storage().persistent().set(&key, &true);
        env.storage().persistent().extend_ttl(&key, TTL_BUMP, TTL_HIGH);
        Ok(())
    }

    pub fn remove_resolver(env: Env, admin: Address, resolver: Address) -> Result<(), MarketError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();
        env.storage().persistent().remove(&DataKey::Resolver(resolver));
        let resolvers: Vec<Address> = env.storage().instance().get(&DataKey::Resolvers).unwrap_or(Vec::new(&env));
        let mut remaining = Vec::new(&env);
        for current in resolvers.iter() {
            if current != resolver {
                remaining.push_back(current);
            }
        }
        env.storage().instance().set(&DataKey::Resolvers, &remaining);
        env.storage().instance().extend_ttl(TTL_BUMP, TTL_HIGH);
        Ok(())
    }

    pub fn is_resolver(env: Env, resolver: Address) -> bool {
        env.storage().persistent().get(&DataKey::Resolver(resolver)).unwrap_or(false)
    }

    /// Returns the resolver set used by the oracle aggregator for startup and
    /// periodic configuration validation.
    pub fn get_resolvers(env: Env) -> Vec<Address> {
        env.storage().instance().get(&DataKey::Resolvers).unwrap_or(Vec::new(&env))
    }

    // ── Fee Recipient Management ──────────────────────────────────────────

    pub fn add_fee_recipient(env: Env, admin: Address, recipient: Address) -> Result<(), MarketError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();
        let key = DataKey::FeeRecipient(recipient);
        env.storage().persistent().set(&key, &true);
        env.storage().persistent().extend_ttl(&key, TTL_BUMP, TTL_HIGH);
        Ok(())
    }

    pub fn remove_fee_recipient(env: Env, admin: Address, recipient: Address) -> Result<(), MarketError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();
        env.storage().persistent().remove(&DataKey::FeeRecipient(recipient));
        Ok(())
    }

    // ── Market Management ─────────────────────────────────────────────────

    pub fn create_market(
        env: Env,
        admin: Address,
        question: String,
        image_url: String,
        category: Category,
        duration_secs: u64,
    ) -> Result<u64, MarketError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();
        Self::check_rate(&env)?;

        // OPT: single instance read for count (was already one read)
        let market_id: u64 = env.storage().instance().get(&DataKey::MarketCount).unwrap_or(0) + 1;
        let end_time = env.ledger().timestamp() + duration_secs;

        let market = Market {
            id: market_id,
            question,
            image_url,
            category,
            end_time,
            total_yes: 0,
            total_no: 0,
            resolved: false,
            outcome: false,
            cancelled: false,
            creator: admin,
            bet_count: 0,
        };

        let mkt_key = DataKey::Market(market_id);
        env.storage().persistent().set(&mkt_key, &market);
        env.storage().persistent().extend_ttl(&mkt_key, TTL_BUMP, TTL_HIGH);
        // OPT: removed BettorCount write here — now written lazily on first bet
        env.storage().instance().set(&DataKey::MarketCount, &market_id);

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

        if amount < MIN_BET {
            return Err(MarketError::BetTooSmall);
        }

        // OPT: load market first — cheapest early-exit if not found
        let mut market = Self::load_market(&env, market_id)?;
        if market.cancelled  { return Err(MarketError::MarketCancelled); }
        if market.resolved   { return Err(MarketError::MarketResolved); }
        if env.ledger().timestamp() >= market.end_time { return Err(MarketError::MarketExpired); }

        // OPT: single read for BetEntry (was 3 separate reads: Bet + BetGross + UserBetCount)
        let bet_key = DataKey::Bet(market_id, user.clone());
        let existing: Option<BetEntry> = env.storage().persistent().get(&bet_key);

        // Spam guard + side check combined from single read
        if let Some(ref e) = existing {
            if e.count >= MAX_BETS_PER_USER { return Err(MarketError::TooManyBets); }
            if e.is_yes != is_yes          { return Err(MarketError::OppositeSideBet); }
        }

        let is_increase = existing.is_some();

        // ── Fee calculation — use precomputed multipliers ─────────────────
        let total_fee    = amount * TOTAL_FEE_BPS / BPS_DENOM;
        let platform_fee = amount * PLATFORM_FEE_BPS / BPS_DENOM;
        let referral_fee = total_fee - platform_fee;
        let net          = amount * NET_NUMERATOR / BPS_DENOM;

        // OPT: one Config read instead of 4 separate instance reads
        let cfg: Config = env.storage().instance().get(&DataKey::Cfg).unwrap();

        // ── XLM transfer user → this contract ────────────────────────────
        let xlm = token::Client::new(&env, &cfg.xlm_sac);
        let this = env.current_contract_address();
        xlm.transfer(&user, &this, &amount);

        // ── Accumulated fees ──────────────────────────────────────────────
        let mut acc_fees: i128 = env.storage().instance().get(&DataKey::AccumulatedFees).unwrap_or(0);
        acc_fees += platform_fee;

        // ── Referral (skip if cached no-referrer) ─────────────────────────
        let hr_key = DataKey::HasReferrer(user.clone());
        let cached: Option<bool> = env.storage().persistent().get(&hr_key);

        let paid_referrer = if cached == Some(false) {
            false
        } else {
            xlm.transfer(&this, &cfg.referral, &referral_fee);
            let result: bool = env.invoke_contract(
                &cfg.referral,
                &Symbol::new(&env, "credit"),
                vec![&env, this.clone().into_val(&env), user.clone().into_val(&env), referral_fee.into_val(&env)],
            );
            if cached.is_none() {
                env.storage().persistent().set(&hr_key, &result);
                env.storage().persistent().extend_ttl(&hr_key, TTL_BUMP, TTL_HIGH);
            }
            result
        };

        if !paid_referrer { acc_fees += referral_fee; }
        env.storage().instance().set(&DataKey::AccumulatedFees, &acc_fees);

        // ── Write BetEntry (net + gross + count in one write) ─────────────
        let new_entry = match existing {
            Some(mut e) => { e.net += net; e.gross += amount; e.count += 1; e }
            None        => BetEntry { net, gross: amount, is_yes, claimed: false, count: 1 }
        };
        env.storage().persistent().set(&bet_key, &new_entry);
        env.storage().persistent().extend_ttl(&bet_key, TTL_BUMP, TTL_HIGH);

        // ── Bettor index (first bet only) ─────────────────────────────────
        if !is_increase {
            let cnt_key = DataKey::BettorCount(market_id);
            let count: u32 = env.storage().persistent().get(&cnt_key).unwrap_or(0);
            let slot_key = DataKey::BettorAt(market_id, count);
            // OPT: no clone — user is moved here and we don't need it after
            env.storage().persistent().set(&slot_key, &user);
            env.storage().persistent().extend_ttl(&slot_key, TTL_BUMP, TTL_HIGH);
            let new_count = count + 1;
            env.storage().persistent().set(&cnt_key, &new_count);
            env.storage().persistent().extend_ttl(&cnt_key, TTL_BUMP, TTL_HIGH);
            market.bet_count += 1;
        }

        // ── Market totals ─────────────────────────────────────────────────
        if is_yes { market.total_yes += net; } else { market.total_no += net; }
        let mkt_key = DataKey::Market(market_id);
        env.storage().persistent().set(&mkt_key, &market);
        env.storage().persistent().extend_ttl(&mkt_key, TTL_BUMP, TTL_HIGH);
        Ok(())
    }

    // ── Resolution ────────────────────────────────────────────────────────

    pub fn resolve_market(
        env: Env,
        caller: Address,
        market_id: u64,
        outcome: bool,
    ) -> Result<(), MarketError> {
        caller.require_auth();
        Self::require_admin_or_resolver(&env, &caller)?;

        let mut market = Self::load_market(&env, market_id)?;
        if market.resolved  { return Err(MarketError::MarketResolved); }
        if market.cancelled { return Err(MarketError::MarketCancelled); }
        if env.ledger().timestamp() < market.end_time { return Err(MarketError::MarketNotExpired); }

        Self::apply_resolution(&env, &mut market, outcome);
        Ok(())
    }

    // ── Optimistic Oracle ─────────────────────────────────────────────────
    // Bonded, permissionless resolution. See docs/ORACLE_AND_BACKEND.md.

    /// Post an outcome for an expired market with a bond, opening the challenge
    /// window. Callable by anyone. The bond is escrowed in this contract and
    /// returned on finalization (or forfeited if a challenge succeeds).
    pub fn submit_outcome(
        env: Env,
        submitter: Address,
        market_id: u64,
        outcome: bool,
        bond: i128,
    ) -> Result<(), MarketError> {
        submitter.require_auth();

        let min_bond = Self::get_submitter_bond(&env);
        if bond < min_bond { return Err(MarketError::OracleBondTooSmall); }

        let market = Self::load_market(&env, market_id)?;
        if market.cancelled { return Err(MarketError::MarketCancelled); }
        if market.resolved  { return Err(MarketError::MarketResolved); }
        if env.ledger().timestamp() < market.end_time {
            return Err(MarketError::MarketNotExpired);
        }
        if env.storage().persistent().has(&DataKey::Submission(market_id)) {
            return Err(MarketError::SubmissionExists);
        }

        // Escrow the bond before recording anything.
        let cfg: Config = env.storage().instance().get(&DataKey::Cfg).unwrap();
        token::Client::new(&env, &cfg.xlm_sac)
            .transfer(&submitter, &env.current_contract_address(), &bond);

        let now = env.ledger().timestamp();
        let challenge_window = Self::get_challenge_window(&env);
        let challenge_deadline = now + challenge_window;

        let submission = OracleSubmission {
            market_id,
            submitter: submitter.clone(),
            outcome,
            bond,
            state: OracleState::Submitted,
            submitted_at: now,
            challenge_deadline,
            challenger: None,
            challenger_bond: 0,
            escalated_at: 0,
            council_deadline: 0,
            finalized_at: 0,
        };
        Self::store_submission(&env, &submission);

        OracleSubmittedEvent {
            market_id,
            submitter,
            outcome,
            bond,
            submitted_at: now,
            challenge_deadline,
        }
        .publish(&env);
        Ok(())
    }

    /// Dispute an open submission by posting a strictly larger bond inside the
    /// challenge window. The challenger implicitly asserts the opposite outcome.
    /// Escalates straight to the council — emits both `challenged` and
    /// `escalated`.
    pub fn challenge(
        env: Env,
        challenger: Address,
        market_id: u64,
        bond: i128,
    ) -> Result<(), MarketError> {
        challenger.require_auth();

        let mut submission = Self::load_submission(&env, market_id)?;
        match submission.state {
            OracleState::Submitted => {}
            OracleState::Challenged | OracleState::Escalated => {
                return Err(MarketError::AlreadyChallenged)
            }
            OracleState::Finalized => return Err(MarketError::OracleInvalidState),
        }

        let now = env.ledger().timestamp();
        if now >= submission.challenge_deadline {
            return Err(MarketError::OracleWindowClosed);
        }

        let min_disputer_bond = Self::get_disputer_bond(&env);
        if bond < min_disputer_bond || bond <= submission.bond {
            return Err(MarketError::OracleBondTooSmall);
        }

        let market = Self::load_market(&env, market_id)?;
        if market.cancelled { return Err(MarketError::MarketCancelled); }
        if market.resolved  { return Err(MarketError::MarketResolved); }

        // Escrow the disputer bond alongside the submitter's.
        let cfg: Config = env.storage().instance().get(&DataKey::Cfg).unwrap();
        token::Client::new(&env, &cfg.xlm_sac)
            .transfer(&challenger, &env.current_contract_address(), &bond);

        let council_window = Self::get_council_window(&env);
        let council_deadline = now + council_window;
        submission.state = OracleState::Escalated;
        submission.challenger = Some(challenger.clone());
        submission.challenger_bond = bond;
        submission.escalated_at = now;
        submission.council_deadline = council_deadline;
        Self::store_submission(&env, &submission);

        OracleChallengedEvent {
            market_id,
            challenger: challenger.clone(),
            outcome: !submission.outcome,
            bond,
            submitter: submission.submitter.clone(),
            submitter_bond: submission.bond,
            challenged_at: now,
        }
        .publish(&env);
        OracleEscalatedEvent {
            market_id,
            submitter: submission.submitter.clone(),
            challenger,
            outcome: submission.outcome,
            total_bond: submission.bond + bond,
            escalated_at: now,
            council_deadline,
        }
        .publish(&env);
        Ok(())
    }

    /// Finalize an unchallenged submission once the challenge window has
    /// elapsed. Callable by anyone. Returns the submitter's bond and resolves
    /// the market with the submitted outcome.
    pub fn finalize_outcome(env: Env, market_id: u64) -> Result<(), MarketError> {
        let mut submission = Self::load_submission(&env, market_id)?;
        match submission.state {
            OracleState::Submitted => {}
            // A disputed submission can only be settled by the council.
            OracleState::Challenged | OracleState::Escalated => {
                return Err(MarketError::AlreadyChallenged)
            }
            OracleState::Finalized => return Err(MarketError::OracleInvalidState),
        }
        let now = env.ledger().timestamp();
        if now < submission.challenge_deadline {
            return Err(MarketError::ChallengeWindowNotElapsed);
        }

        let mut market = Self::load_market(&env, market_id)?;

        // Unchallenged: the bond always comes back in full.
        let cfg: Config = env.storage().instance().get(&DataKey::Cfg).unwrap();
        token::Client::new(&env, &cfg.xlm_sac)
            .transfer(&env.current_contract_address(), &submission.submitter, &submission.bond);

        // A market cancelled or force-resolved out of band while the window was
        // open still releases the bond — it just does not resolve again.
        if !market.resolved && !market.cancelled {
            Self::apply_resolution(&env, &mut market, submission.outcome);
        }

        submission.state = OracleState::Finalized;
        submission.finalized_at = now;
        Self::store_submission(&env, &submission);

        OracleFinalizedEvent {
            market_id,
            outcome: submission.outcome,
            challenged: false,
            submitter: submission.submitter.clone(),
            challenger: None,
            submitter_payout: submission.bond,
            challenger_payout: 0,
            council_fee: 0,
            protocol_credit: 0,
            finalized_at: now,
        }
        .publish(&env);
        Ok(())
    }

    /// Record a council member's vote on an escalated market. (Issue #527)
    /// Each member can vote once per market. Duplicate votes are rejected.
    pub fn vote_on_challenge(
        env: Env,
        member: Address,
        market_id: u64,
        outcome: bool,
    ) -> Result<(), MarketError> {
        member.require_auth();
        Self::require_admin_or_resolver(&env, &member)?;

        let submission = Self::load_submission(&env, market_id)?;
        if submission.state != OracleState::Escalated {
            return Err(MarketError::OracleInvalidState);
        }

        let vote_key = DataKey::CouncilVote(market_id, member.clone());
        if env.storage().persistent().has(&vote_key) {
            return Err(MarketError::AlreadyChallenged);
        }

        let now = env.ledger().timestamp();
        let vote = CouncilVoteRecord {
            member: member.clone(),
            outcome,
            voted_at: now,
        };

        env.storage().persistent().set(&vote_key, &vote);
        env.storage().persistent().extend_ttl(&vote_key, TTL_BUMP, TTL_HIGH);

        let count_key = DataKey::CouncilVoteCount(market_id);
        let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
        env.storage().persistent().set(&count_key, &(count + 1));
        env.storage().persistent().extend_ttl(&count_key, TTL_BUMP, TTL_HIGH);

        VoteCastEvent {
            market_id,
            member,
            outcome,
            voted_at: now,
        }
        .publish(&env);
        Ok(())
    }

    /// Council ruling on an escalated market. Requires threshold of votes
    /// from distinct council members. Callable by admin or any resolver once
    /// threshold is reached. (Issue #527)
    ///
    /// Bond distribution follows the design doc:
    ///  - submitter correct → own bond back + half the disputer bond
    ///  - disputer correct  → both bonds, less a 10% council fee on the loser's bond
    /// Whatever the winner does not take is credited to AccumulatedFees, so the
    /// escrow always nets to zero.
    pub fn resolve_challenge(
        env: Env,
        caller: Address,
        market_id: u64,
        outcome: bool,
    ) -> Result<(), MarketError> {
        caller.require_auth();
        Self::require_admin_or_resolver(&env, &caller)?;

        let mut submission = Self::load_submission(&env, market_id)?;
        if submission.state != OracleState::Escalated {
            return Err(MarketError::OracleInvalidState);
        }
        let challenger = submission.challenger.clone().ok_or(MarketError::OracleInvalidState)?;

        let now = env.ledger().timestamp();
        if now < submission.council_deadline {
            return Err(MarketError::ChallengeWindowNotElapsed);
        }

        let count_key = DataKey::CouncilVoteCount(market_id);
        let vote_count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);

        let council_size = Self::get_resolvers(&env).len() as u32;
        let threshold = if council_size > 0 { (council_size / 2) + 1 } else { 1 };

        if vote_count < threshold {
            return Err(MarketError::NotResolver);
        }

        let mut market = Self::load_market(&env, market_id)?;

        let submitter_won = outcome == submission.outcome;
        let loser_bond = if submitter_won { submission.challenger_bond } else { submission.bond };
        let council_fee = loser_bond * COUNCIL_FEE_BPS / BPS_DENOM;
        let winner_share = if submitter_won { loser_bond / 2 } else { loser_bond - council_fee };
        let protocol_credit = loser_bond - winner_share;

        let (submitter_payout, challenger_payout) = if submitter_won {
            (submission.bond + winner_share, 0)
        } else {
            (0, submission.challenger_bond + winner_share)
        };

        let cfg: Config = env.storage().instance().get(&DataKey::Cfg).unwrap();
        let xlm = token::Client::new(&env, &cfg.xlm_sac);
        let this = env.current_contract_address();
        if submitter_payout > 0 { xlm.transfer(&this, &submission.submitter, &submitter_payout); }
        if challenger_payout > 0 { xlm.transfer(&this, &challenger, &challenger_payout); }

        if protocol_credit > 0 {
            let mut acc: i128 = env.storage().instance()
                .get(&DataKey::AccumulatedFees).unwrap_or(0);
            acc += protocol_credit;
            env.storage().instance().set(&DataKey::AccumulatedFees, &acc);
        }

        if !market.resolved && !market.cancelled {
            Self::apply_resolution(&env, &mut market, outcome);
        }

        submission.state = OracleState::Finalized;
        submission.finalized_at = now;
        Self::store_submission(&env, &submission);

        OracleFinalizedEvent {
            market_id,
            outcome,
            challenged: true,
            submitter: submission.submitter.clone(),
            challenger: Some(challenger),
            submitter_payout,
            challenger_payout,
            council_fee,
            protocol_credit,
            finalized_at: now,
        }
        .publish(&env);
        Ok(())
    }

    pub fn get_oracle_submission(env: Env, market_id: u64) -> Result<OracleSubmission, MarketError> {
        Self::load_submission(&env, market_id)
    }

    /// Get the number of council votes cast on an escalated market.
    pub fn get_council_vote_count(env: Env, market_id: u64) -> u32 {
        env.storage().persistent()
            .get(&DataKey::CouncilVoteCount(market_id))
            .unwrap_or(0)
    }

    /// Finalize an escalated market past its council deadline without a ruling.
    /// Callable by anyone. Returns both bonds to their original posters.
    /// Rationale: timeout is a safety valve when council unavailable; returning
    /// both bonds is neutral and avoids incentivizing frivolous challenge or stalling.
    /// (Issue #528)
    pub fn finalize_challenge_timeout(env: Env, market_id: u64) -> Result<(), MarketError> {
        let mut submission = Self::load_submission(&env, market_id)?;
        if submission.state != OracleState::Escalated {
            return Err(MarketError::OracleInvalidState);
        }

        let challenger = submission.challenger.clone().ok_or(MarketError::OracleInvalidState)?;
        let now = env.ledger().timestamp();

        if now < submission.council_deadline {
            return Err(MarketError::ChallengeWindowNotElapsed);
        }

        let mut market = Self::load_market(&env, market_id)?;

        let cfg: Config = env.storage().instance().get(&DataKey::Cfg).unwrap();
        let xlm = token::Client::new(&env, &cfg.xlm_sac);
        let this = env.current_contract_address();

        xlm.transfer(&this, &submission.submitter, &submission.bond);
        xlm.transfer(&this, &challenger, &submission.challenger_bond);

        if !market.resolved && !market.cancelled {
            Self::apply_resolution(&env, &mut market, submission.outcome);
        }

        submission.state = OracleState::Finalized;
        submission.finalized_at = now;
        Self::store_submission(&env, &submission);

        ChallengeTimedOutEvent {
            market_id,
            outcome: submission.outcome,
            submitter: submission.submitter.clone(),
            submitter_payout: submission.bond,
            challenger: challenger.clone(),
            challenger_payout: submission.challenger_bond,
            finalized_at: now,
        }
        .publish(&env);
        Ok(())
    }

    // ── Cancellation ──────────────────────────────────────────────────────

    pub fn cancel_market(env: Env, admin: Address, market_id: u64) -> Result<(), MarketError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();

        let mut market = Self::load_market(&env, market_id)?;
        if market.resolved  { return Err(MarketError::MarketResolved); }
        if market.cancelled { return Err(MarketError::MarketCancelled); }

        market.cancelled = true;
        let mkt_key = DataKey::Market(market_id);
        env.storage().persistent().set(&mkt_key, &market);
        env.storage().persistent().extend_ttl(&mkt_key, TTL_BUMP, TTL_HIGH);

        // Reclaim fees — net * fee_rate / (1 - fee_rate)
        let net_pool    = market.total_yes + market.total_no;
        let fees_in_pool = net_pool * TOTAL_FEE_BPS / (BPS_DENOM - TOTAL_FEE_BPS);
        let mut acc_fees: i128 = env.storage().instance().get(&DataKey::AccumulatedFees).unwrap_or(0);
        acc_fees = if fees_in_pool < acc_fees { acc_fees - fees_in_pool } else { 0 };
        env.storage().instance().set(&DataKey::AccumulatedFees, &acc_fees);

        Ok(())
    }

    pub fn cancel_refund(env: Env, user: Address, market_id: u64) -> Result<i128, MarketError> {
        user.require_auth();

        let market = Self::load_market(&env, market_id)?;
        if !market.cancelled { return Err(MarketError::MarketNotCancelled); }

        // OPT: read BetEntry (which now contains gross) — was a separate BetGross key
        let bet_key = DataKey::Bet(market_id, user.clone());
        let mut entry: BetEntry = env.storage().persistent().get(&bet_key)
            .ok_or(MarketError::NoBetFound)?;

        if entry.gross == 0 { return Err(MarketError::NoBetFound); }

        let gross = entry.gross;
        entry.gross = 0; // idempotency guard
        env.storage().persistent().set(&bet_key, &entry);

        let cfg: Config = env.storage().instance().get(&DataKey::Cfg).unwrap();
        token::Client::new(&env, &cfg.xlm_sac)
            .transfer(&env.current_contract_address(), &user, &gross);

        Ok(gross)
    }

    pub fn cancel_unsubmitted_market(env: Env, market_id: u64) -> Result<(), MarketError> {
        let now = env.ledger().timestamp();
        let mut market = Self::load_market(&env, market_id)?;

        if market.resolved  { return Err(MarketError::MarketResolved); }
        if market.cancelled { return Err(MarketError::MarketCancelled); }

        if now < market.end_time {
            return Err(MarketError::MarketNotExpired);
        }

        let submission_exists = env.storage().persistent().has(&DataKey::Submission(market_id));
        if submission_exists {
            return Err(MarketError::SubmissionExists);
        }

        if now < market.end_time + CANCELLATION_DEADLINE {
            return Err(MarketError::ChallengeWindowNotElapsed);
        }

        market.cancelled = true;
        let mkt_key = DataKey::Market(market_id);
        env.storage().persistent().set(&mkt_key, &market);
        env.storage().persistent().extend_ttl(&mkt_key, TTL_BUMP, TTL_HIGH);

        let net_pool    = market.total_yes + market.total_no;
        let fees_in_pool = net_pool * TOTAL_FEE_BPS / (BPS_DENOM - TOTAL_FEE_BPS);
        let mut acc_fees: i128 = env.storage().instance().get(&DataKey::AccumulatedFees).unwrap_or(0);
        acc_fees = if fees_in_pool < acc_fees { acc_fees - fees_in_pool } else { 0 };
        env.storage().instance().set(&DataKey::AccumulatedFees, &acc_fees);

        MarketCancelledEvent {
            market_id,
            cancelled_at: now,
        }
        .publish(&env);

        Ok(())
    }

    // ── Claim ─────────────────────────────────────────────────────────────
    // OPT: one Config read replaces 3 separate reads (xlm_sac, leaderboard, token)

    pub fn claim(env: Env, user: Address, market_id: u64) -> Result<(), MarketError> {
        user.require_auth();

        let market = Self::load_market(&env, market_id)?;
        if market.cancelled  { return Err(MarketError::MarketCancelled); }
        if !market.resolved  { return Err(MarketError::MarketNotResolved); }

        let bet_key = DataKey::Bet(market_id, user.clone());
        let mut entry: BetEntry = env.storage().persistent().get(&bet_key)
            .ok_or(MarketError::NoBetFound)?;

        if entry.claimed { return Err(MarketError::AlreadyClaimed); }

        let is_winner = entry.is_yes == market.outcome;
        let total_pool = market.total_yes + market.total_no;
        let winning_side = if market.outcome { market.total_yes } else { market.total_no };

        // SECURITY: mark claimed BEFORE any external calls.
        entry.claimed = true;
        env.storage().persistent().set(&bet_key, &entry);
        env.storage().persistent().extend_ttl(&bet_key, TTL_BUMP, TTL_HIGH);

        let cfg: Config = env.storage().instance().get(&DataKey::Cfg).unwrap();
        let this = env.current_contract_address();

        // XLM payout: only when the winning side had bettors.
        // If winning_side == 0, the pool was swept to AccumulatedFees at resolve
        // time so the admin/fee-recipient can withdraw it via withdraw_fees().
        if is_winner && winning_side > 0 {
            let payout = (entry.net * total_pool) / winning_side;
            token::Client::new(&env, &cfg.xlm_sac).transfer(&this, &user, &payout);
        }

        // All participants earn IPRED tokens + leaderboard points regardless.
        // When winning_side == 0, "winners" receive loser-tier rewards (no competition).
        let real_win = is_winner && winning_side > 0;
        let (points, tokens): (u64, i128) = if real_win {
            (WIN_POINTS, WIN_TOKENS)
        } else {
            (LOSE_POINTS, LOSE_TOKENS)
        };

        let _: Val = env.invoke_contract(
            &cfg.leaderboard,
            &Symbol::new(&env, "reward"),
            vec![&env,
                this.clone().into_val(&env),
                user.clone().into_val(&env),
                points.into_val(&env),
                tokens.into_val(&env),
                real_win.into_val(&env),
            ],
        );

        Ok(())
    }

    // ── Withdraw Fees ─────────────────────────────────────────────────────

    pub fn withdraw_fees(env: Env, caller: Address, recipient: Address) -> Result<i128, MarketError> {
        caller.require_auth();
        Self::require_admin_or_fee_recipient(&env, &caller)?;

        let fees: i128 = env.storage().instance().get(&DataKey::AccumulatedFees).unwrap_or(0);
        if fees == 0 { return Err(MarketError::NoFeesToWithdraw); }

        let cfg: Config = env.storage().instance().get(&DataKey::Cfg).unwrap();
        token::Client::new(&env, &cfg.xlm_sac)
            .transfer(&env.current_contract_address(), &recipient, &fees);

        env.storage().instance().set(&DataKey::AccumulatedFees, &0_i128);
        Ok(fees)
    }

    // ── View Functions ────────────────────────────────────────────────────

    pub fn get_market(env: Env, market_id: u64) -> Result<Market, MarketError> {
        Self::load_market(&env, market_id)
    }

    // OPT: returns Bet (ABI-compatible) derived from BetEntry
    pub fn get_bet(env: Env, market_id: u64, user: Address) -> Result<Bet, MarketError> {
        let e: BetEntry = env.storage().persistent()
            .get(&DataKey::Bet(market_id, user))
            .ok_or(MarketError::NoBetFound)?;
        Ok(Bet { amount: e.net, is_yes: e.is_yes, claimed: e.claimed })
    }

    pub fn get_market_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::MarketCount).unwrap_or(0)
    }

    pub fn get_market_bettors(env: Env, market_id: u64) -> Result<Vec<Address>, MarketError> {
        Self::load_market(&env, market_id)?;
        let count: u32 = env.storage().persistent().get(&DataKey::BettorCount(market_id)).unwrap_or(0);
        let mut result: Vec<Address> = Vec::new(&env);
        for i in 0..count {
            if let Some(addr) = env.storage().persistent().get::<DataKey, Address>(&DataKey::BettorAt(market_id, i)) {
                result.push_back(addr);
            }
        }
        Ok(result)
    }

    pub fn get_accumulated_fees(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::AccumulatedFees).unwrap_or(0)
    }

    /// Read the optimistic-oracle submission for a market, if one exists.
    /// Returns `None` while the market is still in the `Open` (no submission)
    /// state. Used by the off-chain indexer/aggregator to track lifecycle.
    pub fn get_submission(env: Env, market_id: u64) -> Option<Submission> {
        env.storage().persistent().get(&DataKey::Submission(market_id))
    }

    pub fn get_user_bet_count(env: Env, market_id: u64, user: Address) -> u32 {
        env.storage().persistent()
            .get::<DataKey, BetEntry>(&DataKey::Bet(market_id, user))
            .map(|e| e.count)
            .unwrap_or(0)
    }

    pub fn get_bet_gross(env: Env, market_id: u64, user: Address) -> i128 {
        env.storage().persistent()
            .get::<DataKey, BetEntry>(&DataKey::Bet(market_id, user))
            .map(|e| e.gross)
            .unwrap_or(0)
    }

    // ── Internal Helpers ──────────────────────────────────────────────────

    #[inline]
    fn load_market(env: &Env, market_id: u64) -> Result<Market, MarketError> {
        env.storage().persistent().get(&DataKey::Market(market_id)).ok_or(MarketError::MarketNotFound)
    }

    /// Mark a market resolved and sweep the pool when the winning side is empty.
    /// Shared by `resolve_market` and the optimistic oracle finalizers.
    fn apply_resolution(env: &Env, market: &mut Market, outcome: bool) {
        let winning_side = if outcome { market.total_yes } else { market.total_no };
        if winning_side == 0 {
            let total_pool = market.total_yes + market.total_no;
            if total_pool > 0 {
                let mut acc: i128 = env.storage().instance()
                    .get(&DataKey::AccumulatedFees).unwrap_or(0);
                acc += total_pool;
                env.storage().instance().set(&DataKey::AccumulatedFees, &acc);
            }
        }

        market.resolved = true;
        market.outcome = outcome;
        let mkt_key = DataKey::Market(market.id);
        env.storage().persistent().set(&mkt_key, &*market);
        env.storage().persistent().extend_ttl(&mkt_key, TTL_BUMP, TTL_HIGH);
    }

    #[inline]
    fn load_submission(env: &Env, market_id: u64) -> Result<OracleSubmission, MarketError> {
        env.storage().persistent()
            .get(&DataKey::Submission(market_id))
            .ok_or(MarketError::SubmissionNotFound)
    }

    #[inline]
    fn store_submission(env: &Env, submission: &OracleSubmission) {
        // Persist the oracle submission and extend its TTL. Called at every state
        // transition (submit, challenge, resolve, finalize) to ensure the entry
        // remains alive throughout the dispute window. See Issue #533 for TTL strategy.
        let key = DataKey::Submission(submission.market_id);
        env.storage().persistent().set(&key, submission);
        env.storage().persistent().extend_ttl(&key, TTL_BUMP, TTL_HIGH);
    }

    #[inline]
    fn require_admin(env: &Env, caller: &Address) -> Result<(), MarketError> {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).ok_or(MarketError::NotInitialized)?;
        if *caller != admin { return Err(MarketError::NotAdmin); }
        Ok(())
    }

    fn require_admin_or_resolver(env: &Env, caller: &Address) -> Result<(), MarketError> {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).ok_or(MarketError::NotInitialized)?;
        if *caller == admin { return Ok(()); }
        if env.storage().persistent().get(&DataKey::Resolver(caller.clone())).unwrap_or(false) {
            return Ok(());
        }
        Err(MarketError::NotResolver)
    }

    fn require_admin_or_fee_recipient(env: &Env, caller: &Address) -> Result<(), MarketError> {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).ok_or(MarketError::NotInitialized)?;
        if *caller == admin { return Ok(()); }
        if env.storage().persistent().get(&DataKey::FeeRecipient(caller.clone())).unwrap_or(false) {
            return Ok(());
        }
        Err(MarketError::NotAuthorized)
    }

    // OPT: CreationWindow packed into two u32s stored as separate u32 keys
    // to avoid struct serialization. Actually simpler: store as (u64, u32) tuple
    // via a single key — Soroban serializes tuples efficiently.
    fn check_rate(env: &Env) -> Result<(), MarketError> {
        let now = env.ledger().timestamp();
        // (window_start, count) packed — 1 read instead of 1 struct deserialize
        let (ws, cnt): (u64, u32) = env.storage().instance()
            .get(&DataKey::RateWindow)
            .unwrap_or((now, 0));

        let (new_ws, new_cnt) = if now - ws < 3600 {
            if cnt >= MAX_MARKETS_PER_HOUR { return Err(MarketError::RateLimitExceeded); }
            (ws, cnt + 1)
        } else {
            (now, 1)
        };
        env.storage().instance().set(&DataKey::RateWindow, &(new_ws, new_cnt));
        Ok(())
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod test;
