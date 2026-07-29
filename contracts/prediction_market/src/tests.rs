#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger, LedgerInfo},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, Env, Event, String, Val, Vec,
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
    let token_client = ipredict_token::IPredictTokenContractClient::new(&env, &token_id);
    token_client.initialize(
        &admin,
        &String::from_str(&env, "IPREDICT"),
        &String::from_str(&env, "IPRED"),
        &7u32,
    );

    let leaderboard_id = env.register_contract(None, LeaderboardContract);
    let leaderboard_client = leaderboard::LeaderboardContractClient::new(&env, &leaderboard_id);

    let referral_id = env.register_contract(None, ReferralRegistryContract);
    let referral_client = referral_registry::ReferralRegistryContractClient::new(&env, &referral_id);

    let market_id = env.register_contract(None, PredictionMarketContract);
    let client = PredictionMarketContractClient::new(&env, &market_id);

    client.initialize(&admin, &token_id, &referral_id, &leaderboard_id, &xlm_sac_id);
    leaderboard_client.initialize(&admin, &market_id, &referral_id);
    referral_client.initialize(&admin, &market_id, &token_id, &leaderboard_id, &xlm_sac_id);

    // Lever G: the leaderboard now mints IPRED internally (one cross-call from
    // market/referral instead of two). It must know the token AND be authorized
    // as a minter. This mirrors the exact mainnet upgrade sequence.
    leaderboard_client.set_token(&admin, &token_id);
    token_client.set_minter(&leaderboard_id);
    // Legacy minter auths kept harmless (market/referral no longer mint directly).
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

fn fund_user(t: &TestSetup, user: &Address, amount: i128) {
    t.xlm_admin.mint(user, &amount);
}

fn create_test_market(t: &TestSetup) -> u64 {
    t.client.create_market(
        &t.admin,
        &String::from_str(&t.env, "Will BTC hit 100k?"),
        &String::from_str(&t.env, "https://example.com/btc.png"),
        &Category::Crypto,
        &3600_u64,
    )
}

fn advance_time(env: &Env, secs: u64) {
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

// ── 1. Initialize ─────────────────────────────────────────────────────────────

#[test]
fn test_initialize() {
    let t = setup();
    assert_eq!(t.client.get_market_count(), 0);
    assert_eq!(t.client.get_accumulated_fees(), 0);
}

// ── 2. Create market ─────────────────────────────────────────────────────────

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

// ── 3. Place YES bet ──────────────────────────────────────────────────────────

#[test]
fn test_place_yes_bet() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);

    t.client.place_bet(&user, &id, &true, &100_0000000_i128);

    let market = t.client.get_market(&id);
    assert_eq!(market.total_yes, 98_0000000);
    assert_eq!(market.total_no, 0);
    assert_eq!(market.bet_count, 1);

    let bet = t.client.get_bet(&id, &user);
    assert_eq!(bet.amount, 98_0000000);
    assert!(bet.is_yes);
    assert!(!bet.claimed);

    // Gross tracked correctly
    assert_eq!(t.client.get_bet_gross(&id, &user), 100_0000000);
}

// ── 4. Place NO bet ───────────────────────────────────────────────────────────

#[test]
fn test_place_no_bet() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);

    t.client.place_bet(&user, &id, &false, &100_0000000_i128);

    let market = t.client.get_market(&id);
    assert_eq!(market.total_yes, 0);
    assert_eq!(market.total_no, 98_0000000);
}

// ── 5. Fee: full 2% to AccumulatedFees when no referrer ──────────────────────

#[test]
fn test_fee_full_2_percent_no_referrer() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);

    t.client.place_bet(&user, &id, &true, &100_0000000_i128);
    assert_eq!(t.client.get_accumulated_fees(), 2_0000000);
}

// ── 6. Fee split with referrer ────────────────────────────────────────────────

#[test]
fn test_fee_split_with_referrer() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    let referrer = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);

    t.referral_client.register_referral(
        &user,
        &String::from_str(&t.env, "Bettor"),
        &Some(referrer.clone()),
    );

    t.client.place_bet(&user, &id, &true, &100_0000000_i128);

    assert_eq!(t.client.get_accumulated_fees(), 1_5000000);
    assert_eq!(t.xlm.balance(&referrer), 5000000);
    assert_eq!(t.leaderboard_client.get_points(&referrer), 3);
}

// ── 7. Reject bet on expired market ──────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_reject_bet_expired_market() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);
    advance_time(&t.env, 3601);
    t.client.place_bet(&user, &id, &true, &100_0000000_i128);
}

// ── 8. Reject bet on resolved market ─────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn test_reject_bet_resolved_market() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);
    t.client.place_bet(&user, &id, &true, &50_0000000_i128);
    advance_time(&t.env, 3601);
    t.client.resolve_market(&t.admin, &id, &true);

    let user2 = Address::generate(&t.env);
    fund_user(&t, &user2, 200_0000000);
    t.client.place_bet(&user2, &id, &false, &50_0000000_i128);
}

// ── 9. Reject bet on cancelled market ────────────────────────────────────────

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

// ── 10. Reject bet below minimum ─────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn test_reject_bet_below_minimum() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);
    t.client.place_bet(&user, &id, &true, &5_000_000_i128);
}

// ── 11. Increase existing position ───────────────────────────────────────────

#[test]
fn test_increase_position_same_side() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 500_0000000);

    t.client.place_bet(&user, &id, &true, &100_0000000_i128);
    assert_eq!(t.client.get_bet(&id, &user).amount, 98_0000000);

    t.client.place_bet(&user, &id, &true, &50_0000000_i128);
    assert_eq!(t.client.get_bet(&id, &user).amount, 98_0000000 + 49_0000000);

    // Gross tracks full input (both bets)
    assert_eq!(t.client.get_bet_gross(&id, &user), 150_0000000);

    let market = t.client.get_market(&id);
    assert_eq!(market.total_yes, 98_0000000 + 49_0000000);
    assert_eq!(market.bet_count, 1);
}

// ── 12. Reject opposite-side bet ─────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn test_reject_opposite_side_bet() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 500_0000000);
    t.client.place_bet(&user, &id, &true, &100_0000000_i128);
    t.client.place_bet(&user, &id, &false, &50_0000000_i128);
}

// ── 13. Resolve market ───────────────────────────────────────────────────────

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
    assert!(market.outcome);
}

// ── 14. Resolver (non-admin) can resolve ─────────────────────────────────────

