#![cfg(test)]

//! Focused unit tests for the optimistic-oracle state machine
//! (see docs/ORACLE_AND_BACKEND.md — Option B).
//!
//! These complement the snapshot tests in `tests.rs` with explicit assertions
//! on the state transitions of `OracleSubmission`:
//!
//!   Submitted ──(challenge)──> Escalated ──(council ruling)──> Finalized
//!   Submitted ──(window elapsed)──> Finalized
//!
//! Rejections encode the expected `MarketError` as `Error(Contract, #N)` so the
//! failures are deterministic and match the panic strings used across `tests.rs`.

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, String,
};

use ipredict_token::IPredictTokenContract;
use leaderboard::LeaderboardContract;
use referral_registry::ReferralRegistryContract;

struct OracleTest {
    env: Env,
    client: PredictionMarketContractClient<'static>,
    admin: Address,
    market_id: u64,
    xlm_admin: StellarAssetClient<'static>,
    xlm: TokenClient<'static>,
}

fn setup() -> OracleTest {
    let env = Env::default();
    env.mock_all_auths();
    env.budget().reset_unlimited();

    env.ledger().set(LedgerInfo {
        timestamp: 1_000_000,
        protocol_version: 26,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 100,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 10_000_000,
    });

    let admin = Address::generate(&env);
    let xlm_sac_id = env.register_stellar_asset_contract(admin.clone());
    let xlm_admin = StellarAssetClient::new(&env, &xlm_sac_id);
    let xlm = TokenClient::new(&env, &xlm_sac_id);

    let token_id = env.register_contract(None, IPredictTokenContract);
    let leaderboard_id = env.register_contract(None, LeaderboardContract);
    let referral_id = env.register_contract(None, ReferralRegistryContract);

    let market_id = env.register_contract(None, PredictionMarketContract);
    let client = PredictionMarketContractClient::new(&env, &market_id);

    client.initialize(&admin, &token_id, &referral_id, &leaderboard_id, &xlm_sac_id);

    let market = create_market(&env, &client, &admin);
    OracleTest {
        env,
        client,
        admin,
        market_id: market,
        xlm_admin,
        xlm,
    }
}

fn create_market(env: &Env, client: &PredictionMarketContractClient<'static>, admin: &Address) -> u64 {
    client.create_market(
        admin,
        &String::from_str(env, "Will BTC hit 100k?"),
        &String::from_str(env, "https://example.com/btc.png"),
        &Category::Crypto,
        &3600_u64,
    )
}

fn fund(t: &OracleTest, who: &Address, amount: i128) {
    t.xlm_admin.mint(who, &amount);
}

fn advance(env: &Env, secs: u64) {
    let current = env.ledger().timestamp();
    env.ledger().set(LedgerInfo {
        timestamp: current + secs,
        protocol_version: 26,
        sequence_number: env.ledger().sequence() + 1,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 100,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 10_000_000,
    });
}

// Expire the market (end_time = now + 3600) so the oracle window opens.
fn expire_market(t: &OracleTest) {
    advance(&t.env, 3601);
}

/// A funded, arbitrary caller with enough XLM to post any bond.
fn rand_user(t: &OracleTest) -> Address {
    let who = Address::generate(&t.env);
    fund(t, &who, 1_000_0000000);
    who
}

/// Submit an outcome with the minimum bond on an expired market, returning the
/// submitter (funded with enough XLM for the bond).
fn submit(t: &OracleTest, market_id: u64, wait_for_expiry: bool) -> Address {
    let submitter = rand_user(t);
    if wait_for_expiry {
        expire_market(t);
    }
    t.client.submit_outcome(&submitter, &market_id, &true, &SUBMITTER_BOND);
    submitter
}

/// Escalate the current submission by challenging it with the minimum dispute
/// bond, returning the challenger.
fn escalate(t: &OracleTest) -> Address {
    let challenger = rand_user(t);
    t.client.challenge(&challenger, &t.market_id, &DISPUTER_BOND);
    challenger
}

// ── Setup / validation of the initial Submitted state ────────────────────────

