#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    token::{Client as TokenClient, StellarAssetClient},
    Env, String,
};

use ipredict_token::IPredictTokenContract;
use leaderboard::LeaderboardContract;
use referral_registry::ReferralRegistryContract;

// ── Test Infrastructure ───────────────────────────────────────────────────────

struct TestSetup {
    env: Env,
    client: PredictionMarketContractClient<'static>,
    admin: Address,
    market_id: Address,
    token_id: Address,
    leaderboard_id: Address,
    referral_id: Address,
    xlm_sac_id: Address,
    xlm_admin: StellarAssetClient<'static>,
    xlm: TokenClient<'static>,
    token_client: ipredict_token::IPredictTokenContractClient<'static>,
    leaderboard_client: leaderboard::LeaderboardContractClient<'static>,
    referral_client: referral_registry::ReferralRegistryContractClient<'static>,
}

fn setup() -> TestSetup {
    let env = Env::default();
    env.mock_all_auths();
    env.budget().reset_unlimited();

    // Set ledger timestamp to something reasonable
    env.ledger().set(LedgerInfo {
        timestamp: 1_000_000,
        protocol_version: 20,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 100,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 1_000_000,
    });

    let admin = Address::generate(&env);

    // Deploy XLM SAC
    let xlm_sac_id = env.register_stellar_asset_contract(admin.clone());
    let xlm_admin = StellarAssetClient::new(&env, &xlm_sac_id);
    let xlm = TokenClient::new(&env, &xlm_sac_id);

    // Deploy IPREDICT Token
    let token_id = env.register_contract(None, IPredictTokenContract);
    let token_client = ipredict_token::IPredictTokenContractClient::new(&env, &token_id);
    token_client.initialize(
        &admin,
        &String::from_str(&env, "IPREDICT"),
        &String::from_str(&env, "IPRED"),
        &7u32,
    );

    // Deploy Leaderboard
    let leaderboard_id = env.register_contract(None, LeaderboardContract);
    let leaderboard_client = leaderboard::LeaderboardContractClient::new(&env, &leaderboard_id);

    // Deploy ReferralRegistry
    let referral_id = env.register_contract(None, ReferralRegistryContract);
    let referral_client =
        referral_registry::ReferralRegistryContractClient::new(&env, &referral_id);

    // Deploy PredictionMarket
    let market_id = env.register_contract(None, PredictionMarketContract);
    let client = PredictionMarketContractClient::new(&env, &market_id);

    // Initialize PredictionMarket
    client.initialize(
        &admin,
        &token_id,
        &referral_id,
        &leaderboard_id,
        &xlm_sac_id,
    );

    // Initialize Leaderboard: market + referral as authorized callers
    leaderboard_client.initialize(&admin, &market_id, &referral_id);

    // Initialize ReferralRegistry: market + token + leaderboard + xlm_sac
    referral_client.initialize(&admin, &market_id, &token_id, &leaderboard_id, &xlm_sac_id);

    // Set authorized minters on token: prediction_market + referral_registry
    token_client.set_minter(&market_id);
    token_client.set_minter(&referral_id);

    TestSetup {
        env,
        client,
        admin,
        market_id,
        token_id,
        leaderboard_id,
        referral_id,
        xlm_sac_id,
        xlm_admin,
        xlm,
        token_client,
        leaderboard_client,
        referral_client,
    }
}

/// Fund a user with XLM for betting
fn fund_user(t: &TestSetup, user: &Address, amount: i128) {
    t.xlm_admin.mint(user, &amount);
}

/// Create a market with 1-hour duration and return its ID
fn create_test_market(t: &TestSetup) -> u64 {
    t.client.create_market(
        &t.admin,
        &String::from_str(&t.env, "Will BTC hit 100k?"),
        &String::from_str(&t.env, "https://example.com/btc.png"),
        &3600_u64, // 1 hour
    )
}

/// Advance ledger timestamp
fn advance_time(env: &Env, secs: u64) {
    let current = env.ledger().timestamp();
    env.ledger().set(LedgerInfo {
        timestamp: current + secs,
        protocol_version: 20,
        sequence_number: env.ledger().sequence() + 1,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 100,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 1_000_000,
    });
}