#[test]
fn test_resolver_can_resolve() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);
    t.client.place_bet(&user, &id, &true, &50_0000000_i128);

    let resolver = Address::generate(&t.env);
    t.client.add_resolver(&t.admin, &resolver);
    assert!(t.client.is_resolver(&resolver));

    advance_time(&t.env, 3601);
    t.client.resolve_market(&resolver, &id, &true);

    let market = t.client.get_market(&id);
    assert!(market.resolved);
}

// ── 15. Non-resolver cannot resolve ──────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #16)")]
fn test_reject_resolve_market_non_resolver() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);
    t.client.place_bet(&user, &id, &true, &50_0000000_i128);
    advance_time(&t.env, 3601);
    let rando = Address::generate(&t.env);
    t.client.resolve_market(&rando, &id, &true);
}

// ── 16. Reject double resolution ─────────────────────────────────────────────

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
    t.client.resolve_market(&t.admin, &id, &false);
}

// ── 17. Claim-style cancel: admin marks cancelled, bettors pull refunds ───────

#[test]
fn test_cancel_market_claim_style_refund() {
    let t = setup();
    let id = create_test_market(&t);
    let alice = Address::generate(&t.env);
    let bob = Address::generate(&t.env);
    fund_user(&t, &alice, 200_0000000);
    fund_user(&t, &bob, 200_0000000);

    let alice_before = t.xlm.balance(&alice);
    let bob_before = t.xlm.balance(&bob);

    t.client.place_bet(&alice, &id, &true, &100_0000000_i128);
    t.client.place_bet(&bob, &id, &false, &50_0000000_i128);

    // Admin cancels — O(1) gas, no transfers here
    t.client.cancel_market(&t.admin, &id);
    assert!(t.client.get_market(&id).cancelled);

    // Fees should be zeroed from AccumulatedFees since market is cancelled
    // (fees are returned to bettors via cancel_refund)
    let acc_fees_after_cancel = t.client.get_accumulated_fees();
    assert_eq!(acc_fees_after_cancel, 0);

    // Each bettor pulls their own gross refund
    let alice_refund = t.client.cancel_refund(&alice, &id);
    assert_eq!(alice_refund, 100_0000000); // full gross (100 XLM)
    assert_eq!(t.xlm.balance(&alice), alice_before);

    let bob_refund = t.client.cancel_refund(&bob, &id);
    assert_eq!(bob_refund, 50_0000000); // full gross (50 XLM)
    assert_eq!(t.xlm.balance(&bob), bob_before);
}

// ── 18. Cancel refund is idempotent — double refund rejected ──────────────────

#[test]
#[should_panic(expected = "Error(Contract, #13)")]
fn test_cancel_refund_double_claim_rejected() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);
    t.client.place_bet(&user, &id, &true, &100_0000000_i128);
    t.client.cancel_market(&t.admin, &id);
    t.client.cancel_refund(&user, &id);
    t.client.cancel_refund(&user, &id); // should fail: NoBetFound (gross zeroed)
}

// ── 19. cancel_refund on non-cancelled market rejected ────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #19)")]
fn test_cancel_refund_non_cancelled_rejected() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);
    t.client.place_bet(&user, &id, &true, &100_0000000_i128);
    // Market NOT cancelled — should return MarketNotCancelled
    t.client.cancel_refund(&user, &id);
}

// ── 20. Reject cancel on resolved market ─────────────────────────────────────

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
    t.client.cancel_market(&t.admin, &id);
}

// ── 21. Claim as winner ───────────────────────────────────────────────────────

#[test]
fn test_claim_winner() {
    let t = setup();
    let id = create_test_market(&t);
    let alice = Address::generate(&t.env);
    let bob = Address::generate(&t.env);
    fund_user(&t, &alice, 200_0000000);
    fund_user(&t, &bob, 200_0000000);

    t.client.place_bet(&alice, &id, &true, &100_0000000_i128);
    t.client.place_bet(&bob, &id, &false, &100_0000000_i128);

    let alice_pre_claim = t.xlm.balance(&alice);
    advance_time(&t.env, 3601);
    t.client.resolve_market(&t.admin, &id, &true);
    t.client.claim(&alice, &id);

    let payout = t.xlm.balance(&alice) - alice_pre_claim;
    assert_eq!(payout, 196_0000000);

    let stats = t.leaderboard_client.get_stats(&alice);
    assert_eq!(stats.won_bets, 1);
    assert_eq!(t.token_client.balance(&alice), 10_0000000);
}

// ── 22. Claim as loser ───────────────────────────────────────────────────────

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
    t.client.resolve_market(&t.admin, &id, &true);
    t.client.claim(&bob, &id);

    assert_eq!(t.xlm.balance(&bob), bob_pre_claim);
    let stats = t.leaderboard_client.get_stats(&bob);
    assert_eq!(stats.lost_bets, 1);
    assert_eq!(t.token_client.balance(&bob), 2_0000000);
}

// ── 23. Reject double claim ───────────────────────────────────────────────────

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
    t.client.claim(&user, &id);
}

// ── 24. Reject claim on unresolved market ────────────────────────────────────

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

// ── 25. Reject claim on cancelled market ─────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn test_reject_claim_cancelled() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);
    t.client.place_bet(&user, &id, &true, &100_0000000_i128);
    t.client.cancel_market(&t.admin, &id);
    t.client.claim(&user, &id);
}

// ── 26. Admin withdraw fees ──────────────────────────────────────────────────

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
    let withdrawn = t.client.withdraw_fees(&t.admin, &t.admin);
    assert_eq!(withdrawn, fees_before);
    assert_eq!(t.client.get_accumulated_fees(), 0);
    assert_eq!(t.xlm.balance(&t.admin), admin_xlm_before + fees_before);
}

// ── 27. Fee recipient can withdraw ───────────────────────────────────────────

#[test]
fn test_fee_recipient_withdraw() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);
    t.client.place_bet(&user, &id, &true, &100_0000000_i128);

    let recipient = Address::generate(&t.env);
    let treasury = Address::generate(&t.env);
    t.client.add_fee_recipient(&t.admin, &recipient);

    let fees = t.client.get_accumulated_fees();
    let treasury_before = t.xlm.balance(&treasury);
    t.client.withdraw_fees(&recipient, &treasury);
    assert_eq!(t.xlm.balance(&treasury), treasury_before + fees);
    assert_eq!(t.client.get_accumulated_fees(), 0);
}

