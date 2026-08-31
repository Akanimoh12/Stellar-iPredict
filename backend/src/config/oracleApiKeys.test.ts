import crypto from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import {
  credentialCanSubmitFor,
  DEFAULT_DEV_API_KEY,
  OracleApiKeyConfigError,
  parseOracleApiKeys,
  resolveOracleCredential,
  WILDCARD_PROVIDER,
} from "./oracleApiKeys.js";

/**
 * Issue #429: every provider used to share one credential, read from a
 * singular `ORACLE_API_KEY` that no `.env.example` ever mentioned. These cover
 * the three properties the acceptance criteria ask for — per-provider keys,
 * independent revocation, and a key that cannot act for another provider —
 * plus the configuration mistakes that would silently reinstate the old
 * behaviour.
 */

const PROVIDER_A = "GA" + "A".repeat(54);
const PROVIDER_B = "GB" + "B".repeat(54);

function hashOf(key: string): string {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}

function hashed(provider: string, key: string): string {
  return `${provider}:sha256$${hashOf(key)}`;
}

describe("parseOracleApiKeys", () => {
  it("parses one credential per provider", () => {
    const credentials = parseOracleApiKeys({
      raw: `${hashed(PROVIDER_A, "key-a")},${hashed(PROVIDER_B, "key-b")}`,
    });

    expect(credentials).toHaveLength(2);
    expect(credentials.map((c) => c.provider)).toEqual([PROVIDER_A, PROVIDER_B]);
    expect(credentials.every((c) => c.hashed)).toBe(true);
  });

  it("tolerates whitespace and empty entries around the separators", () => {
    const credentials = parseOracleApiKeys({
      raw: `  ${hashed(PROVIDER_A, "key-a")} , , ${hashed(PROVIDER_B, "key-b")}  ,`,
    });

    expect(credentials.map((c) => c.provider)).toEqual([PROVIDER_A, PROVIDER_B]);
  });

  it("accepts a raw key outside production, hashing it at parse time", () => {
    const warn = vi.fn();
    const credentials = parseOracleApiKeys({
      raw: `${PROVIDER_A}:plain-secret`,
      warn,
    });

    expect(credentials[0].hashed).toBe(false);
    expect(credentials[0].keyHash.toString("hex")).toBe(hashOf("plain-secret"));
    // The operator is told, because the environment now holds the key itself.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unhashed"));
  });

  it("refuses a raw key in production", () => {
    expect(() =>
      parseOracleApiKeys({ raw: `${PROVIDER_A}:plain-secret`, nodeEnv: "production" }),
    ).toThrow(/raw key/);
  });

  it("splits on the first colon only, so a credential may contain colons", () => {
    const credentials = parseOracleApiKeys({ raw: `${PROVIDER_A}:a:b:c` });

    expect(credentials[0].provider).toBe(PROVIDER_A);
    expect(credentials[0].keyHash.toString("hex")).toBe(hashOf("a:b:c"));
  });

  describe("configuration mistakes that would reinstate a shared key", () => {
    it("rejects two providers sharing one key", () => {
      expect(() =>
        parseOracleApiKeys({
          raw: `${hashed(PROVIDER_A, "same")},${hashed(PROVIDER_B, "same")}`,
        }),
      ).toThrow(/already in use by another provider/);
    });

    it("rejects a provider listed twice", () => {
      expect(() =>
        parseOracleApiKeys({
          raw: `${hashed(PROVIDER_A, "key-1")},${hashed(PROVIDER_A, "key-2")}`,
        }),
      ).toThrow(/appears more than once/);
    });

    it("rejects a configured wildcard provider", () => {
      expect(() =>
        parseOracleApiKeys({ raw: `${WILDCARD_PROVIDER}:sha256$${hashOf("k")}` }),
      ).toThrow(/every key must name the provider/);
    });
  });

  describe("malformed entries", () => {
    it.each([
      ["no separator", "just-a-key"],
      ["empty provider", ":sha256$" + hashOf("k")],
      ["empty credential", `${PROVIDER_A}:`],
      ["short digest", `${PROVIDER_A}:sha256$abc`],
      ["non-hex digest", `${PROVIDER_A}:sha256$${"z".repeat(64)}`],
    ])("rejects %s", (_label, raw) => {
      expect(() => parseOracleApiKeys({ raw })).toThrow(OracleApiKeyConfigError);
    });

    it("names the offending entry so a long list can be debugged", () => {
      expect(() =>
        parseOracleApiKeys({ raw: `${hashed(PROVIDER_A, "ok")},broken` }),
      ).toThrow(/entry 2/);
    });
  });

  describe("development fallback", () => {
    it("yields a wildcard credential when unset outside production", () => {
      const warn = vi.fn();
      const credentials = parseOracleApiKeys({ warn });

      expect(credentials).toHaveLength(1);
      expect(credentials[0].provider).toBe(WILDCARD_PROVIDER);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("development fallback"));
    });

    it("refuses to start production without credentials", () => {
      expect(() => parseOracleApiKeys({ nodeEnv: "production" })).toThrow(
        /no credentials configured/,
      );
    });

    it("treats an all-whitespace value as unset", () => {
      const credentials = parseOracleApiKeys({ raw: "   " });
      expect(credentials[0].provider).toBe(WILDCARD_PROVIDER);
    });
  });

  describe("legacy ORACLE_API_KEY", () => {
    /**
     * Failing at boot rather than at request time is the point: the old
     * variable would otherwise 401 every provider and leave an operator to
     * work out why from access logs.
     */
    it("fails production startup with a message naming the replacement", () => {
      expect(() =>
        parseOracleApiKeys({ legacyRaw: "old-shared-key", nodeEnv: "production" }),
      ).toThrow(/ORACLE_API_KEYS/);
    });

    it("warns but continues outside production", () => {
      const warn = vi.fn();
      parseOracleApiKeys({ legacyRaw: "old-shared-key", warn });

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("no longer supported"));
    });

    it("is ignored entirely once the plural form is set", () => {
      const warn = vi.fn();
      const credentials = parseOracleApiKeys({
        raw: hashed(PROVIDER_A, "key-a"),
        legacyRaw: "old-shared-key",
        warn,
      });

      expect(credentials).toHaveLength(1);
      expect(resolveOracleCredential("old-shared-key", credentials)).toBeNull();
    });
  });
});