// ── 1. Initialize contract with linked addresses ──────────────────────────────

#[test]
fn test_initialize() {
    let t = setup();
    assert_eq!(t.client.get_market_count(), 0);
    assert_eq!(t.client.get_accumulated_fees(), 0);
}

// ── 2. Create market successfully ─────────────────────────────────────────────

#[test]
fn test_create_market() {
    let t = setup();
    let id = create_test_market(&t);
    assert_eq!(id, 1);
    assert_eq!(t.client.get_market_count(), 1);

    let market = t.client.get_market(&id);
    assert_eq!(market.total_yes, 0);
    assert_eq!(market.total_no, 0);
    assert!(!market.resolved);
    assert!(!market.cancelled);
    assert_eq!(market.bet_count, 0);
}

// ── 3. Place YES bet — verify net amount added to totals ──────────────────────

#[test]
fn test_place_yes_bet() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000); // 200 XLM

    t.client.place_bet(&user, &id, &true, &100_0000000_i128);

    // net = 100 - 2% = 98 XLM
    let market = t.client.get_market(&id);
    assert_eq!(market.total_yes, 98_0000000);
    assert_eq!(market.total_no, 0);
    assert_eq!(market.bet_count, 1);

    let bet = t.client.get_bet(&id, &user);
    assert_eq!(bet.amount, 98_0000000);
    assert!(bet.is_yes);
    assert!(!bet.claimed);
}

// ── 4. Place NO bet — verify net amount added to totals ───────────────────────

#[test]
fn test_place_no_bet() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);

    t.client.place_bet(&user, &id, &false, &100_0000000_i128);

    let market = t.client.get_market(&id);
    assert_eq!(market.total_yes, 0);
    assert_eq!(market.total_no, 98_0000000); // 100 - 2% fee
}

// ── 5. Fee split: 1.5% to AccumulatedFees when no referrer ───────────────────
// With no referrer, full 2% goes to AccumulatedFees (1.5% platform + 0.5% referral)

#[test]
fn test_fee_full_2_percent_no_referrer() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);

    t.client.place_bet(&user, &id, &true, &100_0000000_i128);

    // total_fee = 100 * 200 / 10000 = 2 XLM
    // platform_fee = 100 * 150 / 10000 = 1.5 XLM
    // referral_fee = 0.5 XLM
    // No referrer → full 2 XLM in AccumulatedFees
    assert_eq!(t.client.get_accumulated_fees(), 2_0000000);
}

// ── 6. Fee split: 1.5% + referrer gets 0.5% ──────────────────────────────────

#[test]
fn test_fee_split_with_referrer() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    let referrer = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);

    // Register user with referrer
    t.referral_client.register_referral(
        &user,
        &String::from_str(&t.env, "Bettor"),
        &Some(referrer.clone()),
    );

    t.client.place_bet(&user, &id, &true, &100_0000000_i128);

    // Platform keeps 1.5 XLM
    assert_eq!(t.client.get_accumulated_fees(), 1_5000000);

    // Referrer received 0.5 XLM
    assert_eq!(t.xlm.balance(&referrer), 5000000);

    // Referrer got 3 bonus points
    assert_eq!(t.leaderboard_client.get_points(&referrer), 3);
}

// ── 7. Reject bet on expired market ───────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_reject_bet_expired_market() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);

    // Advance past deadline
    advance_time(&t.env, 3601);

    t.client.place_bet(&user, &id, &true, &100_0000000_i128);
}

// ── 8. Reject bet on resolved market ──────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn test_reject_bet_resolved_market() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);

    // Bet, advance time, resolve
    t.client.place_bet(&user, &id, &true, &50_0000000_i128);
    advance_time(&t.env, 3601);
    t.client.resolve_market(&t.admin, &id, &true);

    // Try to bet again
    let user2 = Address::generate(&t.env);
    fund_user(&t, &user2, 200_0000000);
    t.client.place_bet(&user2, &id, &false, &50_0000000_i128);
}

