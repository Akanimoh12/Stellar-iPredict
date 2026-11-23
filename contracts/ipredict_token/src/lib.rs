#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Map,
    MuxedAddress, String, Symbol, Val,
};

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TokenError {
    AlreadyInitialized  = 1,
    NotInitialized      = 2,
    UnauthorizedMinter  = 3,
    InsufficientBalance   = 4,
    InvalidAmount         = 5,
    NotAdmin              = 6,
    NoPendingAdmin        = 7,
    InsufficientAllowance = 8,
    InvalidExpiration     = 9,
}

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
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AllowanceEntry {
    pub amount: i128,
    pub expiration_ledger: u32,
}

#[contract]
pub struct IPredictTokenContract;

#[contractimpl]
impl IPredictTokenContract {
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

    pub fn mint(env: Env, minter: Address, to: Address, amount: i128) -> Result<(), TokenError> {
        if amount <= 0 {
            return Err(TokenError::InvalidAmount);
        }
        minter.require_auth();
        let is_minter: bool = env.storage().persistent()
            .get(&DataKey::AuthorizedMinter(minter))
            .unwrap_or(false);
        if !is_minter {
            return Err(TokenError::UnauthorizedMinter);
        }
        let balance = Self::balance(env.clone(), to.clone());
        env.storage().persistent().set(&DataKey::Balance(to), &(balance + amount));
        let supply: i128 = env.storage().instance().get(&DataKey::TotalSupply).unwrap_or(0);
        env.storage().instance().set(&DataKey::TotalSupply, &(supply + amount));
        env.events().publish((symbol_short!("mint"), to), amount);
        Ok(())
    }

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        let entry: Option<AllowanceEntry> = env.storage().persistent()
            .get(&DataKey::Allowance(from, spender));
        match entry {
            Some(entry) if entry.expiration_ledger >= env.ledger().sequence() => entry.amount,
            _ => 0,
        }
    }

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
        let current_ledger = env.ledger().sequence();
        if amount > 0 && expiration_ledger < current_ledger {
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
            env.storage().persistent().extend_ttl(
                &key,
                1,
                env.ledger().max_entry_ttl(),
            );
        }
        env.events().publish(
            (symbol_short!("approve"), from, spender),
            soroban_sdk::vec![&env, amount, expiration_ledger],
        );
    }

    pub fn transfer(env: Env, from: Address, to: MuxedAddress, amount: i128) {
        from.require_auth();
        Self::transfer_balance(&env, &from, &to, amount);
    }

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

    pub fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        Self::burn_balance(&env, &from, amount);
    }

    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        Self::spend_allowance(&env, &from, &spender, amount);
        Self::burn_balance(&env, &from, amount);
    }

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

    /// Two-step admin transfer, step 1: current admin nominates `new_admin`.
    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) -> Result<(), TokenError> {
        let stored = Self::require_admin(&env)?;
        if admin != stored { return Err(TokenError::NotAdmin); }
        admin.require_auth();
        env.storage().instance().set(&DataKey::PendingAdmin, &new_admin);
        Ok(())
    }

    /// Two-step admin transfer, step 2: the nominee accepts and becomes admin.
    pub fn accept_admin(env: Env, new_admin: Address) -> Result<(), TokenError> {
        new_admin.require_auth();
        let pending: Address = env.storage().instance().get(&DataKey::PendingAdmin)
            .ok_or(TokenError::NoPendingAdmin)?;
        if pending != new_admin { return Err(TokenError::NotAdmin); }
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        Ok(())
    }

    fn require_admin(env: &Env) -> Result<Address, TokenError> {
        env.storage().instance().get(&DataKey::Admin).ok_or(TokenError::NotInitialized)
    }
}

impl IPredictTokenContract {
    fn transfer_balance(env: &Env, from: &Address, to: &MuxedAddress, amount: i128) {
        if amount < 0 {
            env.panic_with_error(TokenError::InvalidAmount);
        }
        let to_address = to.address();
        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < amount {
            env.panic_with_error(TokenError::InsufficientBalance);
        }
        let to_balance = Self::balance(env.clone(), to_address.clone());
        if from != &to_address {
            env.storage().persistent().set(
                &DataKey::Balance(from.clone()),
                &(from_balance - amount),
            );
            env.storage().persistent().set(
                &DataKey::Balance(to_address.clone()),
                &(to_balance + amount),
            );
        }

        let mut event_data = Map::<Symbol, Val>::new(env);
        event_data.set(symbol_short!("amount"), amount);
        event_data.set(Symbol::new(env, "to_muxed_id"), to.id());
        env.events().publish(
            (symbol_short!("transfer"), from.clone(), to_address),
            event_data,
        );
    }

    fn spend_allowance(env: &Env, from: &Address, spender: &Address, amount: i128) {
        if amount < 0 {
            env.panic_with_error(TokenError::InvalidAmount);
        }
        if amount == 0 {
            return;
        }
        let key = DataKey::Allowance(from.clone(), spender.clone());
        let entry: AllowanceEntry = env.storage().persistent()
            .get(&key)
            .unwrap_or(AllowanceEntry { amount: 0, expiration_ledger: 0 });
        if entry.expiration_ledger < env.ledger().sequence() || entry.amount < amount {
            env.panic_with_error(TokenError::InsufficientAllowance);
        }
        env.storage().persistent().set(
            &key,
            &AllowanceEntry {
                amount: entry.amount - amount,
                expiration_ledger: entry.expiration_ledger,
            },
        );
    }

    fn burn_balance(env: &Env, from: &Address, amount: i128) {
        if amount < 0 {
            env.panic_with_error(TokenError::InvalidAmount);
        }
        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < amount {
            env.panic_with_error(TokenError::InsufficientBalance);
        }
        env.storage().persistent().set(&DataKey::Balance(from.clone()), &(from_balance - amount));
        let supply: i128 = env.storage().instance().get(&DataKey::TotalSupply).unwrap_or(0);
        env.storage().instance().set(&DataKey::TotalSupply, &(supply - amount));
        env.events().publish((symbol_short!("burn"), from.clone()), amount);
    }
}

#[cfg(test)]
mod tests;