// ── 28. Non-authorized cannot withdraw fees ───────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #18)")]
fn test_reject_withdraw_fees_non_admin() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);
    t.client.place_bet(&user, &id, &true, &100_0000000_i128);
    let rando = Address::generate(&t.env);
    t.client.withdraw_fees(&rando, &rando);
}

// ── 29. Bettor index enumeration ─────────────────────────────────────────────

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

// ── 30. Referrer earns 3 bonus points per referred bet ───────────────────────

#[test]
fn test_referrer_bonus_points_per_bet() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    let referrer = Address::generate(&t.env);
    fund_user(&t, &user, 500_0000000);

    t.referral_client.register_referral(
        &user,
        &String::from_str(&t.env, "Fan"),
        &Some(referrer.clone()),
    );

    t.client.place_bet(&user, &id, &true, &100_0000000_i128);
    t.client.place_bet(&user, &id, &true, &50_0000000_i128);

    assert_eq!(t.leaderboard_client.get_points(&referrer), 6);
}

// ── 31. Spam guard: TooManyBets ──────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #17)")]
fn test_reject_too_many_bets() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 10_000_0000000);

    for _ in 0..=20u32 {
        t.client.place_bet(&user, &id, &true, &1_0000000_i128);
    }
}

// ── 32. Market creation rate limiting ────────────────────────────────────────

#[test]
fn test_market_creation_rate_limit_allows_up_to_max() {
    let t = setup();
    // Should be able to create up to MAX_MARKETS_PER_HOUR (10) in the same window
    for i in 0..10u32 {
        let _ = t.client.create_market(
            &t.admin,
            &String::from_str(&t.env, "Market"),
            &String::from_str(&t.env, "https://x.png"),
            &Category::Crypto,
            &(3600_u64 + i as u64),
        );
    }
    assert_eq!(t.client.get_market_count(), 10);
}

#[test]
#[should_panic(expected = "Error(Contract, #20)")]
fn test_market_creation_rate_limit_exceeded() {
    let t = setup();
    // Create 10 markets (the limit)
    for i in 0..10u32 {
        let _ = t.client.create_market(
            &t.admin,
            &String::from_str(&t.env, "Market"),
            &String::from_str(&t.env, "https://x.png"),
            &Category::Crypto,
            &(3600_u64 + i as u64),
        );
    }
    // 11th should fail
    t.client.create_market(
        &t.admin,
        &String::from_str(&t.env, "Over limit"),
        &String::from_str(&t.env, "https://x.png"),
        &Category::Sports,
        &7200_u64,
    );
}

#[test]
fn test_market_creation_rate_limit_resets_after_window() {
    let t = setup();
    for i in 0..10u32 {
        let _ = t.client.create_market(
            &t.admin,
            &String::from_str(&t.env, "Market"),
            &String::from_str(&t.env, "https://x.png"),
            &Category::Crypto,
            &(3600_u64 + i as u64),
        );
    }
    // Advance past the 1-hour window
    advance_time(&t.env, 3601);
    // Should be able to create again
    let id = t.client.create_market(
        &t.admin,
        &String::from_str(&t.env, "New window market"),
        &String::from_str(&t.env, "https://x.png"),
        &Category::Sports,
        &7200_u64,
    );
    assert_eq!(id, 11);
}

// ── 33. Double initialization rejected ───────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn test_double_init_rejected() {
    let t = setup();
    let tok2 = Address::generate(&t.env);
    let ref2 = Address::generate(&t.env);
    let lb2 = Address::generate(&t.env);
    let xlm2 = Address::generate(&t.env);
    t.client.initialize(&t.admin, &tok2, &ref2, &lb2, &xlm2);
}

// ── 34. Resolve before deadline rejected ─────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn test_reject_resolve_before_deadline() {
    let t = setup();
    let id = create_test_market(&t);
    let user = Address::generate(&t.env);
    fund_user(&t, &user, 200_0000000);
    t.client.place_bet(&user, &id, &true, &50_0000000_i128);
    t.client.resolve_market(&t.admin, &id, &true);
}

// ── 35. Withdraw fees when zero ───────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #15)")]
fn test_withdraw_fees_zero() {
    let t = setup();
    t.client.withdraw_fees(&t.admin, &t.admin);
}

// ── 36. Claim with no bet → NoBetFound ───────────────────────────────────────

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
    let stranger = Address::generate(&t.env);
    t.client.claim(&stranger, &id);
}

// ── 37. Non-admin create market rejected ─────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_reject_create_market_non_admin() {
    let t = setup();
    let rando = Address::generate(&t.env);
    t.client.create_market(
        &rando,
        &String::from_str(&t.env, "Unauthorized?"),
        &String::from_str(&t.env, "https://x.png"),
        &Category::Other,
        &3600_u64,
    );
}

// ── 38. Non-admin cancel rejected ────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_reject_cancel_market_non_admin() {
    let t = setup();
    let id = create_test_market(&t);
    let rando = Address::generate(&t.env);
    t.client.cancel_market(&rando, &id);
}

// ── 39. Market not found ─────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_market_not_found() {
    let t = setup();
    t.client.get_market(&999);
}

// ── 40. Multiple markets with categories ─────────────────────────────────────

#[test]
fn test_create_multiple_markets() {
    let t = setup();
    let id1 = t.client.create_market(
        &t.admin,
        &String::from_str(&t.env, "Market A"),
        &String::from_str(&t.env, "https://a.png"),
        &Category::Crypto,
        &3600_u64,
    );
    let id2 = t.client.create_market(
        &t.admin,
        &String::from_str(&t.env, "Market B"),
        &String::from_str(&t.env, "https://b.png"),
        &Category::Sports,
        &7200_u64,
    );
    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
    assert_eq!(t.client.get_market_count(), 2);
    assert_eq!(t.client.get_market(&id2).category, Category::Sports);
}

// ── 41. Empty-side resolution: pool goes to AccumulatedFees, admin can withdraw ─