describe("resolveOracleCredential", () => {
  const credentials = parseOracleApiKeys({
    raw: `${hashed(PROVIDER_A, "key-a")},${hashed(PROVIDER_B, "key-b")}`,
  });

  it("resolves each key to its own provider", () => {
    expect(resolveOracleCredential("key-a", credentials)?.provider).toBe(PROVIDER_A);
    expect(resolveOracleCredential("key-b", credentials)?.provider).toBe(PROVIDER_B);
  });

  it("returns null for an unknown key", () => {
    expect(resolveOracleCredential("key-c", credentials)).toBeNull();
  });

  it.each([
    ["undefined", undefined],
    ["empty string", ""],
  ])("returns null for %s", (_label, token) => {
    expect(resolveOracleCredential(token, credentials)).toBeNull();
  });

  it("does not match on a prefix or a differing case", () => {
    expect(resolveOracleCredential("key-", credentials)).toBeNull();
    expect(resolveOracleCredential("KEY-A", credentials)).toBeNull();
    expect(resolveOracleCredential("key-a ", credentials)).toBeNull();
  });

  /** Revoking one provider must not disturb the others. */
  it("keeps other providers working after one key is removed", () => {
    const afterRevocation = parseOracleApiKeys({ raw: hashed(PROVIDER_B, "key-b") });

    expect(resolveOracleCredential("key-a", afterRevocation)).toBeNull();
    expect(resolveOracleCredential("key-b", afterRevocation)?.provider).toBe(PROVIDER_B);
  });

  it("accepts the development key only through the fallback credential", () => {
    const dev = parseOracleApiKeys({});

    expect(resolveOracleCredential(DEFAULT_DEV_API_KEY, dev)?.provider).toBe(
      WILDCARD_PROVIDER,
    );
    expect(resolveOracleCredential(DEFAULT_DEV_API_KEY, credentials)).toBeNull();
  });
});

describe("credentialCanSubmitFor", () => {
  const credentials = parseOracleApiKeys({
    raw: `${hashed(PROVIDER_A, "key-a")},${hashed(PROVIDER_B, "key-b")}`,
  });
  const credentialA = credentials[0];

  it("permits the provider the key is bound to", () => {
    expect(credentialCanSubmitFor(credentialA, PROVIDER_A)).toBe(true);
  });

  /**
   * The security-relevant half of the issue: an authenticated request that can
   * still name any provider has gained little over the shared key.
   */
  it("refuses any other provider", () => {
    expect(credentialCanSubmitFor(credentialA, PROVIDER_B)).toBe(false);
    expect(credentialCanSubmitFor(credentialA, "GC" + "C".repeat(54))).toBe(false);
  });

  it("lets the development fallback act for anyone", () => {
    const [dev] = parseOracleApiKeys({});

    expect(credentialCanSubmitFor(dev, PROVIDER_A)).toBe(true);
    expect(credentialCanSubmitFor(dev, PROVIDER_B)).toBe(true);
  });
});
