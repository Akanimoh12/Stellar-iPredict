#![cfg(test)]

use super::*;
use crate::tests::{advance_time, check_invariant, create_test_market, fund_user, setup, TestSetup};
use soroban_sdk::{
    testutils::Address as _,
    Address, String,
};

/// Comprehensive verification of market accounting invariants:
/// 1. Contract XLM balance must strictly equal the sum of:
///    - Outstanding active stakes in unfinalized/unresolved markets (net pool)
///    - Unclaimed payouts for winning bets in resolved markets
///    - Unrefunded gross stakes for cancelled markets
///    - Escrowed oracle bonds and challenger bonds
///    - Unwithdrawn accumulated platform fees
/// 2. Accumulated fees must never exceed total contract balance.
pub fn verify_pool_accounting_invariants(t: &TestSetup) {
    let contract_balance = t.xlm.balance(&t.market_id);
    let acc_fees = t.client.get_accumulated_fees();

    assert!(
        contract_balance >= acc_fees,
        "Solvency violation: contract balance {} is less than accumulated fees {}",
        contract_balance,
        acc_fees
    );

    // Call standard full invariant checker
    check_invariant(t);
}

#[test]
fn test_invariant_bet_claim_and_fee_withdrawal_sequence() {
    let t = setup();
    let market_id = create_test_market(&t);

    let alice = Address::generate(&t.env);
    let bob = Address::generate(&t.env);
    let charlie = Address::generate(&t.env);
    let treasury = Address::generate(&t.env);

    // 100 XLM each (in stroops)
    let deposit = 100 * 10_000_000_i128;
    fund_user(&t, &alice, deposit);
    fund_user(&t, &bob, deposit);
    fund_user(&t, &charlie, deposit);

    // Initial state invariant
    verify_pool_accounting_invariants(&t);

    // Alice bets 50 XLM on YES
    t.client.bet(&alice, &market_id, &true, &(50 * 10_000_000_i128));
    verify_pool_accounting_invariants(&t);

    // Bob bets 30 XLM on YES
    t.client.bet(&bob, &market_id, &true, &(30 * 10_000_000_i128));
    verify_pool_accounting_invariants(&t);

    // Charlie bets 20 XLM on NO
    t.client.bet(&charlie, &market_id, &false, &(20 * 10_000_000_i128));
    verify_pool_accounting_invariants(&t);

    // Advance past market end time
    advance_time(&t.env, 3601);

    // Admin resolves market as YES
    t.client.resolve_market(&t.admin, &market_id, &true);
    verify_pool_accounting_invariants(&t);

    // Alice claims winnings
    t.client.claim(&alice, &market_id);
    verify_pool_accounting_invariants(&t);

    // Admin withdraws accumulated fees
    let acc_fees_before = t.client.get_accumulated_fees();
    assert!(acc_fees_before > 0);
    let withdrawn = t.client.withdraw_fees(&t.admin, &treasury);
    assert_eq!(withdrawn, acc_fees_before);
    assert_eq!(t.client.get_accumulated_fees(), 0);
    assert_eq!(t.xlm.balance(&treasury), withdrawn);
    verify_pool_accounting_invariants(&t);

    // Bob claims winnings
    t.client.claim(&bob, &market_id);
    verify_pool_accounting_invariants(&t);

    // Since all winners claimed and fees are withdrawn, contract balance for this market should be 0
    assert_eq!(t.xlm.balance(&t.market_id), 0);
}

#[test]
fn test_invariant_cancel_market_and_refund_sequence() {
    let t = setup();
    let market_id = create_test_market(&t);

    let alice = Address::generate(&t.env);
    let bob = Address::generate(&t.env);
    let charlie = Address::generate(&t.env);

    let alice_bet = 40 * 10_000_000_i128;
    let bob_bet = 60 * 10_000_000_i128;
    let charlie_bet = 100 * 10_000_000_i128;

    fund_user(&t, &alice, alice_bet);
    fund_user(&t, &bob, bob_bet);
    fund_user(&t, &charlie, charlie_bet);

    // Bettors place bets
    t.client.bet(&alice, &market_id, &true, &alice_bet);
    verify_pool_accounting_invariants(&t);

    t.client.bet(&bob, &market_id, &false, &bob_bet);
    verify_pool_accounting_invariants(&t);

    t.client.bet(&charlie, &market_id, &true, &charlie_bet);
    verify_pool_accounting_invariants(&t);

    let total_gross = alice_bet + bob_bet + charlie_bet;
    assert_eq!(t.xlm.balance(&t.market_id), total_gross);

    // Cancel market
    t.client.cancel_market(&t.admin, &market_id);
    let market = t.client.get_market(&market_id);
    assert!(market.cancelled);
    verify_pool_accounting_invariants(&t);

    // Alice refunds
    let alice_refund = t.client.cancel_refund(&alice, &market_id);
    assert_eq!(alice_refund, alice_bet);
    assert_eq!(t.xlm.balance(&alice), alice_bet);
    verify_pool_accounting_invariants(&t);

    // Double refund must fail
    assert!(t.client.try_cancel_refund(&alice, &market_id).is_err());
    verify_pool_accounting_invariants(&t);

    // Bob refunds
    let bob_refund = t.client.cancel_refund(&bob, &market_id);
    assert_eq!(bob_refund, bob_bet);
    assert_eq!(t.xlm.balance(&bob), bob_bet);
    verify_pool_accounting_invariants(&t);

    // Charlie refunds
    let charlie_refund = t.client.cancel_refund(&charlie, &market_id);
    assert_eq!(charlie_refund, charlie_bet);
    assert_eq!(t.xlm.balance(&charlie), charlie_bet);
    verify_pool_accounting_invariants(&t);

    // After all refunds, contract balance must be 0
    assert_eq!(t.xlm.balance(&t.market_id), 0);
}