#[test]
fn test_empty_side_resolution_pool_to_fees() {
    let t = setup();
    let id = create_test_market(&t);
    let alice = Address::generate(&t.env);
    fund_user(&t, &alice, 200_0000000);

    // Only YES bets — no one bets NO
    t.client.place_bet(&alice, &id, &true, &100_0000000_i128);
    let fees_before = t.client.get_accumulated_fees();
    assert_eq!(fees_before, 2_0000000); // 2% platform fee

    // Advance past end_time and resolve NO (empty winning side)
    advance_time(&t.env, 3601);
    t.client.resolve_market(&t.admin, &id, &false); // total_no == 0

    // The entire pool (total_yes net = 98 XLM) must be swept into AccumulatedFees
    let fees_after = t.client.get_accumulated_fees();
    assert_eq!(fees_after, fees_before + 98_0000000,
        "entire YES pool should sweep to fees when NO side is empty");

    // Admin can withdraw the swept pool
    let treasury = Address::generate(&t.env);
    let before = t.xlm.balance(&treasury);
    let withdrawn = t.client.withdraw_fees(&t.admin, &treasury);
    assert_eq!(withdrawn, fees_after);
    assert_eq!(t.xlm.balance(&treasury), before + fees_after);
    assert_eq!(t.client.get_accumulated_fees(), 0);

    // Alice (was YES, losing side) can still claim — gets IPRED tokens + points
    t.client.claim(&alice, &id);
    let bet = t.client.get_bet(&id, &alice);
    assert!(bet.claimed);
    // Gets lose-tier rewards because winning_side == 0
    assert_eq!(t.token_client.balance(&alice), 2_0000000); // LOSE_TOKENS
    assert_eq!(t.leaderboard_client.get_points(&alice), 10); // LOSE_POINTS
}

// ── 42. Cancel accumulates fees on multiple bets correctly ────────────────────

#[test]
fn test_cancel_fees_zeroed_correctly() {
    let t = setup();
    let id = create_test_market(&t);
    let alice = Address::generate(&t.env);
    let bob = Address::generate(&t.env);
    fund_user(&t, &alice, 200_0000000);
    fund_user(&t, &bob, 200_0000000);

    // Two bets accumulate fees
    t.client.place_bet(&alice, &id, &true, &100_0000000_i128); // 2 XLM fee
    t.client.place_bet(&bob, &id, &false, &100_0000000_i128); // 2 XLM fee
    assert_eq!(t.client.get_accumulated_fees(), 4_0000000);

    // Cancel zeroes out those fees
    t.client.cancel_market(&t.admin, &id);
    assert_eq!(t.client.get_accumulated_fees(), 0);

    // Bettors get their gross back
    t.client.cancel_refund(&alice, &id);
    t.client.cancel_refund(&bob, &id);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 42. COMPREHENSIVE END-TO-END INTEGRATION TEST
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_e2e_full_inter_contract_flow() {
    let t = setup();

    let alice = Address::generate(&t.env);
    let bob = Address::generate(&t.env);
    let referrer = Address::generate(&t.env);
    fund_user(&t, &alice, 1000_0000000);
    fund_user(&t, &bob, 1000_0000000);

    t.referral_client.register_referral(
        &alice,
        &String::from_str(&t.env, "Alice"),
        &Some(referrer.clone()),
    );
    assert_eq!(t.leaderboard_client.get_points(&alice), 5);
    assert_eq!(t.token_client.balance(&alice), 1_0000000);

    let market_id = t.client.create_market(
        &t.admin,
        &String::from_str(&t.env, "Will ETH flip BTC?"),
        &String::from_str(&t.env, "https://eth.png"),
        &Category::Crypto,
        &3600_u64,
    );
    assert_eq!(market_id, 1);

    // Alice bets YES 100 XLM — has referrer
    t.client.place_bet(&alice, &market_id, &true, &100_0000000_i128);
    assert_eq!(t.client.get_accumulated_fees(), 1_5000000);
    assert_eq!(t.xlm.balance(&referrer), 5000000);
    assert_eq!(t.leaderboard_client.get_points(&referrer), 3);
    // total_bets now = won+lost (0 before claim)
    assert_eq!(t.leaderboard_client.get_stats(&alice).total_bets, 0);
    assert_eq!(t.client.get_market(&market_id).total_yes, 98_0000000);
    assert_eq!(t.client.get_bet_gross(&market_id, &alice), 100_0000000);

    // Bob bets NO 200 XLM — no referrer
    t.client.place_bet(&bob, &market_id, &false, &200_0000000_i128);
    assert_eq!(t.client.get_accumulated_fees(), 5_5000000);
    // total_bets now = won+lost (0 before claim)
    assert_eq!(t.leaderboard_client.get_stats(&bob).total_bets, 0);
    assert_eq!(t.client.get_market(&market_id).total_no, 196_0000000);

    // Alice increases YES (+50 XLM)
    t.client.place_bet(&alice, &market_id, &true, &50_0000000_i128);
    let alice_bet = t.client.get_bet(&market_id, &alice);
    assert_eq!(alice_bet.amount, 98_0000000 + 49_0000000);
    assert_eq!(t.client.get_bet_gross(&market_id, &alice), 150_0000000);
    assert_eq!(t.client.get_market(&market_id).total_yes, 147_0000000);
    assert_eq!(t.client.get_market(&market_id).bet_count, 2);
    assert_eq!(t.leaderboard_client.get_points(&referrer), 6);

    // Add a resolver and resolve via them
    let resolver = Address::generate(&t.env);
    t.client.add_resolver(&t.admin, &resolver);
    advance_time(&t.env, 3601);
    t.client.resolve_market(&resolver, &market_id, &true);
    assert!(t.client.get_market(&market_id).resolved);

    // Alice claims as winner
    let alice_xlm_before = t.xlm.balance(&alice);
    t.client.claim(&alice, &market_id);
    let alice_payout = t.xlm.balance(&alice) - alice_xlm_before;
    assert_eq!(alice_payout, 343_0000000);
    assert_eq!(t.leaderboard_client.get_points(&alice), 35);
    assert_eq!(t.token_client.balance(&alice), 11_0000000);

    // Bob claims as loser
    let bob_xlm_before = t.xlm.balance(&bob);
    t.client.claim(&bob, &market_id);
    assert_eq!(t.xlm.balance(&bob), bob_xlm_before);
    assert_eq!(t.leaderboard_client.get_points(&bob), 10);
    assert_eq!(t.token_client.balance(&bob), 2_0000000);

    // Fee withdrawal to a treasury address
    let treasury = Address::generate(&t.env);
    let fees_total = t.client.get_accumulated_fees();
    assert!(fees_total > 0);
    let treasury_before = t.xlm.balance(&treasury);
    let withdrawn = t.client.withdraw_fees(&t.admin, &treasury);
    assert_eq!(withdrawn, fees_total);
    assert_eq!(t.client.get_accumulated_fees(), 0);
    assert_eq!(t.xlm.balance(&treasury), treasury_before + fees_total);

    // Create second market, bet, then cancel — verify claim-style refund
    let market2 = t.client.create_market(
        &t.admin,
        &String::from_str(&t.env, "Will DOGE hit $1?"),
        &String::from_str(&t.env, "https://doge.png"),
        &Category::Crypto,
        &7200_u64,
    );
    let charlie = Address::generate(&t.env);
    fund_user(&t, &charlie, 500_0000000);
    let charlie_before = t.xlm.balance(&charlie);
    t.client.place_bet(&charlie, &market2, &true, &100_0000000_i128);
    t.client.cancel_market(&t.admin, &market2);
    // AccumulatedFees from market2 should be zeroed
    assert_eq!(t.client.get_accumulated_fees(), 0);
    // Charlie pulls their own refund (gross = 100 XLM)
    let refunded = t.client.cancel_refund(&charlie, &market2);
    assert_eq!(refunded, 100_0000000);
    assert_eq!(t.xlm.balance(&charlie), charlie_before);
}

// ═══════════════════════════════════════════════════════════════════════════════
// OPTIMISTIC ORACLE STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════════

const SUB_BOND: i128 = 100_0000000; // SUBMITTER_BOND
const DIS_BOND: i128 = 200_0000000; // DISPUTER_BOND
const CHALLENGE_WINDOW_SECS: u64 = 86_400;
const COUNCIL_WINDOW_SECS: u64 = 259_200;

struct OracleMarket {
    id: u64,
    yes_bettor: Address,
    no_bettor: Address,
}

/// A market with 100 XLM on each side, already past `end_time` — the state
/// every oracle submission starts from. Both sides are funded so resolution
/// never sweeps the pool into fees, keeping bond math easy to assert.
fn expired_market_with_bets(t: &TestSetup) -> OracleMarket {
    let id = create_test_market(t);
    let yes_bettor = Address::generate(&t.env);
    let no_bettor = Address::generate(&t.env);
    fund_user(t, &yes_bettor, 200_0000000);
    fund_user(t, &no_bettor, 200_0000000);
    t.client.place_bet(&yes_bettor, &id, &true, &100_0000000_i128);
    t.client.place_bet(&no_bettor, &id, &false, &100_0000000_i128);
    advance_time(&t.env, 3601);
    OracleMarket { id, yes_bettor, no_bettor }
}

fn funded_user(t: &TestSetup, amount: i128) -> Address {
    let user = Address::generate(&t.env);
    fund_user(t, &user, amount);
    user
}

/// A typed event in the `(contract, topics, data)` shape the test env records.
fn ev<E: Event>(t: &TestSetup, event: &E) -> (Address, Vec<Val>, Val) {
    (t.market_id.clone(), event.topics(&t.env), event.data(&t.env))
}

/// Assert the exact events this contract published during the most recent
/// invocation. Filtering by the market contract drops the SAC/leaderboard/
/// referral events, so what is left is precisely the oracle lifecycle an
/// indexer would consume. `all()` only retains the latest invocation, so call
/// this immediately after the transition being asserted.
fn assert_market_events(t: &TestSetup, expected: Vec<(Address, Vec<Val>, Val)>) {
    assert_eq!(t.env.events().all().filter_by_contract(&t.market_id), expected);
}

// ── 43. submit_outcome escrows the bond and opens the challenge window ────────

#[test]
fn test_submit_outcome_escrows_bond_and_opens_window() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    let submitter = funded_user(&t, SUB_BOND);

    let contract_before = t.xlm.balance(&t.market_id);
    let submitted_at = t.env.ledger().timestamp();

    t.client.submit_outcome(&submitter, &m.id, &true, &SUB_BOND);

    // Bond moved from the submitter into contract escrow
    assert_eq!(t.xlm.balance(&submitter), 0);
    assert_eq!(t.xlm.balance(&t.market_id), contract_before + SUB_BOND);

    let sub = t.client.get_oracle_submission(&m.id);
    assert_eq!(sub.market_id, m.id);
    assert_eq!(sub.submitter, submitter);
    assert!(sub.outcome);
    assert_eq!(sub.bond, SUB_BOND);
    assert_eq!(sub.state, OracleState::Submitted);
    assert_eq!(sub.submitted_at, submitted_at);
    assert_eq!(sub.challenge_deadline, submitted_at + CHALLENGE_WINDOW_SECS);
    assert_eq!(sub.challenger, None);
    assert_eq!(sub.challenger_bond, 0);
    assert_eq!(sub.finalized_at, 0);

    // The market itself is untouched until finalization
    assert!(!t.client.get_market(&m.id).resolved);
}