// ── 9. Reject bet on cancelled market ─────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn test_reject_bet_cancelled_market() {
    let t = setup();
    let id = create_test_market(&t);

    t.client.cancel_market(&t.admin, &id);

    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);
    t.client.place_bet(&user, &id, &true, &100_0000000_i128);
}

// ── 10. Reject bet below minimum (< 1 XLM) ───────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn test_reject_bet_below_minimum() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);

    // 0.5 XLM < 1 XLM minimum
    t.client.place_bet(&user, &id, &true, &5_000_000_i128);
}

// ── 11. Increase existing YES position ────────────────────────────────────────

#[test]
fn test_increase_position_same_side() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 500_0000000);

    // First bet: 100 XLM → net 98
    t.client.place_bet(&user, &id, &true, &100_0000000_i128);
    assert_eq!(t.client.get_bet(&id, &user).amount, 98_0000000);

    // Increase: 50 XLM → net 49
    t.client.place_bet(&user, &id, &true, &50_0000000_i128);
    assert_eq!(t.client.get_bet(&id, &user).amount, 98_0000000 + 49_0000000);

    // Market totals reflect cumulative
    let market = t.client.get_market(&id);
    assert_eq!(market.total_yes, 98_0000000 + 49_0000000);
    assert_eq!(market.bet_count, 1); // still 1 bettor
}

// ── 12. Reject opposite-side bet ──────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn test_reject_opposite_side_bet() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 500_0000000);

    t.client.place_bet(&user, &id, &true, &100_0000000_i128);
    // Try to bet NO — should fail
    t.client.place_bet(&user, &id, &false, &50_0000000_i128);
}

// ── 13. Resolve market and verify state ───────────────────────────────────────

#[test]
fn test_resolve_market() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);
    t.client.place_bet(&user, &id, &true, &50_0000000_i128);

    advance_time(&t.env, 3601);
    t.client.resolve_market(&t.admin, &id, &true);

    let market = t.client.get_market(&id);
    assert!(market.resolved);
    assert!(market.outcome); // YES
}

// ── 14. Reject double resolution ──────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn test_reject_double_resolution() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);
    t.client.place_bet(&user, &id, &true, &50_0000000_i128);

    advance_time(&t.env, 3601);
    t.client.resolve_market(&t.admin, &id, &true);
    t.client.resolve_market(&t.admin, &id, &false); // should fail
}

// ── 15. Cancel market — verify all bettors refunded net amounts ───────────────

#[test]
fn test_cancel_market_with_refunds() {
    let t = setup();
    let id = create_test_market(&t);
    let alice = Address::generate(&t.env);
    let bob = Address::generate(&t.env);
    fund_user(&t, &alice, 200_0000000);
    fund_user(&t, &bob, 200_0000000);

    t.client.place_bet(&alice, &id, &true, &100_0000000_i128);
    t.client.place_bet(&bob, &id, &false, &50_0000000_i128);

    let alice_after_bet = t.xlm.balance(&alice); // 200 - 100 = 100
    let bob_after_bet = t.xlm.balance(&bob); // 200 - 50 = 150

    t.client.cancel_market(&t.admin, &id);

    let market = t.client.get_market(&id);
    assert!(market.cancelled);

    // Alice gets 98 XLM back (net), Bob gets 49 XLM back (net)
    assert_eq!(t.xlm.balance(&alice), alice_after_bet + 98_0000000);
    assert_eq!(t.xlm.balance(&bob), bob_after_bet + 49_0000000);
}

// ── 16. Reject cancel on already resolved market ──────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn test_reject_cancel_resolved_market() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);
    t.client.place_bet(&user, &id, &true, &50_0000000_i128);

    advance_time(&t.env, 3601);
    t.client.resolve_market(&t.admin, &id, &true);
    t.client.cancel_market(&t.admin, &id); // should fail
}

// ── 17. Claim as winner — verify XLM payout + points + tokens ─────────────────

