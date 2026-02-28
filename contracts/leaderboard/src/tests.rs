#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Env};

/// Helper: register + initialize the leaderboard contract.
fn setup() -> (Env, LeaderboardContractClient<'static>, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, LeaderboardContract);
    let client = LeaderboardContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let market = Address::generate(&env);
    let referral = Address::generate(&env);

    client.initialize(&admin, &market, &referral);

    (env, client, admin, market, referral)
}

// ── 1. Add points and verify balance ──────────────────────────────────────────

#[test]
fn test_add_points_and_verify_balance() {
    let (env, client, _admin, market, _referral) = setup();
    let user = Address::generate(&env);

    client.add_pts(&market, &user, &100_u64, &true);

    assert_eq!(client.get_points(&user), 100);
}

// ── 2. Accumulate points across multiple adds ─────────────────────────────────

#[test]
fn test_accumulate_points() {
    let (env, client, _admin, market, _referral) = setup();
    let user = Address::generate(&env);

    client.add_pts(&market, &user, &50_u64, &true);
    client.add_pts(&market, &user, &30_u64, &false);
    client.add_pts(&market, &user, &20_u64, &true);

    assert_eq!(client.get_points(&user), 100);
}

// ── 3. add_bonus_pts without modifying won/lost counters ──────────────────────

#[test]
fn test_bonus_pts_no_won_lost() {
    let (env, client, _admin, market, referral) = setup();
    let user = Address::generate(&env);

    // First give some regular points so the user has won/lost records
    client.add_pts(&market, &user, &10_u64, &true);
    client.add_pts(&market, &user, &5_u64, &false);

    let stats_before = client.get_stats(&user);
    assert_eq!(stats_before.won_bets, 1);
    assert_eq!(stats_before.lost_bets, 1);

    // Now add bonus points via referral contract
    client.add_bonus_pts(&referral, &user, &25_u64);

    let stats_after = client.get_stats(&user);
    // Points should increase
    assert_eq!(stats_after.points, 40); // 10 + 5 + 25
    // Won/lost should remain unchanged
    assert_eq!(stats_after.won_bets, 1);
    assert_eq!(stats_after.lost_bets, 1);
}

// ── 4. Top players sorted correctly ───────────────────────────────────────────

#[test]
fn test_top_players_sorted() {
    let (env, client, _admin, market, _referral) = setup();

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let charlie = Address::generate(&env);

    client.add_pts(&market, &alice, &50_u64, &true);
    client.add_pts(&market, &bob, &100_u64, &true);
    client.add_pts(&market, &charlie, &75_u64, &true);

    let top = client.get_top_players(&10_u32);
    assert_eq!(top.len(), 3);

    // Should be descending: bob (100), charlie (75), alice (50)
    assert_eq!(top.get(0).unwrap().address, bob);
    assert_eq!(top.get(0).unwrap().points, 100);
    assert_eq!(top.get(1).unwrap().address, charlie);
    assert_eq!(top.get(1).unwrap().points, 75);
    assert_eq!(top.get(2).unwrap().address, alice);
    assert_eq!(top.get(2).unwrap().points, 50);
}

// ── 5. Top 50 cap ─────────────────────────────────────────────────────────────

#[test]
fn test_top_players_capped_at_50() {
    let (env, client, _admin, market, _referral) = setup();

    // Insert 55 players with ascending points (1..=55)
    let mut players = soroban_sdk::Vec::new(&env);
    for i in 1u64..=55 {
        let user = Address::generate(&env);
        players.push_back(user.clone());
        client.add_pts(&market, &user, &i, &true);
    }

    let top = client.get_top_players(&100_u32);
    assert_eq!(top.len(), 50);

    // Highest scorer (55 pts) should be first
    assert_eq!(top.get(0).unwrap().points, 55);
    // Lowest in top-50 should have 6 pts (players 1-5 excluded)
    assert_eq!(top.get(49).unwrap().points, 6);
}

// ── 6. record_bet increments counter ──────────────────────────────────────────

#[test]
fn test_record_bet_increments() {
    let (env, client, _admin, market, _referral) = setup();
    let user = Address::generate(&env);

    client.record_bet(&market, &user);
    client.record_bet(&market, &user);
    client.record_bet(&market, &user);

    let stats = client.get_stats(&user);
    assert_eq!(stats.total_bets, 3);
}

// ── 7. get_stats correct aggregate ────────────────────────────────────────────

#[test]
fn test_get_stats_aggregate() {
    let (env, client, _admin, market, referral) = setup();
    let user = Address::generate(&env);

    // Record some bets
    client.record_bet(&market, &user);
    client.record_bet(&market, &user);
    client.record_bet(&market, &user);
    client.record_bet(&market, &user);

    // Add points: 2 wins, 1 loss
    client.add_pts(&market, &user, &20_u64, &true);
    client.add_pts(&market, &user, &30_u64, &true);
    client.add_pts(&market, &user, &5_u64, &false);

    // Bonus points
    client.add_bonus_pts(&referral, &user, &10_u64);

    let stats = client.get_stats(&user);
    assert_eq!(stats.points, 65);     // 20 + 30 + 5 + 10
    assert_eq!(stats.total_bets, 4);
    assert_eq!(stats.won_bets, 2);
    assert_eq!(stats.lost_bets, 1);
}

// ── 8. Rank calculation ──────────────────────────────────────────────────────

#[test]
fn test_rank_calculation() {
    let (env, client, _admin, market, _referral) = setup();

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let charlie = Address::generate(&env);
    let dave = Address::generate(&env);

    client.add_pts(&market, &alice, &50_u64, &true);
    client.add_pts(&market, &bob, &100_u64, &true);
    client.add_pts(&market, &charlie, &75_u64, &true);

    // bob = rank 1, charlie = rank 2, alice = rank 3
    assert_eq!(client.get_rank(&bob), 1);
    assert_eq!(client.get_rank(&charlie), 2);
    assert_eq!(client.get_rank(&alice), 3);

    // dave never scored — should return 0 (unranked)
    assert_eq!(client.get_rank(&dave), 0);
}

// ── 9. Unauthorized caller rejected ──────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_unauthorized_caller_rejected() {
    let (env, client, _admin, _market, _referral) = setup();
    let rando = Address::generate(&env);
    let user = Address::generate(&env);

    // Random address tries to call add_pts — should fail with UnauthorizedCaller (3)
    client.add_pts(&rando, &user, &10_u64, &true);
}

// ── 10. Double initialization rejected ───────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn test_double_init_rejected() {
    let (_env, client, admin, market, referral) = setup();

    // Second init should fail with AlreadyInitialized (1)
    client.initialize(&admin, &market, &referral);
}