// ── 44. submit_outcome emits oracle:submitted ────────────────────────────────

#[test]
fn test_submit_outcome_emits_event() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    let submitter = funded_user(&t, SUB_BOND);
    let submitted_at = t.env.ledger().timestamp();

    t.client.submit_outcome(&submitter, &m.id, &true, &SUB_BOND);

    assert_market_events(&t, vec![&t.env, ev(&t, &OracleSubmittedEvent {
        market_id: m.id,
        submitter,
        outcome: true,
        bond: SUB_BOND,
        submitted_at,
        challenge_deadline: submitted_at + CHALLENGE_WINDOW_SECS,
    })]);
}

// ── 45. Double submission rejected ───────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #21)")]
fn test_reject_double_submission() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    let first = funded_user(&t, SUB_BOND);
    let second = funded_user(&t, SUB_BOND);

    t.client.submit_outcome(&first, &m.id, &true, &SUB_BOND);
    t.client.submit_outcome(&second, &m.id, &false, &SUB_BOND);
}

// ── 46. Submission rejected before the market expires ────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn test_reject_submit_before_market_expiry() {
    let t = setup();
    let id = create_test_market(&t);
    let submitter = funded_user(&t, SUB_BOND);
    t.client.submit_outcome(&submitter, &id, &true, &SUB_BOND);
}

// ── 47. Submission rejected on an already resolved market ────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn test_reject_submit_on_resolved_market() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    t.client.resolve_market(&t.admin, &m.id, &true);

    let submitter = funded_user(&t, SUB_BOND);
    t.client.submit_outcome(&submitter, &m.id, &true, &SUB_BOND);
}