#[test]
fn submit_opens_submission_in_submitted_state() {
    let t = setup();
    let submitter = submit(&t, t.market_id, true);

    let sub = t.client.get_oracle_submission(&t.market_id);
    assert_eq!(sub.state, OracleState::Submitted);
    assert_eq!(sub.submitter, submitter);
    assert_eq!(sub.outcome, true);
    assert_eq!(sub.bond, SUBMITTER_BOND);
    assert_eq!(sub.submitted_at, t.env.ledger().timestamp());
    assert_eq!(sub.challenge_deadline, sub.submitted_at + CHALLENGE_WINDOW);
    assert!(sub.challenger.is_none());
    assert_eq!(sub.challenger_bond, 0);
    assert_eq!(sub.escalated_at, 0);
    assert_eq!(sub.council_deadline, 0);
    assert_eq!(sub.finalized_at, 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")] // MarketNotExpired
fn submit_before_market_expiry_is_rejected() {
    let t = setup();
    // No advance_time: the market is still within its own window.
    let submitter = rand_user(&t);
    t.client.submit_outcome(&submitter, &t.market_id, &true, &SUBMITTER_BOND);
}

#[test]
#[should_panic(expected = "Error(Contract, #28)")] // OracleBondTooSmall
fn submit_with_bond_below_minimum_is_rejected() {
    let t = setup();
    expire_market(&t);
    let submitter = rand_user(&t);
    t.client.submit_outcome(&submitter, &t.market_id, &true, &(SUBMITTER_BOND - 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #21)")] // SubmissionExists
fn second_submission_on_same_market_is_rejected() {
    let t = setup();
    submit(&t, t.market_id, true);
    let other = rand_user(&t);
    t.client.submit_outcome(&other, &t.market_id, &false, &SUBMITTER_BOND);
}

// ── Submitted -> Escalated (challenge) ───────────────────────────────────────

#[test]
fn challenge_escalates_to_council_without_finalizing() {
    let t = setup();
    let _submitter = submit(&t, t.market_id, true);
    let challenger = escalate(&t);

    let sub = t.client.get_oracle_submission(&t.market_id);
    assert_eq!(sub.state, OracleState::Escalated);
    assert_eq!(sub.challenger, Some(challenger));
    assert_eq!(sub.challenger_bond, DISPUTER_BOND);
    assert_eq!(sub.escalated_at, t.env.ledger().timestamp());
    assert_eq!(sub.council_deadline, sub.escalated_at + COUNCIL_WINDOW);
    assert_eq!(sub.finalized_at, 0);
    // The submitter's asserted outcome is preserved while under dispute.
    assert_eq!(sub.outcome, true);
}

#[test]
#[should_panic(expected = "Error(Contract, #28)")] // OracleBondTooSmall
fn challenge_rejects_bond_not_strictly_larger_than_submitter() {
    let t = setup();
    submit(&t, t.market_id, true);
    let challenger = rand_user(&t);
    // Equal to the submitter bond is not strictly larger and not allowed.
    t.client.challenge(&challenger, &t.market_id, &SUBMITTER_BOND);
}

#[test]
#[should_panic(expected = "Error(Contract, #28)")] // OracleBondTooSmall
fn challenge_rejects_below_disputer_minimum() {
    let t = setup();
    submit(&t, t.market_id, true);
    let challenger = rand_user(&t);
    t.client.challenge(&challenger, &t.market_id, &(DISPUTER_BOND - 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #26)")] // OracleWindowClosed
fn challenge_after_window_elapsed_is_rejected() {
    let t = setup();
    submit(&t, t.market_id, true);
    // Move beyond the submission's challenge deadline.
    advance(&t.env, CHALLENGE_WINDOW + 1);
    let challenger = rand_user(&t);
    t.client.challenge(&challenger, &t.market_id, &DISPUTER_BOND);
}

#[test]
#[should_panic(expected = "Error(Contract, #23)")] // AlreadyChallenged
fn double_challenge_is_rejected() {
    let t = setup();
    submit(&t, t.market_id, true);
    escalate(&t);
    let other = rand_user(&t);
    t.client.challenge(&other, &t.market_id, &DISPUTER_BOND);
}

#[test]
#[should_panic(expected = "Error(Contract, #22)")] // SubmissionNotFound
fn challenge_without_submission_is_rejected() {
    let t = setup();
    expire_market(&t);
    let challenger = rand_user(&t);
    t.client.challenge(&challenger, &t.market_id, &DISPUTER_BOND);
}

// ── Submitted -> Finalized (unchallenged auto-finalize) ──────────────────────

#[test]
fn unchallenged_finalize_transitions_to_finalized() {
    let t = setup();
    submit(&t, t.market_id, true);
    advance(&t.env, CHALLENGE_WINDOW); // past the challenge deadline

    t.client.finalize_outcome(&t.market_id);

    let sub = t.client.get_oracle_submission(&t.market_id);
    assert_eq!(sub.state, OracleState::Finalized);
    assert_eq!(sub.finalized_at, t.env.ledger().timestamp());
    assert!(sub.challenger.is_none());

    let market = t.client.get_market(&t.market_id);
    assert!(market.resolved);
    assert_eq!(market.outcome, true);
}

#[test]
fn unchallenged_finalize_returns_submitter_bond_in_full() {
    let t = setup();
    let submitter = submit(&t, t.market_id, true);
    advance(&t.env, CHALLENGE_WINDOW);

    let bal_before = t.xlm.balance(&submitter);
    t.client.finalize_outcome(&t.market_id);
    let bal_after = t.xlm.balance(&submitter);

    // The bond comes back whole (no fees on the unchallenged path).
    assert_eq!(bal_after - bal_before, SUBMITTER_BOND);
}

#[test]
#[should_panic(expected = "Error(Contract, #24)")] // ChallengeWindowNotElapsed
fn finalize_before_challenge_window_elapsed_is_rejected() {
    let t = setup();
    submit(&t, t.market_id, true);
    // Still inside the window.
    t.client.finalize_outcome(&t.market_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #23)")] // AlreadyChallenged
fn finalize_an_escalated_submission_is_rejected() {
    let t = setup();
    submit(&t, t.market_id, true);
    escalate(&t);
    t.client.finalize_outcome(&t.market_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #27)")] // OracleInvalidState
fn double_finalize_is_rejected() {
    let t = setup();
    submit(&t, t.market_id, true);
    advance(&t.env, CHALLENGE_WINDOW);
    t.client.finalize_outcome(&t.market_id);
    // Second finalize on an already-finalized submission.
    t.client.finalize_outcome(&t.market_id);
}

// ── Escalated -> Finalized (council ruling) ──────────────────────────────────

#[test]
fn council_ruling_upholding_submitter_finalizes() {
    let t = setup();
    submit(&t, t.market_id, true); // submitter asserts `true`
    escalate(&t);

    // Council rules in the submitter's favour (outcome == submission.outcome).
    t.client.resolve_challenge(&t.admin, &t.market_id, &true);

    let sub = t.client.get_oracle_submission(&t.market_id);
    assert_eq!(sub.state, OracleState::Finalized);
    assert_eq!(sub.finalized_at, t.env.ledger().timestamp());

    let market = t.client.get_market(&t.market_id);
    assert!(market.resolved);
    assert_eq!(market.outcome, true);
}

#[test]
fn council_ruling_against_submitter_finalizes() {
    let t = setup();
    submit(&t, t.market_id, true); // submitter asserts `true`
    escalate(&t);

    t.client.resolve_challenge(&t.admin, &t.market_id, &false);

    let sub = t.client.get_oracle_submission(&t.market_id);
    assert_eq!(sub.state, OracleState::Finalized);

    let market = t.client.get_market(&t.market_id);
    assert_eq!(market.outcome, false);
}

#[test]
#[should_panic(expected = "Error(Contract, #16)")] // NotResolver
fn resolve_challenge_by_non_resolver_is_rejected() {
    let t = setup();
    submit(&t, t.market_id, true);
    escalate(&t);
    let random = rand_user(&t);
    t.client.resolve_challenge(&random, &t.market_id, &true);
}

#[test]
#[should_panic(expected = "Error(Contract, #27)")] // OracleInvalidState
fn resolve_challenge_when_not_escalated_is_rejected() {
    let t = setup();
    submit(&t, t.market_id, true); // still Submitted
    t.client.resolve_challenge(&t.admin, &t.market_id, &true);
}

// ── No fees accrue on the unchallenged auto-finalize path ────────────────────

#[test]
fn unchallenged_finalize_does_not_accumulate_fees() {
    let t = setup();
    submit(&t, t.market_id, true);
    advance(&t.env, CHALLENGE_WINDOW);
    t.client.finalize_outcome(&t.market_id);
    assert_eq!(t.client.get_accumulated_fees(), 0);
}
