/**
 * Dispute council membership configuration  (#159)
 *
 * Configures and validates the dispute council set used by the optimistic
 * oracle.  The council is the final arbitrator when a submitted outcome is
 * challenged and escalated.
 *
 * ## Environment variables
 *
 * | Variable              | Required | Description                                              |
 * |-----------------------|----------|----------------------------------------------------------|
 * | COUNCIL_MEMBERS       | yes      | Comma-separated list of exactly `COUNCIL_SIZE` unique,   |
 * |                       |          | valid Stellar Ed25519 public keys.                       |
 * | RESOLVER_SECRET_KEY   | yes      | Signing key for submitting the on-chain resolution.      |
 * |                       |          | **Never log or serialize this value.**                   |
 * | COUNCIL_THRESHOLD     | no       | Min votes to reach a decision. Default: 4 (strict        |
 * |                       |          | majority of 7).                                          |
 * | COUNCIL_QUORUM        | no       | Min members that must vote before a decision is          |
 * |                       |          | recorded. Default: equals COUNCIL_THRESHOLD.             |
 *
 * ## Validation rules
 *
 * - Exactly `COUNCIL_SIZE` (7) members required — no more, no fewer.
 * - All public keys must be valid Stellar Ed25519 keys.
 * - No duplicate keys in `COUNCIL_MEMBERS`.
 * - `COUNCIL_THRESHOLD` must be a strict majority (> half of `COUNCIL_SIZE`).
 * - `COUNCIL_QUORUM` must be >= `COUNCIL_THRESHOLD`.
 * - `RESOLVER_SECRET_KEY` must be a valid Stellar Ed25519 seed.
 *
 * @see docs/ORACLE_AND_BACKEND.md §Option C — Resolution Council
 */

import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fixed council size as defined in the contract (COUNCIL_SIZE = 7). */
export const COUNCIL_SIZE = 7;

/**
 * Default threshold: 4-of-7 strict majority (matches contract constant
 * COUNCIL_THRESHOLD = 4).
 */
export const COUNCIL_DEFAULT_THRESHOLD = 4;

// ---------------------------------------------------------------------------
// Zod validators
// ---------------------------------------------------------------------------

const publicKeyString = z.string().refine(StrKey.isValidEd25519PublicKey, {
  message: "must be a valid Stellar Ed25519 public key",
});

const secretKeyString = z.string().refine(StrKey.isValidEd25519SecretSeed, {
  message: "must be a valid Stellar Ed25519 secret key",
});

const positiveInteger = z.coerce.number().int().positive();