// ── 48. Submission rejected on a cancelled market ────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn test_reject_submit_on_cancelled_market() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    t.client.cancel_market(&t.admin, &m.id);

    let submitter = funded_user(&t, SUB_BOND);
    t.client.submit_outcome(&submitter, &m.id, &true, &SUB_BOND);
}

// ── 49. Submission below the minimum bond rejected ───────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #28)")]
fn test_reject_submit_bond_below_minimum() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    let submitter = funded_user(&t, SUB_BOND);
    t.client.submit_outcome(&submitter, &m.id, &true, &(SUB_BOND - 1));
}

// ── 50. Submission on a non-existent market rejected ─────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_reject_submit_unknown_market() {
    let t = setup();
    let submitter = funded_user(&t, SUB_BOND);
    t.client.submit_outcome(&submitter, &999_u64, &true, &SUB_BOND);
}

// ── 51. challenge escrows the larger bond and escalates ──────────────────────

#[test]
fn test_challenge_escalates_to_council() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    let submitter = funded_user(&t, SUB_BOND);
    let challenger = funded_user(&t, DIS_BOND);

    t.client.submit_outcome(&submitter, &m.id, &true, &SUB_BOND);
    let contract_before = t.xlm.balance(&t.market_id);

    advance_time(&t.env, 600); // still inside the 24h window
    let challenged_at = t.env.ledger().timestamp();
    t.client.challenge(&challenger, &m.id, &DIS_BOND);

    assert_eq!(t.xlm.balance(&challenger), 0);
    assert_eq!(t.xlm.balance(&t.market_id), contract_before + DIS_BOND);

    let sub = t.client.get_oracle_submission(&m.id);
    assert_eq!(sub.state, OracleState::Escalated);
    assert_eq!(sub.challenger, Some(challenger));
    assert_eq!(sub.challenger_bond, DIS_BOND);
    assert_eq!(sub.escalated_at, challenged_at);
    assert_eq!(sub.council_deadline, challenged_at + COUNCIL_WINDOW_SECS);
    // The disputed outcome is unchanged — the council decides it
    assert!(sub.outcome);
    assert!(!t.client.get_market(&m.id).resolved);
}

// ── 52. challenge emits oracle:challenged and oracle:escalated ───────────────

#[test]
fn test_challenge_emits_challenged_and_escalated_events() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    let submitter = funded_user(&t, SUB_BOND);
    let challenger = funded_user(&t, DIS_BOND);

    t.client.submit_outcome(&submitter, &m.id, &true, &SUB_BOND);
    advance_time(&t.env, 600);
    let challenged_at = t.env.ledger().timestamp();
    t.client.challenge(&challenger, &m.id, &DIS_BOND);

    assert_market_events(&t, vec![&t.env,
        ev(&t, &OracleChallengedEvent {
            market_id: m.id,
            challenger: challenger.clone(),
            outcome: false, // challenger asserts the opposite side
            bond: DIS_BOND,
            submitter: submitter.clone(),
            submitter_bond: SUB_BOND,
            challenged_at,
        }),
        ev(&t, &OracleEscalatedEvent {
            market_id: m.id,
            submitter,
            challenger,
            outcome: true,
            total_bond: SUB_BOND + DIS_BOND,
            escalated_at: challenged_at,
            council_deadline: challenged_at + COUNCIL_WINDOW_SECS,
        }),
    ]);
}

// ── 53. Challenge below the disputer minimum rejected ────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #28)")]
fn test_reject_challenge_below_disputer_minimum() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    let submitter = funded_user(&t, SUB_BOND);
    let challenger = funded_user(&t, DIS_BOND);

    t.client.submit_outcome(&submitter, &m.id, &true, &SUB_BOND);
    t.client.challenge(&challenger, &m.id, &(DIS_BOND - 1));
}

// ── 54. Challenge must exceed the submitter's bond, not just the minimum ─────

#[test]
#[should_panic(expected = "Error(Contract, #28)")]
fn test_reject_challenge_not_larger_than_submitter_bond() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    // Submitter over-bonds to exactly the disputer minimum
    let submitter = funded_user(&t, DIS_BOND);
    let challenger = funded_user(&t, DIS_BOND);

    t.client.submit_outcome(&submitter, &m.id, &true, &DIS_BOND);
    t.client.challenge(&challenger, &m.id, &DIS_BOND); // equal, not larger
}

// ── 55. Challenge after the window closes rejected ───────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #26)")]
fn test_reject_challenge_after_window() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    let submitter = funded_user(&t, SUB_BOND);
    let challenger = funded_user(&t, DIS_BOND);

    t.client.submit_outcome(&submitter, &m.id, &true, &SUB_BOND);
    advance_time(&t.env, CHALLENGE_WINDOW_SECS);
    t.client.challenge(&challenger, &m.id, &DIS_BOND);
}

// ── 56. Challenge without a submission rejected ──────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #22)")]
fn test_reject_challenge_without_submission() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    let challenger = funded_user(&t, DIS_BOND);
    t.client.challenge(&challenger, &m.id, &DIS_BOND);
}

// ── 57. Second challenge on an escalated market rejected ─────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #23)")]
fn test_reject_double_challenge() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    let submitter = funded_user(&t, SUB_BOND);
    let first = funded_user(&t, DIS_BOND);
    let second = funded_user(&t, DIS_BOND + 1);

    t.client.submit_outcome(&submitter, &m.id, &true, &SUB_BOND);
    t.client.challenge(&first, &m.id, &DIS_BOND);
    t.client.challenge(&second, &m.id, &(DIS_BOND + 1));
}

// ── 58. Happy path: unchallenged submission finalizes and returns the bond ───

#[test]
fn test_unchallenged_finalize() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    let submitter = funded_user(&t, SUB_BOND);

    let submitted_at = t.env.ledger().timestamp();
    t.client.submit_outcome(&submitter, &m.id, &true, &SUB_BOND);
    let contract_after_submit = t.xlm.balance(&t.market_id);
    let fees_before = t.client.get_accumulated_fees();

    advance_time(&t.env, CHALLENGE_WINDOW_SECS);
    let finalized_at = t.env.ledger().timestamp();
    t.client.finalize_outcome(&m.id); // permissionless

    assert_market_events(&t, vec![&t.env, ev(&t, &OracleFinalizedEvent {
        market_id: m.id,
        outcome: true,
        challenged: false,
        submitter: submitter.clone(),
        challenger: None,
        submitter_payout: SUB_BOND,
        challenger_payout: 0,
        council_fee: 0,
        protocol_credit: 0,
        finalized_at,
    })]);

    // Bond returned in full — nothing is skimmed from an unchallenged submission
    assert_eq!(t.xlm.balance(&submitter), SUB_BOND);
    assert_eq!(t.xlm.balance(&t.market_id), contract_after_submit - SUB_BOND);
    assert_eq!(t.client.get_accumulated_fees(), fees_before);

    let market = t.client.get_market(&m.id);
    assert!(market.resolved);
    assert!(market.outcome);

    let sub = t.client.get_oracle_submission(&m.id);
    assert_eq!(sub.state, OracleState::Finalized);
    assert_eq!(sub.challenge_deadline, submitted_at + CHALLENGE_WINDOW_SECS);
    assert_eq!(sub.finalized_at, finalized_at);
}