#[test]
fn test_claim_winner() {
    let t = setup();
    let id = create_test_market(&t);
    let alice = Address::generate(&t.env);
    let bob = Address::generate(&t.env);
    fund_user(&t, &alice, 200_0000000);
    fund_user(&t, &bob, 200_0000000);

    // Alice bets 100 XLM YES → net 98
    t.client.place_bet(&alice, &id, &true, &100_0000000_i128);
    // Bob bets 100 XLM NO → net 98
    t.client.place_bet(&bob, &id, &false, &100_0000000_i128);

    let alice_pre_claim = t.xlm.balance(&alice); // 100 XLM remaining

    advance_time(&t.env, 3601);
    t.client.resolve_market(&t.admin, &id, &true); // YES wins

    t.client.claim(&alice, &id);

    // Alice's payout = (98 * 196) / 98 = 196 XLM (the full pool)
    let alice_post_claim = t.xlm.balance(&alice);
    let payout = alice_post_claim - alice_pre_claim;
    assert_eq!(payout, 196_0000000); // full pool

    // Winner: 30 pts on leaderboard
    // Also 1 record_bet from place_bet → total_bets = 1
    let stats = t.leaderboard_client.get_stats(&alice);
    assert_eq!(stats.won_bets, 1);

    // Winner: 10 IPREDICT tokens
    assert_eq!(t.token_client.balance(&alice), 10_0000000);
}

// ── 18. Claim as loser — no XLM but gets points & tokens ─────────────────────

#[test]
fn test_claim_loser() {
    let t = setup();
    let id = create_test_market(&t);
    let alice = Address::generate(&t.env);
    let bob = Address::generate(&t.env);
    fund_user(&t, &alice, 200_0000000);
    fund_user(&t, &bob, 200_0000000);

    t.client.place_bet(&alice, &id, &true, &100_0000000_i128);
    t.client.place_bet(&bob, &id, &false, &100_0000000_i128);

    let bob_pre_claim = t.xlm.balance(&bob);

    advance_time(&t.env, 3601);
    t.client.resolve_market(&t.admin, &id, &true); // YES wins; Bob loses

    t.client.claim(&bob, &id);

    // Bob gets no XLM
    assert_eq!(t.xlm.balance(&bob), bob_pre_claim);

    // Loser: 10 pts
    let stats = t.leaderboard_client.get_stats(&bob);
    assert_eq!(stats.lost_bets, 1);

    // Loser: 2 IPREDICT tokens
    assert_eq!(t.token_client.balance(&bob), 2_0000000);
}

// ── 19. Reject double claim ──────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn test_reject_double_claim() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);
    t.client.place_bet(&user, &id, &true, &100_0000000_i128);

    advance_time(&t.env, 3601);
    t.client.resolve_market(&t.admin, &id, &true);

    t.client.claim(&user, &id);
    t.client.claim(&user, &id); // should fail
}

// ── 20. Reject claim on unresolved market ─────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn test_reject_claim_unresolved() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);
    t.client.place_bet(&user, &id, &true, &100_0000000_i128);

    t.client.claim(&user, &id);
}

// ── 21. Reject claim on cancelled market ──────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn test_reject_claim_cancelled() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);
    t.client.place_bet(&user, &id, &true, &100_0000000_i128);

    t.client.cancel_market(&t.admin, &id);
    t.client.claim(&user, &id); // should fail
}

// ── 22. Get odds calculation accuracy ─────────────────────────────────────────

#[test]
fn test_get_odds() {
    let t = setup();
    let id = create_test_market(&t);

    // No bets: 50/50
    let odds = t.client.get_odds(&id);
    assert_eq!(odds.yes_percent, 50);
    assert_eq!(odds.no_percent, 50);

    let alice = Address::generate(&t.env);
    let bob = Address::generate(&t.env);
    fund_user(&t, &alice, 500_0000000);
    fund_user(&t, &bob, 500_0000000);

    // 300 YES → net 294, 100 NO → net 98
    t.client.place_bet(&alice, &id, &true, &300_0000000_i128);
    t.client.place_bet(&bob, &id, &false, &100_0000000_i128);

    let odds = t.client.get_odds(&id);
    // 294 / (294+98) = 294/392 ≈ 75%
    assert_eq!(odds.yes_percent, 75);
    assert_eq!(odds.no_percent, 25);
}

