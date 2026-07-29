import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

const COUNCIL_SIZE = 7;

const publicKeyString = z.string().refine(StrKey.isValidEd25519PublicKey, {
  message: "must be a valid Stellar Ed25519 public key",
});

const secretKeyString = z.string().refine(StrKey.isValidEd25519SecretSeed, {
  message: "must be a valid Stellar Ed25519 secret key",
});

const schema = z.object({
  COUNCIL_MEMBERS: z
    .string()
    .min(1, "COUNCIL_MEMBERS is required")
    .transform((value) =>
      value
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean),
    )
    .pipe(z.array(publicKeyString).length(COUNCIL_SIZE, `COUNCIL_MEMBERS must contain exactly ${COUNCIL_SIZE} keys`))
    .refine((members) => new Set(members).size === members.length, {
      message: "COUNCIL_MEMBERS contains duplicate keys",
    }),

  /** Resolver signing key used to submit the final on-chain resolution. Never logged. */
  RESOLVER_SECRET_KEY: secretKeyString,
});

export interface CouncilConfig {
  /** The 7 registered council member public keys, deduplicated. */
  members: readonly string[];
  /** Resolver signing key — treat as a secret, never log or serialize this. */
  resolverSecretKey: string;
}

/**
 * Loads and validates the council registry from environment variables.
 *
 * Fails boot (throws) if `COUNCIL_MEMBERS` does not contain exactly
 * {@link COUNCIL_SIZE} unique, valid Stellar public keys, or if
 * `RESOLVER_SECRET_KEY` is missing or malformed.
 */
export function loadCouncilConfig(env: NodeJS.ProcessEnv = process.env): CouncilConfig {
  const parsed = schema.parse(env);
  return { members: parsed.COUNCIL_MEMBERS, resolverSecretKey: parsed.RESOLVER_SECRET_KEY };
}

export function isCouncilMember(config: CouncilConfig, publicKey: string): boolean {
  return config.members.includes(publicKey);
}

/** Safe-to-log representation of a council config — the resolver secret is redacted. */
export function describeCouncilConfig(config: CouncilConfig): { members: readonly string[]; resolverSecretKey: string } {
  return { members: config.members, resolverSecretKey: "[REDACTED]" };
}