// ── 59. Winner can claim after an oracle finalization ────────────────────────

#[test]
fn test_claim_after_unchallenged_finalize() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    let submitter = funded_user(&t, SUB_BOND);

    t.client.submit_outcome(&submitter, &m.id, &true, &SUB_BOND);
    advance_time(&t.env, CHALLENGE_WINDOW_SECS);
    t.client.finalize_outcome(&m.id);

    let before = t.xlm.balance(&m.yes_bettor);
    t.client.claim(&m.yes_bettor, &m.id);
    // 98 net YES against a 196 pool → the whole pool
    assert_eq!(t.xlm.balance(&m.yes_bettor) - before, 196_0000000);

    t.client.claim(&m.no_bettor, &m.id);
    assert_eq!(t.leaderboard_client.get_stats(&m.no_bettor).lost_bets, 1);
}

// ── 60. Finalize before the window closes rejected ───────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #24)")]
fn test_reject_finalize_before_window_closes() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    let submitter = funded_user(&t, SUB_BOND);

    t.client.submit_outcome(&submitter, &m.id, &true, &SUB_BOND);
    advance_time(&t.env, CHALLENGE_WINDOW_SECS - 1);
    t.client.finalize_outcome(&m.id);
}

// ── 61. Finalize on an escalated market rejected — the council must rule ─────

#[test]
#[should_panic(expected = "Error(Contract, #23)")]
fn test_reject_finalize_escalated_market() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    let submitter = funded_user(&t, SUB_BOND);
    let challenger = funded_user(&t, DIS_BOND);

    t.client.submit_outcome(&submitter, &m.id, &true, &SUB_BOND);
    t.client.challenge(&challenger, &m.id, &DIS_BOND);
    advance_time(&t.env, CHALLENGE_WINDOW_SECS);
    t.client.finalize_outcome(&m.id);
}

// ── 62. Double finalize rejected ─────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #27)")]
fn test_reject_double_finalize() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    let submitter = funded_user(&t, SUB_BOND);

    t.client.submit_outcome(&submitter, &m.id, &true, &SUB_BOND);
    advance_time(&t.env, CHALLENGE_WINDOW_SECS);
    t.client.finalize_outcome(&m.id);
    t.client.finalize_outcome(&m.id);
}

// ── 63. Finalize without a submission rejected ───────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #22)")]
fn test_reject_finalize_without_submission() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    t.client.finalize_outcome(&m.id);
}

// ── 64. Council upholds the submission — bond math + conservation ────────────

#[test]
fn test_council_upholds_submission_bond_math() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    let submitter = funded_user(&t, SUB_BOND);
    let challenger = funded_user(&t, DIS_BOND);

    t.client.submit_outcome(&submitter, &m.id, &true, &SUB_BOND);
    t.client.challenge(&challenger, &m.id, &DIS_BOND);

    let contract_before = t.xlm.balance(&t.market_id);
    let fees_before = t.client.get_accumulated_fees();

    // Doc: submitter gets bond back + half of the disputer bond.
    let expected_submitter_payout = SUB_BOND + DIS_BOND / 2;
    let expected_council_fee = DIS_BOND / 10; // 10% of the loser's bond
    let expected_protocol_credit = DIS_BOND - DIS_BOND / 2;

    advance_time(&t.env, 3600);
    let finalized_at = t.env.ledger().timestamp();
    t.client.resolve_challenge(&t.admin, &m.id, &true); // submitter was right

    assert_market_events(&t, vec![&t.env, ev(&t, &OracleFinalizedEvent {
        market_id: m.id,
        outcome: true,
        challenged: true,
        submitter: submitter.clone(),
        challenger: Some(challenger.clone()),
        submitter_payout: expected_submitter_payout,
        challenger_payout: 0,
        council_fee: expected_council_fee,
        protocol_credit: expected_protocol_credit,
        finalized_at,
    })]);

    assert_eq!(t.xlm.balance(&submitter), expected_submitter_payout);
    assert_eq!(t.xlm.balance(&challenger), 0);

    // Bond conservation: every stroop of escrow is either paid out or credited
    // to the protocol — the contract keeps exactly the protocol credit.
    assert_eq!(
        expected_submitter_payout + 0 + expected_protocol_credit,
        SUB_BOND + DIS_BOND,
    );
    assert_eq!(t.xlm.balance(&t.market_id), contract_before - expected_submitter_payout);
    assert_eq!(
        t.client.get_accumulated_fees(),
        fees_before + expected_protocol_credit,
    );

    let market = t.client.get_market(&m.id);
    assert!(market.resolved);
    assert!(market.outcome);
    assert_eq!(t.client.get_oracle_submission(&m.id).state, OracleState::Finalized);
}

// ── 65. Council sides with the disputer — bond math + conservation ───────────

