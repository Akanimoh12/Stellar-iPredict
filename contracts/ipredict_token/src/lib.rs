#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env,
    MuxedAddress, String,
};

// ── Storage TTL constants (mirrors prediction_market strategy) ────────────────
// Token balances and allowances are persistent entries; they must have their TTL
// extended on every mutating operation so idle accounts never expire from storage.
//
// TTL_BALANCE_BUMP (3,153,600 s ≈ 36.5 days): minimum threshold before extend.
// TTL_BALANCE_HIGH (6,307,200 s ≈ 73 days):   target TTL after extend.
//
// These match the host's ledger-close cadence (~5 s): 73 days ≈ 1,261,440 ledgers.
// See Issue #784.
const TTL_BALANCE_BUMP: u32 = 3_153_600;
const TTL_BALANCE_HIGH: u32 = 6_307_200;

// ── Errors ────────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TokenError {
    AlreadyInitialized    = 1,
    NotInitialized        = 2,
    UnauthorizedMinter    = 3,
    InsufficientBalance   = 4,
    InvalidAmount         = 5,
    NotAdmin              = 6,
    NoPendingAdmin        = 7,
    InsufficientAllowance = 8,
    InvalidExpiration     = 9,
    SupplyCapExceeded     = 10, // #785: mint would breach the configured cap
}

// ── Storage Keys ──────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    PendingAdmin,
    AuthorizedMinter(Address),
    Balance(Address),
    Allowance(Address, Address),
    TotalSupply,
    Name,
    Symbol,
    Decimals,
    SupplyCap, // #785: optional maximum total supply (0 = uncapped)
}

// ── Allowance entry ───────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AllowanceEntry {
    pub amount: i128,
    pub expiration_ledger: u32,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct IPredictTokenContract;

#[contractimpl]
impl IPredictTokenContract {
    // ── Initialization ────────────────────────────────────────────────────