const schema = z
  .object({
    COUNCIL_MEMBERS: z
      .string()
      .min(1, "COUNCIL_MEMBERS is required")
      .transform((value) =>
        value
          .split(",")
          .map((key) => key.trim())
          .filter(Boolean),
      )
      .pipe(
        z
          .array(publicKeyString)
          .length(COUNCIL_SIZE, `COUNCIL_MEMBERS must contain exactly ${COUNCIL_SIZE} keys`),
      )
      .refine((members) => new Set(members).size === members.length, {
        message: "COUNCIL_MEMBERS contains duplicate keys",
      }),

    /**
     * Minimum number of YES or NO votes for a decision to be accepted.
     * Must be a strict majority of COUNCIL_SIZE (> 3.5, so >= 4).
     */
    COUNCIL_THRESHOLD: positiveInteger.default(COUNCIL_DEFAULT_THRESHOLD),

    /**
     * Minimum number of members that must cast a vote before a decision is
     * recorded.  Defaults to COUNCIL_THRESHOLD (quorum = threshold).
     * Must be >= COUNCIL_THRESHOLD.
     */
    COUNCIL_QUORUM: positiveInteger.optional(),

    /** Resolver signing key used to submit the final on-chain resolution. Never logged. */
    RESOLVER_SECRET_KEY: secretKeyString,
  })
  .refine(
    (value) => value.COUNCIL_THRESHOLD > COUNCIL_SIZE / 2,
    {
      message: `COUNCIL_THRESHOLD must be a strict majority (> ${COUNCIL_SIZE / 2})`,
      path: ["COUNCIL_THRESHOLD"],
    },
  )
  .refine(
    (value) => value.COUNCIL_THRESHOLD <= COUNCIL_SIZE,
    {
      message: `COUNCIL_THRESHOLD cannot exceed COUNCIL_SIZE (${COUNCIL_SIZE})`,
      path: ["COUNCIL_THRESHOLD"],
    },
  )
  .refine(
    (value) => {
      const quorum = value.COUNCIL_QUORUM ?? value.COUNCIL_THRESHOLD;
      return quorum >= value.COUNCIL_THRESHOLD;
    },
    {
      message: "COUNCIL_QUORUM must be >= COUNCIL_THRESHOLD",
      path: ["COUNCIL_QUORUM"],
    },
  )
  .refine(
    (value) => {
      const quorum = value.COUNCIL_QUORUM ?? value.COUNCIL_THRESHOLD;
      return quorum <= COUNCIL_SIZE;
    },
    {
      message: `COUNCIL_QUORUM cannot exceed COUNCIL_SIZE (${COUNCIL_SIZE})`,
      path: ["COUNCIL_QUORUM"],
    },
  );

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CouncilConfig {
  /** The 7 registered council member public keys, deduplicated and validated. */
  members: readonly string[];

  /**
   * Minimum votes (yes or no) required for a decision to be valid.
   * Guaranteed to be a strict majority of `members.length`.
   */
  threshold: number;

  /**
   * Minimum number of member votes that must be cast before a decision can
   * be finalized.  Always >= `threshold`.
   */
  quorum: number;

  /** Resolver signing key — treat as a secret, never log or serialize this. */
  resolverSecretKey: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Loads and validates the council membership set from environment variables.
 *
 * Throws (fails boot) if:
 * - `COUNCIL_MEMBERS` does not contain exactly {@link COUNCIL_SIZE} unique,
 *   valid Stellar public keys.
 * - `COUNCIL_THRESHOLD` is not a strict majority or exceeds council size.
 * - `COUNCIL_QUORUM` (when set) is less than `COUNCIL_THRESHOLD` or exceeds
 *   council size.
 * - `RESOLVER_SECRET_KEY` is missing or malformed.
 */
export function loadCouncilConfig(env: NodeJS.ProcessEnv = process.env): CouncilConfig {
  const parsed = schema.parse(env);
  const threshold = parsed.COUNCIL_THRESHOLD;
  const quorum = parsed.COUNCIL_QUORUM ?? threshold;
  return {
    members: parsed.COUNCIL_MEMBERS,
    threshold,
    quorum,
    resolverSecretKey: parsed.RESOLVER_SECRET_KEY,
  };
}

/**
 * Returns `true` if `publicKey` is a registered council member.
 *
 * Performs an exact string match — callers must supply a canonical
 * Stellar public key (uppercase, no whitespace).
 */
export function isCouncilMember(config: CouncilConfig, publicKey: string): boolean {
  return config.members.includes(publicKey);
}

/**
 * Returns `true` if the given vote count meets quorum.
 *
 * Quorum must be reached before any threshold check is applied.
 */
export function hasQuorum(config: CouncilConfig, voteCount: number): boolean {
  return voteCount >= config.quorum;
}

/**
 * Returns `true` if the given outcome count meets the decision threshold.
 *
 * Call `hasQuorum` first — threshold alone does not guarantee a valid decision
 * if too few members voted.
 */
export function meetsThreshold(config: CouncilConfig, outcomeCount: number): boolean {
  return outcomeCount >= config.threshold;
}

/**
 * Safe-to-log representation of a council config.
 *
 * The resolver secret key is redacted so this object can be emitted to
 * structured logs or included in audit records without leaking credentials.
 */
export function describeCouncilConfig(
  config: CouncilConfig,
): {
  members: readonly string[];
  threshold: number;
  quorum: number;
  resolverSecretKey: string;
} {
  return {
    members: config.members,
    threshold: config.threshold,
    quorum: config.quorum,
    resolverSecretKey: "[REDACTED]",
  };
}