#[test]
fn test_invariant_cancel_unsubmitted_market_refund_sequence() {
    let t = setup();
    let market_id = create_test_market(&t);

    let user = Address::generate(&t.env);
    let bet_amount = 50 * 10_000_000_i128;
    fund_user(&t, &user, bet_amount);

    t.client.bet(&user, &market_id, &true, &bet_amount);
    verify_pool_accounting_invariants(&t);

    // Advance past expiry + CANCELLATION_DEADLINE (7 days = 604,800s)
    advance_time(&t.env, 3600 + 604_800 + 10);

    // Permissionless cancellation
    t.client.cancel_unsubmitted_market(&market_id);
    verify_pool_accounting_invariants(&t);

    // User claims refund
    let refunded = t.client.cancel_refund(&user, &market_id);
    assert_eq!(refunded, bet_amount);
    assert_eq!(t.xlm.balance(&user), bet_amount);
    verify_pool_accounting_invariants(&t);
    assert_eq!(t.xlm.balance(&t.market_id), 0);
}

#[test]
fn test_invariant_interleaved_multi_market_operations() {
    let t = setup();

    let m1 = create_test_market(&t);
    let m2 = t.client.create_market(
        &t.admin,
        &String::from_str(&t.env, "Will ETH hit 5k?"),
        &String::from_str(&t.env, "https://example.com/eth.png"),
        &Category::Crypto,
        &7200_u64,
    );
    let m3 = t.client.create_market(
        &t.admin,
        &String::from_str(&t.env, "Will SOL hit 300?"),
        &String::from_str(&t.env, "https://example.com/sol.png"),
        &Category::Crypto,
        &10800_u64,
    );

    let user1 = Address::generate(&t.env);
    let user2 = Address::generate(&t.env);
    let user3 = Address::generate(&t.env);
    let treasury = Address::generate(&t.env);

    let amount = 100 * 10_000_000_i128;
    fund_user(&t, &user1, amount * 3);
    fund_user(&t, &user2, amount * 3);
    fund_user(&t, &user3, amount * 3);

    // Interleave bets across markets
    t.client.bet(&user1, &m1, &true, &amount);
    verify_pool_accounting_invariants(&t);

    t.client.bet(&user2, &m2, &false, &amount);
    verify_pool_accounting_invariants(&t);

    t.client.bet(&user3, &m3, &true, &amount);
    verify_pool_accounting_invariants(&t);

    t.client.bet(&user2, &m1, &false, &amount);
    verify_pool_accounting_invariants(&t);

    t.client.bet(&user1, &m2, &true, &amount);
    verify_pool_accounting_invariants(&t);

    // Cancel m2
    t.client.cancel_market(&t.admin, &m2);
    verify_pool_accounting_invariants(&t);

    // Refund user2 from m2
    let ref2 = t.client.cancel_refund(&user2, &m2);
    assert_eq!(ref2, amount);
    verify_pool_accounting_invariants(&t);

    // Resolve m1 after time passes
    advance_time(&t.env, 3601);
    t.client.resolve_market(&t.admin, &m1, &true);
    verify_pool_accounting_invariants(&t);

    // Withdraw fees accumulated so far
    let withdrawn = t.client.withdraw_fees(&t.admin, &treasury);
    assert!(withdrawn > 0);
    verify_pool_accounting_invariants(&t);

    // Claim m1 for user1
    t.client.claim(&user1, &m1);
    verify_pool_accounting_invariants(&t);

    // Refund user1 from m2
    let ref1 = t.client.cancel_refund(&user1, &m2);
    assert_eq!(ref1, amount);
    verify_pool_accounting_invariants(&t);

    // Market 3 remains active with bets intact
    let market3 = t.client.get_market(&m3);
    assert!(!market3.resolved && !market3.cancelled);
    verify_pool_accounting_invariants(&t);
}
