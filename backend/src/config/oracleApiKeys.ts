import crypto from "node:crypto";

/**
 * Per-provider oracle API credentials (issue #429).
 *
 * `.env.example` has always advertised `ORACLE_API_KEYS` as a list, but the
 * handler read the singular `ORACLE_API_KEY` and compared it against one
 * value. Every provider therefore shared one credential: it could not be
 * rotated for one provider without breaking all of them, a compromised key
 * could submit as anybody, and a log line could not say which key made a
 * submission.
 *
 * A credential here is a key *bound to a provider identity*. That binding is
 * the security-relevant half: authenticating a request and then letting its
 * body name any provider gains almost nothing over the shared key, because the
 * attacker's goal is to submit an outcome attributed to someone else.
 *
 * ## Format
 *
 * `ORACLE_API_KEYS` is a comma-separated list of `<provider>:<credential>`:
 *
 * ```
 * ORACLE_API_KEYS=GABC…XYZ:sha256$9f86d0…,GDEF…UVW:sha256$2c26b4…
 * ```
 *
 * `<provider>` is the provider's Stellar public key — the same value the
 * request body carries and the same one the submission signature is verified
 * against. Only the first `:` separates the two halves, so a credential may
 * contain colons.
 *
 * `<credential>` is either:
 *
 *   * `sha256$<64 lowercase hex>` — the SHA-256 of the API key. Preferred, and
 *     what the deployment docs tell operators to generate: the environment
 *     then holds a verifier rather than the secret itself, so a leaked config
 *     dump, process listing or crash report does not hand over working keys.
 *   * a raw key — accepted so a developer can run the stack without hashing
 *     anything first, and rejected outright in production (see
 *     `parseOracleApiKeys`).
 */

/** Prefix marking a hashed credential. `$` rather than `:` so the provider split stays unambiguous. */
const SHA256_PREFIX = "sha256$";

/**
 * Identity used by the development fallback credential.
 *
 * It authenticates but binds to no particular provider, which is precisely the
 * property this issue removes from production. It exists so the local stack
 * and the existing test-suite fixtures work without a configured key, and
 * `parseOracleApiKeys` refuses to produce it when `NODE_ENV=production`.
 */
export const WILDCARD_PROVIDER = "*";

/** The key the development fallback accepts. Never reachable in production. */
export const DEFAULT_DEV_API_KEY = "test-oracle-api-key";

export interface OracleCredential {
  /** Provider identity this key authenticates as, or `*` for the dev fallback. */
  provider: string;
  /** SHA-256 of the API key, as raw bytes. Raw keys are hashed at parse time. */
  keyHash: Buffer;
  /** Whether the configured value was already hashed. Reported at startup, never logged per-request. */
  hashed: boolean;
}

export class OracleApiKeyConfigError extends Error {
  constructor(message: string) {
    super(`ORACLE_API_KEYS: ${message}`);
    this.name = "OracleApiKeyConfigError";
  }
}

function sha256(value: string): Buffer {
  return crypto.createHash("sha256").update(Buffer.from(value, "utf8")).digest();
}

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Parse one `<provider>:<credential>` entry.
 *
 * @param allowRawKeys when false, a non-hashed credential is a configuration
 * error rather than a warning — see `parseOracleApiKeys`.
 */
function parseEntry(entry: string, index: number, allowRawKeys: boolean): OracleCredential {
  const separator = entry.indexOf(":");
  if (separator === -1) {
    throw new OracleApiKeyConfigError(
      `entry ${index + 1} is not in "<provider>:<credential>" form`,
    );
  }

  const provider = entry.slice(0, separator).trim();
  const credential = entry.slice(separator + 1).trim();

  if (!provider) {
    throw new OracleApiKeyConfigError(`entry ${index + 1} has an empty provider`);
  }
  if (provider === WILDCARD_PROVIDER) {
    // A configured wildcard would silently reinstate the shared-key behaviour
    // this issue exists to remove.
    throw new OracleApiKeyConfigError(
      `entry ${index + 1} uses "${WILDCARD_PROVIDER}" as a provider; every key must name the provider it authenticates`,
    );
  }
  if (!credential) {
    throw new OracleApiKeyConfigError(
      `entry ${index + 1} (provider "${provider}") has an empty credential`,
    );
  }

  if (credential.startsWith(SHA256_PREFIX)) {
    const hex = credential.slice(SHA256_PREFIX.length).toLowerCase();
    if (!HEX_64.test(hex)) {
      throw new OracleApiKeyConfigError(
        `entry ${index + 1} (provider "${provider}") has a malformed ${SHA256_PREFIX} digest; expected 64 hex characters`,
      );
    }
    return { provider, keyHash: Buffer.from(hex, "hex"), hashed: true };
  }

  if (!allowRawKeys) {
    throw new OracleApiKeyConfigError(
      `entry ${index + 1} (provider "${provider}") stores a raw key; production requires ${SHA256_PREFIX}<digest>`,
    );
  }

  return { provider, keyHash: sha256(credential), hashed: false };
}

