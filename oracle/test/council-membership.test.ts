import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

import {
  loadCouncilConfig,
  isCouncilMember,
  hasQuorum,
  meetsThreshold,
  describeCouncilConfig,
  COUNCIL_SIZE,
  COUNCIL_DEFAULT_THRESHOLD,
} from "../src/config/council.js";

// ---------------------------------------------------------------------------
// Helpers — generate valid Stellar keys for tests
// ---------------------------------------------------------------------------

/** Generate N unique, valid Stellar Ed25519 public keys. */
function makePublicKeys(n: number): string[] {
  return Array.from({ length: n }, () => Keypair.random().publicKey());
}

function makeResolverSecret(): string {
  return Keypair.random().secret();
}

function buildEnv(
  overrides: Partial<{
    COUNCIL_MEMBERS: string;
    RESOLVER_SECRET_KEY: string;
    COUNCIL_THRESHOLD: string;
    COUNCIL_QUORUM: string;
  }> = {},
): NodeJS.ProcessEnv {
  const members = makePublicKeys(COUNCIL_SIZE);
  return {
    COUNCIL_MEMBERS: members.join(","),
    RESOLVER_SECRET_KEY: makeResolverSecret(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// loadCouncilConfig — happy path
// ---------------------------------------------------------------------------

describe("loadCouncilConfig", () => {
  it("parses a valid 7-member council with default threshold", () => {
    const env = buildEnv();
    const config = loadCouncilConfig(env);
    expect(config.members).toHaveLength(COUNCIL_SIZE);
    expect(config.threshold).toBe(COUNCIL_DEFAULT_THRESHOLD);
    expect(config.quorum).toBe(COUNCIL_DEFAULT_THRESHOLD);
    expect(config.resolverSecretKey).toBe(env.RESOLVER_SECRET_KEY);
  });

  it("parses a custom threshold", () => {
    const env = buildEnv({ COUNCIL_THRESHOLD: "5" });
    const config = loadCouncilConfig(env);
    expect(config.threshold).toBe(5);
    expect(config.quorum).toBe(5); // quorum defaults to threshold
  });

  it("parses a custom quorum higher than threshold", () => {
    const env = buildEnv({ COUNCIL_THRESHOLD: "4", COUNCIL_QUORUM: "6" });
    const config = loadCouncilConfig(env);
    expect(config.threshold).toBe(4);
    expect(config.quorum).toBe(6);
  });

  it("trims whitespace from member keys", () => {
    const keys = makePublicKeys(COUNCIL_SIZE);
    const env = buildEnv({ COUNCIL_MEMBERS: keys.map((k) => `  ${k}  `).join(",") });
    const config = loadCouncilConfig(env);
    expect(config.members).toHaveLength(COUNCIL_SIZE);
  });
});

// ---------------------------------------------------------------------------
// loadCouncilConfig — validation errors
// ---------------------------------------------------------------------------

describe("loadCouncilConfig — validation", () => {
  it("throws when COUNCIL_MEMBERS is missing", () => {
    const env = buildEnv({ COUNCIL_MEMBERS: "" });
    expect(() => loadCouncilConfig(env)).toThrow();
  });

  it("throws when fewer than 7 members are provided", () => {
    const env = buildEnv({ COUNCIL_MEMBERS: makePublicKeys(6).join(",") });
    expect(() => loadCouncilConfig(env)).toThrow();
  });

  it("throws when more than 7 members are provided", () => {
    const env = buildEnv({ COUNCIL_MEMBERS: makePublicKeys(8).join(",") });
    expect(() => loadCouncilConfig(env)).toThrow();
  });

  it("throws when a duplicate key appears", () => {
    const keys = makePublicKeys(6);
    const env = buildEnv({ COUNCIL_MEMBERS: [...keys, keys[0]].join(",") });
    expect(() => loadCouncilConfig(env)).toThrow(/duplicate/i);
  });

  it("throws when a key is not a valid Ed25519 public key", () => {
    const keys = makePublicKeys(6);
    const env = buildEnv({ COUNCIL_MEMBERS: [...keys, "not-a-key"].join(",") });
    expect(() => loadCouncilConfig(env)).toThrow();
  });

  it("throws when RESOLVER_SECRET_KEY is missing", () => {
    const env = buildEnv({ RESOLVER_SECRET_KEY: "" });
    expect(() => loadCouncilConfig(env)).toThrow();
  });

  it("throws when RESOLVER_SECRET_KEY is a public key, not a secret", () => {
    const env = buildEnv({ RESOLVER_SECRET_KEY: Keypair.random().publicKey() });
    expect(() => loadCouncilConfig(env)).toThrow();
  });

  it("throws when COUNCIL_THRESHOLD is not a strict majority", () => {
    // 3 is not > 3.5 (half of 7)
    const env = buildEnv({ COUNCIL_THRESHOLD: "3" });
    expect(() => loadCouncilConfig(env)).toThrow(/strict majority/i);
  });

  it("throws when COUNCIL_THRESHOLD exceeds COUNCIL_SIZE", () => {
    const env = buildEnv({ COUNCIL_THRESHOLD: "8" });
    expect(() => loadCouncilConfig(env)).toThrow();
  });

  it("throws when COUNCIL_QUORUM is less than COUNCIL_THRESHOLD", () => {
    const env = buildEnv({ COUNCIL_THRESHOLD: "5", COUNCIL_QUORUM: "4" });
    expect(() => loadCouncilConfig(env)).toThrow(/COUNCIL_QUORUM/);
  });

  it("throws when COUNCIL_QUORUM exceeds COUNCIL_SIZE", () => {
    const env = buildEnv({ COUNCIL_THRESHOLD: "4", COUNCIL_QUORUM: "8" });
    expect(() => loadCouncilConfig(env)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// isCouncilMember
// ---------------------------------------------------------------------------

describe("isCouncilMember", () => {
  it("returns true for a registered member", () => {
    const env = buildEnv();
    const config = loadCouncilConfig(env);
    const [first] = config.members;
    expect(isCouncilMember(config, first!)).toBe(true);
  });

  it("returns false for an unknown key", () => {
    const config = loadCouncilConfig(buildEnv());
    expect(isCouncilMember(config, Keypair.random().publicKey())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasQuorum / meetsThreshold
// ---------------------------------------------------------------------------

describe("hasQuorum", () => {
  it("returns true when vote count >= quorum", () => {
    const config = loadCouncilConfig(buildEnv());
    expect(hasQuorum(config, config.quorum)).toBe(true);
    expect(hasQuorum(config, config.quorum + 1)).toBe(true);
  });

  it("returns false when vote count < quorum", () => {
    const config = loadCouncilConfig(buildEnv());
    expect(hasQuorum(config, config.quorum - 1)).toBe(false);
  });
});

describe("meetsThreshold", () => {
  it("returns true when outcome count >= threshold", () => {
    const config = loadCouncilConfig(buildEnv());
    expect(meetsThreshold(config, config.threshold)).toBe(true);
  });

  it("returns false when outcome count < threshold", () => {
    const config = loadCouncilConfig(buildEnv());
    expect(meetsThreshold(config, config.threshold - 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// describeCouncilConfig
// ---------------------------------------------------------------------------

describe("describeCouncilConfig", () => {
  it("redacts the resolver secret key", () => {
    const config = loadCouncilConfig(buildEnv());
    const desc = describeCouncilConfig(config);
    expect(desc.resolverSecretKey).toBe("[REDACTED]");
    expect(desc.members).toEqual(config.members);
    expect(desc.threshold).toBe(config.threshold);
    expect(desc.quorum).toBe(config.quorum);
  });
});