    pub fn initialize(
        env: Env,
        admin: Address,
        name: String,
        symbol: String,
        decimals: u32,
    ) -> Result<(), TokenError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(TokenError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Name, &name);
        env.storage().instance().set(&DataKey::Symbol, &symbol);
        env.storage().instance().set(&DataKey::Decimals, &decimals);
        env.storage().instance().set(&DataKey::TotalSupply, &0_i128);
        // SupplyCap defaults to absent (uncapped). Set via set_supply_cap.
        Ok(())
    }

    /// Replace this contract's WASM in place. Admin only. Balances preserved.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), TokenError> {
        let stored: Address = env.storage().instance().get(&DataKey::Admin)
            .ok_or(TokenError::NotInitialized)?;
        if admin != stored { return Err(TokenError::NotAdmin); }
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    // ── Minter management ────────────────────────────────────────────────

    pub fn set_minter(env: Env, minter: Address) -> Result<(), TokenError> {
        let admin: Address = Self::require_admin(&env)?;
        admin.require_auth();
        env.storage().persistent().set(&DataKey::AuthorizedMinter(minter), &true);
        Ok(())
    }

    pub fn remove_minter(env: Env, minter: Address) -> Result<(), TokenError> {
        let admin: Address = Self::require_admin(&env)?;
        admin.require_auth();
        env.storage().persistent().remove(&DataKey::AuthorizedMinter(minter));
        Ok(())
    }

    // ── Supply cap (#785) ─────────────────────────────────────────────────
    //
    // `set_supply_cap(cap)` stores the ceiling. cap == 0 removes the cap.
    // The cap is enforced in `mint` before any storage write; it is O(1)
    // in both time and space — a single instance-storage read.
    //
    // Design trade-offs:
    //   * Instance storage: cheapest read path; shared across all invocations.
    //   * cap == 0 convention: avoids a separate boolean key.
    //   * Check after amount validation: fail early on bad input, then cap.

    /// Configure or remove the total-supply ceiling. Admin only.
    /// Pass `cap = 0` to remove an existing cap (make minting uncapped).
    pub fn set_supply_cap(env: Env, admin: Address, cap: i128) -> Result<(), TokenError> {
        if cap < 0 { return Err(TokenError::InvalidAmount); }
        let stored = Self::require_admin(&env)?;
        if admin != stored { return Err(TokenError::NotAdmin); }
        admin.require_auth();
        if cap == 0 {
            env.storage().instance().remove(&DataKey::SupplyCap);
        } else {
            env.storage().instance().set(&DataKey::SupplyCap, &cap);
        }
        Ok(())
    }

    /// Return the current supply cap, or 0 if none is set.
    pub fn supply_cap(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::SupplyCap).unwrap_or(0)
    }

    // ── Core token operations ──────────────────────────────────────────────

    /// Mint `amount` tokens to `to`.
    ///
    /// Complexity: O(1) time, O(1) space (two persistent reads, two writes).
    ///
    /// Changes vs. previous implementation (#784, #785):
    ///   * Calls `extend_ttl` on the recipient's balance after each write so
    ///     idle balances never expire from persistent storage.
    ///   * Enforces `SupplyCap` when set, returning `SupplyCapExceeded` if
    ///     the new total would exceed the ceiling.
    pub fn mint(env: Env, minter: Address, to: Address, amount: i128) -> Result<(), TokenError> {
        if amount <= 0 {
            return Err(TokenError::InvalidAmount);
        }
        minter.require_auth();

        let is_minter: bool = env.storage().persistent()
            .get(&DataKey::AuthorizedMinter(minter.clone()))
            .unwrap_or(false);
        if !is_minter {
            return Err(TokenError::UnauthorizedMinter);
        }

        let supply: i128 = env.storage().instance().get(&DataKey::TotalSupply).unwrap_or(0);
        let new_supply = supply.checked_add(amount).ok_or(TokenError::InvalidAmount)?;

        // #785: enforce supply cap when configured.
        let cap: i128 = env.storage().instance().get(&DataKey::SupplyCap).unwrap_or(0);
        if cap > 0 && new_supply > cap {
            return Err(TokenError::SupplyCapExceeded);
        }

        let balance_key = DataKey::Balance(to.clone());
        let balance: i128 = env.storage().persistent()
            .get(&balance_key)
            .unwrap_or(0);
        let new_balance = balance.checked_add(amount).ok_or(TokenError::InvalidAmount)?;

        // Write balance first, then supply. Order matches SEP-41 convention.
        env.storage().persistent().set(&balance_key, &new_balance);
        // #784: extend TTL so this balance entry never silently expires.
        env.storage().persistent().extend_ttl(&balance_key, TTL_BALANCE_BUMP, TTL_BALANCE_HIGH);

        env.storage().instance().set(&DataKey::TotalSupply, &new_supply);

        env.events().publish(
            (symbol_short!("mint"), minter, to),
            amount,
        );
        Ok(())
    }

    // ── SEP-41: allowance / approve / transfer_from (#782) ─────────────────
    //
    // Design:
    //   * AllowanceEntry stores (amount, expiration_ledger) in one persistent slot.
    //   * Expired entries return 0 without a separate cleanup step (lazy expiry).
    //   * approve(amount=0) removes the entry to reclaim rent.
    //   * extend_ttl on allowance entries mirrors the SEP-41 reference impl.
    //   * spend_allowance checks expiry AND amount in one read — O(1).

    /// Return the remaining allowance for `spender` to spend from `from`.
    /// Returns 0 if the allowance has expired or never existed.
    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        let entry: Option<AllowanceEntry> = env.storage().persistent()
            .get(&DataKey::Allowance(from, spender));
        match entry {
            Some(e) if e.expiration_ledger >= env.ledger().sequence() => e.amount,
            _ => 0,
        }
    }

    /// Set the amount `spender` is allowed to transfer on behalf of `from`.
    ///
    /// `expiration_ledger` must be >= current ledger when amount > 0.
    /// Pass `amount = 0` to revoke an existing approval and reclaim storage.
    pub fn approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        expiration_ledger: u32,
    ) {
        from.require_auth();
        if amount < 0 {
            env.panic_with_error(TokenError::InvalidAmount);
        }
        if amount > 0 && expiration_ledger < env.ledger().sequence() {
            env.panic_with_error(TokenError::InvalidExpiration);
        }

        let key = DataKey::Allowance(from.clone(), spender.clone());
        if amount == 0 {
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(
                &key,
                &AllowanceEntry { amount, expiration_ledger },
            );
            // TTL must reach at least the expiration ledger so the allowance is
            // readable until it naturally expires; cap at max_entry_ttl.
            let current = env.ledger().sequence();
            let needed = expiration_ledger.saturating_sub(current).max(1);
            let target = needed.min(TTL_BALANCE_HIGH);
            env.storage().persistent().extend_ttl(&key, needed, target);
        }

        env.events().publish(
            (symbol_short!("approve"), from, spender),
            (amount, expiration_ledger),
        );
    }

    // ── SEP-41: transfer / transfer_from ─────────────────────────────────

    pub fn transfer(env: Env, from: Address, to: MuxedAddress, amount: i128) {
        from.require_auth();
        Self::transfer_balance(&env, &from, &to, amount);
    }

    /// Transfer `amount` from `from` to `to` on behalf of `spender`.
    /// Consumes from the spender's allowance. Panics if allowance is
    /// insufficient or expired.
    pub fn transfer_from(
        env: Env,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) {
        spender.require_auth();
        Self::spend_allowance(&env, &from, &spender, amount);
        let to = MuxedAddress::from(to);
        Self::transfer_balance(&env, &from, &to, amount);
    }

    // ── SEP-41: burn / burn_from ──────────────────────────────────────────

    pub fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        Self::burn_balance(&env, &from, amount);
    }

    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        Self::spend_allowance(&env, &from, &spender, amount);
        Self::burn_balance(&env, &from, amount);
    }

    // ── View functions ────────────────────────────────────────────────────

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage().persistent().get(&DataKey::Balance(id)).unwrap_or(0)
    }

    pub fn total_supply(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalSupply).unwrap_or(0)
    }

    pub fn name(env: Env) -> String {
        env.storage().instance().get(&DataKey::Name)
            .unwrap_or_else(|| String::from_str(&env, "IPREDICT"))
    }

    pub fn symbol(env: Env) -> String {
        env.storage().instance().get(&DataKey::Symbol)
            .unwrap_or_else(|| String::from_str(&env, "IPRED"))
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Decimals).unwrap_or(7)
    }

    // ── Two-step admin transfer ───────────────────────────────────────────

    /// Step 1: current admin nominates `new_admin`.
    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) -> Result<(), TokenError> {
        let stored = Self::require_admin(&env)?;
        if admin != stored { return Err(TokenError::NotAdmin); }
        admin.require_auth();
        env.storage().instance().set(&DataKey::PendingAdmin, &new_admin);
        Ok(())
    }

    /// Step 2: the nominee accepts and becomes admin.
    pub fn accept_admin(env: Env, new_admin: Address) -> Result<(), TokenError> {
        new_admin.require_auth();
        let pending: Address = env.storage().instance().get(&DataKey::PendingAdmin)
            .ok_or(TokenError::NoPendingAdmin)?;
        if pending != new_admin { return Err(TokenError::NotAdmin); }
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        Ok(())
    }

    // ── Internal helpers ──────────────────────────────────────────────────

    fn require_admin(env: &Env) -> Result<Address, TokenError> {
        env.storage().instance().get(&DataKey::Admin).ok_or(TokenError::NotInitialized)
    }
}