#[test]
fn test_council_sides_with_disputer_bond_math() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    let submitter = funded_user(&t, SUB_BOND);
    let challenger = funded_user(&t, DIS_BOND);

    t.client.submit_outcome(&submitter, &m.id, &true, &SUB_BOND);
    t.client.challenge(&challenger, &m.id, &DIS_BOND);

    let contract_before = t.xlm.balance(&t.market_id);
    let fees_before = t.client.get_accumulated_fees();

    // Doc: disputer gets both bonds, less a 10% council fee on the loser's bond.
    let expected_council_fee = SUB_BOND / 10;
    let expected_challenger_payout = DIS_BOND + SUB_BOND - expected_council_fee;

    // Council rules NO — the challenger was right
    let council = Address::generate(&t.env);
    t.client.add_resolver(&t.admin, &council);
    let finalized_at = t.env.ledger().timestamp();
    t.client.resolve_challenge(&council, &m.id, &false);

    assert_market_events(&t, vec![&t.env, ev(&t, &OracleFinalizedEvent {
        market_id: m.id,
        outcome: false,
        challenged: true,
        submitter: submitter.clone(),
        challenger: Some(challenger.clone()),
        submitter_payout: 0,
        challenger_payout: expected_challenger_payout,
        council_fee: expected_council_fee,
        protocol_credit: expected_council_fee,
        finalized_at,
    })]);

    assert_eq!(t.xlm.balance(&submitter), 0);
    assert_eq!(t.xlm.balance(&challenger), expected_challenger_payout);

    assert_eq!(
        expected_challenger_payout + expected_council_fee,
        SUB_BOND + DIS_BOND,
    );
    assert_eq!(t.xlm.balance(&t.market_id), contract_before - expected_challenger_payout);
    assert_eq!(t.client.get_accumulated_fees(), fees_before + expected_council_fee);

    let market = t.client.get_market(&m.id);
    assert!(market.resolved);
    assert!(!market.outcome);
    assert_eq!(t.client.get_oracle_submission(&m.id).state, OracleState::Finalized);
}

// ── 66. Non-resolver cannot rule on an escalated market ──────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #16)")]
fn test_reject_resolve_challenge_non_resolver() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    let submitter = funded_user(&t, SUB_BOND);
    let challenger = funded_user(&t, DIS_BOND);

    t.client.submit_outcome(&submitter, &m.id, &true, &SUB_BOND);
    t.client.challenge(&challenger, &m.id, &DIS_BOND);

    let rando = Address::generate(&t.env);
    t.client.resolve_challenge(&rando, &m.id, &false);
}

// ── 67. Council cannot rule on a market that was never challenged ────────────

#[test]
#[should_panic(expected = "Error(Contract, #27)")]
fn test_reject_resolve_challenge_when_not_escalated() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    let submitter = funded_user(&t, SUB_BOND);

    t.client.submit_outcome(&submitter, &m.id, &true, &SUB_BOND);
    t.client.resolve_challenge(&t.admin, &m.id, &true);
}

// ── 68. Council cannot rule twice ────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #27)")]
fn test_reject_double_council_ruling() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    let submitter = funded_user(&t, SUB_BOND);
    let challenger = funded_user(&t, DIS_BOND);

    t.client.submit_outcome(&submitter, &m.id, &true, &SUB_BOND);
    t.client.challenge(&challenger, &m.id, &DIS_BOND);
    t.client.resolve_challenge(&t.admin, &m.id, &true);
    t.client.resolve_challenge(&t.admin, &m.id, &false);
}

// ── 69. Out-of-band resolution still releases an unchallenged bond ───────────

#[test]
fn test_finalize_releases_bond_when_market_resolved_out_of_band() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    let submitter = funded_user(&t, SUB_BOND);

    t.client.submit_outcome(&submitter, &m.id, &false, &SUB_BOND);
    // Admin force-resolves the other way while the window is open
    t.client.resolve_market(&t.admin, &m.id, &true);

    advance_time(&t.env, CHALLENGE_WINDOW_SECS);
    t.client.finalize_outcome(&m.id);

    // The bond is never stranded, and the admin's outcome stands
    assert_eq!(t.xlm.balance(&submitter), SUB_BOND);
    assert!(t.client.get_market(&m.id).outcome);
    assert_eq!(t.client.get_oracle_submission(&m.id).state, OracleState::Finalized);
}

// ── 70. Submissions are per-market and independent ───────────────────────────

#[test]
fn test_submissions_are_isolated_per_market() {
    let t = setup();
    let m1 = expired_market_with_bets(&t);
    let m2 = expired_market_with_bets(&t);
    let s1 = funded_user(&t, SUB_BOND);
    let s2 = funded_user(&t, SUB_BOND);

    t.client.submit_outcome(&s1, &m1.id, &true, &SUB_BOND);
    t.client.submit_outcome(&s2, &m2.id, &false, &SUB_BOND);

    assert!(t.client.get_oracle_submission(&m1.id).outcome);
    assert!(!t.client.get_oracle_submission(&m2.id).outcome);

    advance_time(&t.env, CHALLENGE_WINDOW_SECS);
    t.client.finalize_outcome(&m1.id);

    assert!(t.client.get_market(&m1.id).resolved);
    assert!(!t.client.get_market(&m2.id).resolved);
    assert_eq!(t.client.get_oracle_submission(&m2.id).state, OracleState::Submitted);
}

// ── 71. Reading a submission that does not exist ─────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #22)")]
fn test_get_oracle_submission_not_found() {
    let t = setup();
    t.client.get_oracle_submission(&1_u64);
}

// ── 72. A cancelled market still settles escalated bonds ─────────────────────

#[test]
fn test_council_settles_bonds_on_cancelled_market() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    let submitter = funded_user(&t, SUB_BOND);
    let challenger = funded_user(&t, DIS_BOND);

    t.client.submit_outcome(&submitter, &m.id, &true, &SUB_BOND);
    t.client.challenge(&challenger, &m.id, &DIS_BOND);
    t.client.cancel_market(&t.admin, &m.id);

    // The ruling still runs so the bonds are never stranded in escrow …
    t.client.resolve_challenge(&t.admin, &m.id, &false);
    assert_eq!(t.xlm.balance(&challenger), DIS_BOND + SUB_BOND - SUB_BOND / 10);
    assert_eq!(t.client.get_oracle_submission(&m.id).state, OracleState::Finalized);

    // … but a cancelled market is not resolved by the council
    let market = t.client.get_market(&m.id);
    assert!(market.cancelled);
    assert!(!market.resolved);
}

// ── 73. Bonds are released when a market is cancelled mid-window ─────────────

#[test]
fn test_finalize_releases_bond_on_cancelled_market() {
    let t = setup();
    let m = expired_market_with_bets(&t);
    let submitter = funded_user(&t, SUB_BOND);

    t.client.submit_outcome(&submitter, &m.id, &true, &SUB_BOND);
    t.client.cancel_market(&t.admin, &m.id);

    advance_time(&t.env, CHALLENGE_WINDOW_SECS);
    t.client.finalize_outcome(&m.id);

    assert_eq!(t.xlm.balance(&submitter), SUB_BOND);
    let market = t.client.get_market(&m.id);
    assert!(market.cancelled);
    assert!(!market.resolved);
}