// ── 23. Admin withdraw_fees ───────────────────────────────────────────────────

#[test]
fn test_withdraw_fees() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);

    t.client.place_bet(&user, &id, &true, &100_0000000_i128);

    let fees_before = t.client.get_accumulated_fees();
    assert!(fees_before > 0);

    let admin_xlm_before = t.xlm.balance(&t.admin);
    let withdrawn = t.client.withdraw_fees(&t.admin);
    assert_eq!(withdrawn, fees_before);

    assert_eq!(t.client.get_accumulated_fees(), 0);
    assert_eq!(t.xlm.balance(&t.admin), admin_xlm_before + fees_before);
}

// ── 24. Reject withdraw_fees by non-admin ─────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_reject_withdraw_fees_non_admin() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);
    t.client.place_bet(&user, &id, &true, &100_0000000_i128);

    let rando = Address::generate(&t.env);
    t.client.withdraw_fees(&rando); // should fail
}

// ── 25. BettorCount and BettorAt indexed enumeration ──────────────────────────

#[test]
fn test_bettor_index_enumeration() {
    let t = setup();
    let id = create_test_market(&t);

    let alice = Address::generate(&t.env);
    let bob = Address::generate(&t.env);
    let charlie = Address::generate(&t.env);
    fund_user(&t, &alice, 200_0000000);
    fund_user(&t, &bob, 200_0000000);
    fund_user(&t, &charlie, 200_0000000);

    t.client.place_bet(&alice, &id, &true, &10_0000000_i128);
    t.client.place_bet(&bob, &id, &false, &20_0000000_i128);
    t.client.place_bet(&charlie, &id, &true, &30_0000000_i128);

    let bettors = t.client.get_market_bettors(&id);
    assert_eq!(bettors.len(), 3);
    assert_eq!(bettors.get(0).unwrap(), alice);
    assert_eq!(bettors.get(1).unwrap(), bob);
    assert_eq!(bettors.get(2).unwrap(), charlie);
}

// ── 26. Referrer earns 3 bonus points per referred bet ────────────────────────

#[test]
fn test_referrer_bonus_points_per_bet() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    let referrer = Address::generate(&t.env);
    fund_user(&t, &user, 500_0000000);

    // Register user with referrer
    t.referral_client.register_referral(
        &user,
        &String::from_str(&t.env, "Fan"),
        &Some(referrer.clone()),
    );

    // Place 3 bets (2 new + 1 increase)
    t.client.place_bet(&user, &id, &true, &100_0000000_i128);
    t.client.place_bet(&user, &id, &true, &50_0000000_i128); // increase

    // Each bet call → credit → 3 pts to referrer = 6 pts total
    assert_eq!(t.leaderboard_client.get_points(&referrer), 6);
}

// ── 27. Double initialization rejected ────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn test_double_init_rejected() {
    let t = setup();
    let tok2 = Address::generate(&t.env);
    let ref2 = Address::generate(&t.env);
    let lb2 = Address::generate(&t.env);
    let xlm2 = Address::generate(&t.env);
    t.client
        .initialize(&t.admin, &tok2, &ref2, &lb2, &xlm2);
}

// ── 28. Resolve before deadline rejected ──────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn test_reject_resolve_before_deadline() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);
    t.client.place_bet(&user, &id, &true, &50_0000000_i128);

    // Don't advance time — should fail
    t.client.resolve_market(&t.admin, &id, &true);
}

// ── 29. Withdraw fees when zero — NoFeesToWithdraw ────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #15)")]
fn test_withdraw_fees_zero() {
    let t = setup();
    // No bets placed → AccumulatedFees = 0
    t.client.withdraw_fees(&t.admin);
}

// ── 30. Claim with no bet → NoBetFound ────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #13)")]
fn test_claim_no_bet_found() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);
    t.client.place_bet(&user, &id, &true, &50_0000000_i128);

    advance_time(&t.env, 3601);
    t.client.resolve_market(&t.admin, &id, &true);

    // Stranger who never bet tries to claim
    let stranger = Address::generate(&t.env);
    t.client.claim(&stranger, &id);
}