impl IPredictTokenContract {
    /// Move `amount` tokens from `from` to `to`.
    ///
    /// Extends TTL for both the sender's and recipient's balance entries (#784).
    /// Self-transfers are a no-op on balances but still emit an event.
    ///
    /// Complexity: O(1) time, O(1) space.
    fn transfer_balance(env: &Env, from: &Address, to: &MuxedAddress, amount: i128) {
        if amount < 0 {
            env.panic_with_error(TokenError::InvalidAmount);
        }
        let to_address = to.address();
        let from_key = DataKey::Balance(from.clone());
        let to_key = DataKey::Balance(to_address.clone());

        let from_balance: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
        if from_balance < amount {
            env.panic_with_error(TokenError::InsufficientBalance);
        }

        if from != &to_address {
            let to_balance: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);
            env.storage().persistent().set(&from_key, &(from_balance - amount));
            // #784: keep sender entry alive.
            env.storage().persistent().extend_ttl(&from_key, TTL_BALANCE_BUMP, TTL_BALANCE_HIGH);
            env.storage().persistent().set(&to_key, &(to_balance + amount));
            // #784: keep recipient entry alive.
            env.storage().persistent().extend_ttl(&to_key, TTL_BALANCE_BUMP, TTL_BALANCE_HIGH);
        }

        env.events().publish(
            (symbol_short!("transfer"), from.clone(), to_address),
            amount,
        );
    }

    /// Debit `amount` from `from`'s allowance to `spender`.
    ///
    /// Panics with `InsufficientAllowance` if the allowance is expired or too small.
    /// Complexity: O(1) time, O(1) space.
    fn spend_allowance(env: &Env, from: &Address, spender: &Address, amount: i128) {
        if amount <= 0 {
            return; // zero spend is a no-op; negative amounts are caught upstream.
        }
        let key = DataKey::Allowance(from.clone(), spender.clone());
        let entry: AllowanceEntry = env.storage().persistent()
            .get(&key)
            .unwrap_or(AllowanceEntry { amount: 0, expiration_ledger: 0 });

        if entry.expiration_ledger < env.ledger().sequence() || entry.amount < amount {
            env.panic_with_error(TokenError::InsufficientAllowance);
        }

        let new_amount = entry.amount - amount;
        if new_amount == 0 {
            // Reclaim rent when allowance is fully consumed.
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(
                &key,
                &AllowanceEntry {
                    amount: new_amount,
                    expiration_ledger: entry.expiration_ledger,
                },
            );
        }
    }

    /// Destroy `amount` tokens from `from` and reduce total supply.
    ///
    /// Extends TTL for the sender's entry (#784).
    /// Complexity: O(1) time, O(1) space.
    fn burn_balance(env: &Env, from: &Address, amount: i128) {
        if amount < 0 {
            env.panic_with_error(TokenError::InvalidAmount);
        }
        let key = DataKey::Balance(from.clone());
        let from_balance: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if from_balance < amount {
            env.panic_with_error(TokenError::InsufficientBalance);
        }
        env.storage().persistent().set(&key, &(from_balance - amount));
        // #784: extend even after partial burn so the entry doesn't expire.
        env.storage().persistent().extend_ttl(&key, TTL_BALANCE_BUMP, TTL_BALANCE_HIGH);

        let supply: i128 = env.storage().instance().get(&DataKey::TotalSupply).unwrap_or(0);
        env.storage().instance().set(&DataKey::TotalSupply, &(supply - amount));

        env.events().publish((symbol_short!("burn"), from.clone()), amount);
    }
}

#[cfg(test)]
mod tests;
