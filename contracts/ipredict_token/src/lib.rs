#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, String};

// ── Errors ────────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TokenError {
    AlreadyInitialized = 1,
    NotInitialized     = 2,
    UnauthorizedMinter = 3,
    InsufficientBalance = 4,
    InvalidAmount      = 5,
    NotAdmin           = 6,
}

// ── Storage Keys ──────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    AuthorizedMinter(Address),
    Balance(Address),
    TotalSupply,
    Name,
    Symbol,
    Decimals,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct IPredictTokenContract;

#[contractimpl]
impl IPredictTokenContract {
    // ── Admin / Lifecycle ─────────────────────────────────────────────────

    /// One-time initialization: store admin address and token metadata.
    pub fn initialize(
        env: Env,
        admin: Address,
        name: String,
        symbol: String,
        decimals: u32,
    ) -> Result<(), TokenError> {
        // Prevent re-initialization
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(TokenError::AlreadyInitialized);
        }

        admin.require_auth();

        // Store metadata in instance storage (cheap, lives with the contract)
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Name, &name);
        env.storage().instance().set(&DataKey::Symbol, &symbol);
        env.storage().instance().set(&DataKey::Decimals, &decimals);
        env.storage().instance().set(&DataKey::TotalSupply, &0_i128);

        env.events().publish(
            (symbol_short!("init"), symbol_short!("token")),
            admin,
        );

        Ok(())
    }

    // ── Minter Management ─────────────────────────────────────────────────

    /// Grant minting permission to `minter`. Can be called multiple times to
    /// authorize both PredictionMarket and ReferralRegistry contracts.
    pub fn set_minter(env: Env, minter: Address) -> Result<(), TokenError> {
        let admin: Address = Self::require_admin(&env)?;
        admin.require_auth();

        env.storage()
            .persistent()
            .set(&DataKey::AuthorizedMinter(minter.clone()), &true);

        env.events().publish(
            (symbol_short!("minter"), symbol_short!("set")),
            minter,
        );

        Ok(())
    }

    /// Revoke minting permission from `minter`.
    pub fn remove_minter(env: Env, minter: Address) -> Result<(), TokenError> {
        let admin: Address = Self::require_admin(&env)?;
        admin.require_auth();

        env.storage()
            .persistent()
            .remove(&DataKey::AuthorizedMinter(minter.clone()));

        env.events().publish(
            (symbol_short!("minter"), symbol_short!("rm")),
            minter,
        );

        Ok(())
    }

    // ── Token Operations ──────────────────────────────────────────────────

    /// Mint `amount` tokens to `to`. `minter` must be an authorized minter
    /// contract (PredictionMarket or ReferralRegistry) and must provide auth.
    pub fn mint(env: Env, minter: Address, to: Address, amount: i128) -> Result<(), TokenError> {
        if amount <= 0 {
            return Err(TokenError::InvalidAmount);
        }

        minter.require_auth();

        let is_minter: bool = env
            .storage()
            .persistent()
            .get(&DataKey::AuthorizedMinter(minter))
            .unwrap_or(false);

        if !is_minter {
            return Err(TokenError::UnauthorizedMinter);
        }

        // Increment balance
        let balance = Self::balance(env.clone(), to.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Balance(to.clone()), &(balance + amount));

        // Increment total supply
        let supply: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &(supply + amount));

        env.events().publish(
            (symbol_short!("mint"),),
            (to, amount),
        );

        Ok(())
    }

    /// Transfer `amount` tokens from `from` to `to`.
    pub fn transfer(
        env: Env,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), TokenError> {
        if amount <= 0 {
            return Err(TokenError::InvalidAmount);
        }
        from.require_auth();

        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < amount {
            return Err(TokenError::InsufficientBalance);
        }

        // Debit sender
        env.storage()
            .persistent()
            .set(&DataKey::Balance(from.clone()), &(from_balance - amount));

        // Credit receiver
        let to_balance = Self::balance(env.clone(), to.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Balance(to.clone()), &(to_balance + amount));

        env.events().publish(
            (symbol_short!("transfer"),),
            (from, to, amount),
        );

        Ok(())
    }

    /// Burn `amount` tokens from `from`. The caller must authorize.
    pub fn burn(env: Env, from: Address, amount: i128) -> Result<(), TokenError> {
        if amount <= 0 {
            return Err(TokenError::InvalidAmount);
        }
        from.require_auth();

        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < amount {
            return Err(TokenError::InsufficientBalance);
        }

        // Debit balance
        env.storage()
            .persistent()
            .set(&DataKey::Balance(from.clone()), &(from_balance - amount));

        // Reduce total supply
        let supply: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &(supply - amount));

        env.events().publish(
            (symbol_short!("burn"),),
            (from, amount),
        );

        Ok(())
    }

    // ── View Functions ────────────────────────────────────────────────────

    /// Return the token balance of `account` (0 if never minted/transferred to).
    pub fn balance(env: Env, account: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(account))
            .unwrap_or(0)
    }

    /// Return the total supply of minted (minus burned) tokens.
    pub fn total_supply(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0)
    }

    /// Token name — "IPREDICT".
    pub fn name(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Name)
            .unwrap_or_else(|| String::from_str(&env, "IPREDICT"))
    }

    /// Token symbol — "IPRED".
    pub fn symbol(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Symbol)
            .unwrap_or_else(|| String::from_str(&env, "IPRED"))
    }

    /// Token decimals — 7.
    pub fn decimals(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Decimals)
            .unwrap_or(7)
    }

    // ── Internal Helpers ──────────────────────────────────────────────────

    fn require_admin(env: &Env) -> Result<Address, TokenError> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(TokenError::NotInitialized)
    }
}

#[cfg(test)]
mod tests;