export interface ParseOracleApiKeysOptions {
  /** Value of `ORACLE_API_KEYS`. */
  raw?: string;
  /** Value of the legacy singular `ORACLE_API_KEY`, if set. */
  legacyRaw?: string;
  /** `NODE_ENV`; production tightens every rule below. */
  nodeEnv?: string;
  /** Startup diagnostics. Called with messages that contain no secret material. */
  warn?: (message: string) => void;
}

/**
 * Build the credential set from the environment.
 *
 * Production is strict on purpose — each of these silently degraded to the
 * shared-key behaviour before:
 *
 *   * no credentials configured → error, rather than falling back to a
 *     well-known development key that is published in this file;
 *   * a raw (unhashed) key → error, so the environment holds verifiers only;
 *   * the legacy singular `ORACLE_API_KEY` → error naming the replacement,
 *     rather than 401-ing every provider at runtime and leaving an operator to
 *     work out why from access logs.
 *
 * Outside production the same conditions are warnings, and an unconfigured
 * environment yields the wildcard development credential.
 */
export function parseOracleApiKeys(
  options: ParseOracleApiKeysOptions = {},
): OracleCredential[] {
  const { raw, legacyRaw, nodeEnv, warn = () => {} } = options;
  const isProduction = nodeEnv === "production";

  const trimmed = raw?.trim() ?? "";

  if (!trimmed) {
    if (legacyRaw?.trim()) {
      const message =
        "ORACLE_API_KEY (singular) is no longer supported; it authenticated every provider with one shared key. " +
        'Use ORACLE_API_KEYS="<provider>:sha256$<digest>,…" so each key names the provider it may submit for.';
      if (isProduction) {
        throw new OracleApiKeyConfigError(message);
      }
      warn(message);
    }

    if (isProduction) {
      throw new OracleApiKeyConfigError(
        'no credentials configured; set ORACLE_API_KEYS="<provider>:sha256$<digest>,…"',
      );
    }

    warn(
      "ORACLE_API_KEYS is unset; using the development fallback key, which may submit as any provider. " +
        "Never deploy this configuration — production refuses to start without real credentials.",
    );
    return [
      {
        provider: WILDCARD_PROVIDER,
        keyHash: sha256(DEFAULT_DEV_API_KEY),
        hashed: false,
      },
    ];
  }

  const entries = trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    throw new OracleApiKeyConfigError("contains no entries");
  }

  const credentials = entries.map((entry, index) =>
    parseEntry(entry, index, !isProduction),
  );

  const seenProviders = new Set<string>();
  const seenHashes = new Set<string>();

  for (const credential of credentials) {
    if (seenProviders.has(credential.provider)) {
      throw new OracleApiKeyConfigError(
        `provider "${credential.provider}" appears more than once; a provider has exactly one active key`,
      );
    }
    seenProviders.add(credential.provider);

    // Two providers sharing a key is the exact problem this replaces: revoking
    // it would cut off both, and a submission could not be attributed.
    const fingerprint = credential.keyHash.toString("hex");
    if (seenHashes.has(fingerprint)) {
      throw new OracleApiKeyConfigError(
        `the key for provider "${credential.provider}" is already in use by another provider; keys must be unique per provider`,
      );
    }
    seenHashes.add(fingerprint);
  }

  const rawCount = credentials.filter((credential) => !credential.hashed).length;
  if (rawCount > 0) {
    warn(
      `${rawCount} of ${credentials.length} oracle credentials are stored unhashed; ` +
        `use ${SHA256_PREFIX}<digest> so the environment holds a verifier rather than the key itself.`,
    );
  }

  return credentials;
}

/**
 * Resolve a presented API key to the provider it authenticates as, or `null`.
 *
 * Every credential is compared, with no early exit and with
 * `timingSafeEqual` over fixed-width digests, so neither the time taken nor
 * the number of comparisons reveals which provider matched or how many keys
 * are configured.
 */
export function resolveOracleCredential(
  token: string | undefined,
  credentials: readonly OracleCredential[],
): OracleCredential | null {
  if (token === undefined || token === "") {
    return null;
  }

  const presented = sha256(token);
  let match: OracleCredential | null = null;

  for (const credential of credentials) {
    // Digests are always 32 bytes, so timingSafeEqual never throws on length.
    if (crypto.timingSafeEqual(presented, credential.keyHash)) {
      match = credential;
    }
  }

  return match;
}

/**
 * Whether `credential` may submit on behalf of `provider`.
 *
 * The wildcard development credential may act for anyone; a real credential
 * may act only for the provider it is bound to. This is the check that makes
 * the difference between "the caller holds a valid key" and "the caller holds
 * *this provider's* key".
 */
export function credentialCanSubmitFor(
  credential: OracleCredential,
  provider: string,
): boolean {
  return (
    credential.provider === WILDCARD_PROVIDER || credential.provider === provider
  );
}

/** Human-readable identity for logs. Never includes key material. */
export function credentialIdentity(credential: OracleCredential): string {
  return credential.provider;
}