// ── 31. Non-admin create market rejected ──────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_reject_create_market_non_admin() {
    let t = setup();
    let rando = Address::generate(&t.env);
    t.client.create_market(
        &rando,
        &String::from_str(&t.env, "Unauthorized?"),
        &String::from_str(&t.env, "https://x.png"),
        &3600_u64,
    );
}

// ── 32. Non-admin resolve rejected ────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_reject_resolve_market_non_admin() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);
    t.client.place_bet(&user, &id, &true, &50_0000000_i128);

    advance_time(&t.env, 3601);
    let rando = Address::generate(&t.env);
    t.client.resolve_market(&rando, &id, &true);
}

// ── 33. Non-admin cancel rejected ─────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_reject_cancel_market_non_admin() {
    let t = setup();
    let id = create_test_market(&t);
    let rando = Address::generate(&t.env);
    t.client.cancel_market(&rando, &id);
}

// ── 34. Market not found ──────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_market_not_found() {
    let t = setup();
    t.client.get_market(&999);
}

// ── 35. Multiple markets created with correct IDs ─────────────────────────────

#[test]
fn test_create_multiple_markets() {
    let t = setup();
    let id1 = t.client.create_market(
        &t.admin,
        &String::from_str(&t.env, "Market A"),
        &String::from_str(&t.env, "https://a.png"),
        &3600_u64,
    );
    let id2 = t.client.create_market(
        &t.admin,
        &String::from_str(&t.env, "Market B"),
        &String::from_str(&t.env, "https://b.png"),
        &7200_u64,
    );
    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
    assert_eq!(t.client.get_market_count(), 2);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 36. COMPREHENSIVE END-TO-END INTEGRATION TEST
// Exercises the full inter-contract flow in a single test, matching the
// architecture doc flow exactly.
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_e2e_full_inter_contract_flow() {
    let t = setup();

    // ── Setup complete: all 4 contracts deployed, initialized, cross-linked ──

    let alice = Address::generate(&t.env);
    let bob = Address::generate(&t.env);
    let referrer = Address::generate(&t.env);
    fund_user(&t, &alice, 1000_0000000);
    fund_user(&t, &bob, 1000_0000000);

    // ── STEP 1: Register alice with a referrer ───────────────────────────
    t.referral_client.register_referral(
        &alice,
        &String::from_str(&t.env, "Alice"),
        &Some(referrer.clone()),
    );
    // Welcome bonus: 5 pts + 1 IPRED for alice
    assert_eq!(t.leaderboard_client.get_points(&alice), 5);
    assert_eq!(t.token_client.balance(&alice), 1_0000000);

    // bob does NOT register → no referrer → platform keeps full 2%

    // ── STEP 2: Create a market ──────────────────────────────────────────
    let market_id = t.client.create_market(
        &t.admin,
        &String::from_str(&t.env, "Will ETH flip BTC?"),
        &String::from_str(&t.env, "https://eth.png"),
        &3600_u64,
    );
    assert_eq!(market_id, 1);

    // ── STEP 3: Alice places a YES bet (100 XLM) — has referrer ──────────
    t.client.place_bet(&alice, &market_id, &true, &100_0000000_i128);

    // Fee: 2 XLM total, 1.5 XLM platform, 0.5 XLM referral
    // Alice has referrer → 1.5 to AccumulatedFees, 0.5 to referrer
    assert_eq!(t.client.get_accumulated_fees(), 1_5000000);
    assert_eq!(t.xlm.balance(&referrer), 5000000); // 0.5 XLM
    // Referrer got 3 bonus pts
    assert_eq!(t.leaderboard_client.get_points(&referrer), 3);
    // Alice's leaderboard: record_bet called
    let alice_stats = t.leaderboard_client.get_stats(&alice);
    assert_eq!(alice_stats.total_bets, 1);
    // Market totals
    let mkt = t.client.get_market(&market_id);
    assert_eq!(mkt.total_yes, 98_0000000); // net
    assert_eq!(mkt.total_no, 0);

    // ── STEP 4: Bob places a NO bet (200 XLM) — no referrer ─────────────
    t.client.place_bet(&bob, &market_id, &false, &200_0000000_i128);

    // Bob has no referrer → full 2% (4 XLM) → AccumulatedFees
    // Previous: 1.5, now: 1.5 + 4.0 = 5.5
    assert_eq!(t.client.get_accumulated_fees(), 5_5000000);
    let bob_stats = t.leaderboard_client.get_stats(&bob);
    assert_eq!(bob_stats.total_bets, 1);
    let mkt = t.client.get_market(&market_id);
    assert_eq!(mkt.total_no, 196_0000000); // 200 - 4

    // ── STEP 5: Alice increases YES position (+50 XLM) ───────────────────
    t.client.place_bet(&alice, &market_id, &true, &50_0000000_i128);

    let alice_bet = t.client.get_bet(&market_id, &alice);
    assert_eq!(alice_bet.amount, 98_0000000 + 49_0000000); // 147
    assert!(alice_bet.is_yes);
    let mkt = t.client.get_market(&market_id);
    assert_eq!(mkt.total_yes, 147_0000000);
    assert_eq!(mkt.bet_count, 2); // alice + bob
    // Referrer got another 3 pts → 6 total
    assert_eq!(t.leaderboard_client.get_points(&referrer), 6);
    // Alice total_bets incremented again
    assert_eq!(t.leaderboard_client.get_stats(&alice).total_bets, 2);

    // ── STEP 7: Resolve market → YES wins ────────────────────────────────
    advance_time(&t.env, 3601);
    t.client.resolve_market(&t.admin, &market_id, &true);
    let mkt = t.client.get_market(&market_id);
    assert!(mkt.resolved);
    assert!(mkt.outcome);

    // ── STEP 8: Alice claims as winner ───────────────────────────────────
    let alice_xlm_before = t.xlm.balance(&alice);
    t.client.claim(&alice, &market_id);

    // Total pool = 147 + 196 = 343 XLM (net)
    let alice_payout = t.xlm.balance(&alice) - alice_xlm_before;
    assert_eq!(alice_payout, 343_0000000);

    assert_eq!(t.leaderboard_client.get_points(&alice), 35);
    assert_eq!(t.token_client.balance(&alice), 11_0000000);

    // ── STEP 9: Bob claims as loser ──────────────────────────────────────
    let bob_xlm_before = t.xlm.balance(&bob);
    t.client.claim(&bob, &market_id);
    assert_eq!(t.xlm.balance(&bob), bob_xlm_before);
    assert_eq!(t.leaderboard_client.get_points(&bob), 10);
    assert_eq!(t.token_client.balance(&bob), 2_0000000);

    // ── STEP 10: Cancel a different market → verify refunds ──────────────
    let market2 = t.client.create_market(
        &t.admin,
        &String::from_str(&t.env, "Will DOGE hit $1?"),
        &String::from_str(&t.env, "https://doge.png"),
        &7200_u64,
    );
    let charlie = Address::generate(&t.env);
    fund_user(&t, &charlie, 500_0000000);
    t.client.place_bet(&charlie, &market2, &true, &100_0000000_i128);
    let charlie_after_bet = t.xlm.balance(&charlie);

    t.client.cancel_market(&t.admin, &market2);
    assert_eq!(t.xlm.balance(&charlie), charlie_after_bet + 98_0000000);
    assert!(t.client.get_market(&market2).cancelled);

    // ── STEP 11: Admin withdraws accumulated fees ────────────────────────
    let fees_total = t.client.get_accumulated_fees();
    assert!(fees_total > 0);
    let admin_xlm_before = t.xlm.balance(&t.admin);
    let withdrawn = t.client.withdraw_fees(&t.admin);
    assert_eq!(withdrawn, fees_total);
    assert_eq!(t.client.get_accumulated_fees(), 0);
    assert_eq!(t.xlm.balance(&t.admin), admin_xlm_before + fees_total);
}
