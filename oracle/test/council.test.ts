import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { describeCouncilConfig, isCouncilMember, loadCouncilConfig } from "../src/config/council.js";

function members(count: number): string[] {
  return Array.from({ length: count }, () => Keypair.random().publicKey());
}

describe("council registry + config", () => {
  it("loads a valid 7-member registry and resolver key", () => {
    const councilMembers = members(7);
    const resolverKey = Keypair.random().secret();

    const config = loadCouncilConfig({
      COUNCIL_MEMBERS: councilMembers.join(","),
      RESOLVER_SECRET_KEY: resolverKey,
    });

    expect(config.members).toEqual(councilMembers);
    expect(config.resolverSecretKey).toBe(resolverKey);
  });

  it("trims whitespace around comma-separated members", () => {
    const councilMembers = members(7);
    const config = loadCouncilConfig({
      COUNCIL_MEMBERS: councilMembers.map((key) => ` ${key} `).join(" , "),
      RESOLVER_SECRET_KEY: Keypair.random().secret(),
    });
    expect(config.members).toEqual(councilMembers);
  });

  it("fails boot when fewer than 7 members are configured", () => {
    expect(() =>
      loadCouncilConfig({
        COUNCIL_MEMBERS: members(6).join(","),
        RESOLVER_SECRET_KEY: Keypair.random().secret(),
      }),
    ).toThrow();
  });

  it("fails boot when a member key is malformed", () => {
    const councilMembers = [...members(6), "not-a-valid-key"];
    expect(() =>
      loadCouncilConfig({
        COUNCIL_MEMBERS: councilMembers.join(","),
        RESOLVER_SECRET_KEY: Keypair.random().secret(),
      }),
    ).toThrow();
  });

  it("fails boot on duplicate member keys", () => {
    const councilMembers = members(6);
    const duplicated = [...councilMembers, councilMembers[0]];
    expect(() =>
      loadCouncilConfig({
        COUNCIL_MEMBERS: duplicated.join(","),
        RESOLVER_SECRET_KEY: Keypair.random().secret(),
      }),
    ).toThrow("duplicate");
  });

  it("fails boot when the resolver secret key is missing or malformed", () => {
    const councilMembers = members(7);
    expect(() => loadCouncilConfig({ COUNCIL_MEMBERS: councilMembers.join(",") })).toThrow();
    expect(() =>
      loadCouncilConfig({ COUNCIL_MEMBERS: councilMembers.join(","), RESOLVER_SECRET_KEY: "not-a-secret" }),
    ).toThrow();
  });

  it("identifies registered council members", () => {
    const councilMembers = members(7);
    const config = loadCouncilConfig({
      COUNCIL_MEMBERS: councilMembers.join(","),
      RESOLVER_SECRET_KEY: Keypair.random().secret(),
    });

    expect(isCouncilMember(config, councilMembers[0])).toBe(true);
    expect(isCouncilMember(config, Keypair.random().publicKey())).toBe(false);
  });

  it("never exposes the resolver secret in a loggable description", () => {
    const config = loadCouncilConfig({
      COUNCIL_MEMBERS: members(7).join(","),
      RESOLVER_SECRET_KEY: Keypair.random().secret(),
    });

    const described = describeCouncilConfig(config);
    expect(described.resolverSecretKey).toBe("[REDACTED]");
    expect(JSON.stringify(described)).not.toContain(config.resolverSecretKey);
  });
});
