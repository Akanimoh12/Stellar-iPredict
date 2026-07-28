import { StrKey } from "@stellar/stellar-sdk";

/**
 * Returns whether a value is a valid Stellar account address.
 *
 * Address matching is case-insensitive for normalization purposes; the
 * canonical representation returned by normalizeAddress is uppercase.
 */
export function isValidAddress(address: unknown): address is string {
  if (typeof address !== "string") {
    return false;
  }

  try {
    return StrKey.isValidEd25519PublicKey(address.trim().toUpperCase());
  } catch {
    return false;
  }
}

/**
 * Normalizes a Stellar account address to its canonical uppercase form.
 *
 * @throws Error when the value is not a valid Stellar G-address.
 */
export function normalizeAddress(address: string): string {
  if (!isValidAddress(address)) {
    throw new Error("Invalid Stellar address");
  }

  return address.trim().toUpperCase();
}
