import { StrKey } from "@stellar/stellar-sdk";

const INVALID_ADDRESS_MESSAGE = "Invalid Stellar address";

function canonicalAddress(address: unknown): string | null {
  if (typeof address !== "string") {
    return null;
  }

  const normalized = address.trim().toUpperCase();
  return StrKey.isValidEd25519PublicKey(normalized) ? normalized : null;
}

/**
 * Normalize and validate a Stellar account address.
 *
 * Stellar account addresses are canonicalized to uppercase because their
 * base32 representation is case-insensitive, while the canonical form uses
 * uppercase characters.
 */
export function normalizeAddress(address: string): string {
  const normalized = canonicalAddress(address);

  if (normalized === null) {
    throw new TypeError(INVALID_ADDRESS_MESSAGE);
  }

  return normalized;
}

/**
 * Return whether a value is a valid Stellar account address.
 */
export function isValidAddress(address: unknown): address is string {
  return canonicalAddress(address) !== null;
}
