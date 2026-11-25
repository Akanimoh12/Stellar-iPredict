import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  describeCategoryResolverConfig,
  getResolversForCategory,
  isAuthorizedResolverForCategory,
  loadCategoryResolverConfig,
  type CategoryResolverConfig,
} from "../src/aggregator/category-resolvers.js";

// Valid Stellar Ed25519 public keys for testing (generated randomly)
const KEY_1 = Keypair.random().publicKey();
const KEY_2 = Keypair.random().publicKey();
const KEY_3 = Keypair.random().publicKey();
const KEY_4 = Keypair.random().publicKey();
const KEY_5 = Keypair.random().publicKey();

describe("category resolver mapping", () => {
  describe("loadCategoryResolverConfig", () => {
    it("loads default resolver set from COUNCIL_MEMBERS", () => {
      const config = loadCategoryResolverConfig({
        COUNCIL_MEMBERS: `${KEY_1},${KEY_2},${KEY_3}`,
      });
      expect(config.defaultResolvers).toEqual([KEY_1, KEY_2, KEY_3]);
      expect(config.categoryOverrides.size).toBe(0);
    });

    it("loads default resolver set from DEFAULT_RESOLVERS", () => {
      const config = loadCategoryResolverConfig({
        DEFAULT_RESOLVERS: `${KEY_1},${KEY_2}`,
      });
      expect(config.defaultResolvers).toEqual([KEY_1, KEY_2]);
    });

    it("prefers COUNCIL_MEMBERS over DEFAULT_RESOLVERS when both are set", () => {
      const config = loadCategoryResolverConfig({
        COUNCIL_MEMBERS: `${KEY_1}`,
        DEFAULT_RESOLVERS: `${KEY_2}`,
      });
      expect(config.defaultResolvers).toEqual([KEY_1]);
    });

    it("throws when no default resolver set is provided", () => {
      expect(() => loadCategoryResolverConfig({})).toThrow(
        "COUNCIL_MEMBERS or DEFAULT_RESOLVERS is required",
      );
    });

    it("throws when default resolver set is empty", () => {
      expect(() => loadCategoryResolverConfig({ COUNCIL_MEMBERS: "" })).toThrow(
        "COUNCIL_MEMBERS or DEFAULT_RESOLVERS is required",
      );
    });

    it("loads category-specific overrides", () => {
      const config = loadCategoryResolverConfig({
        COUNCIL_MEMBERS: `${KEY_1},${KEY_2}`,
        CATEGORY_RESOLVERS_CRYPTO: `${KEY_3},${KEY_4}`,
        CATEGORY_RESOLVERS_SPORTS: `${KEY_5}`,
      });
      expect(config.defaultResolvers).toEqual([KEY_1, KEY_2]);
      expect(config.categoryOverrides.get("Crypto")).toEqual([KEY_3, KEY_4]);
      expect(config.categoryOverrides.get("Sports")).toEqual([KEY_5]);
      expect(config.categoryOverrides.get("Politics")).toBeUndefined();
    });

    it("deduplicates resolver keys within a set", () => {
      const config = loadCategoryResolverConfig({
        COUNCIL_MEMBERS: `${KEY_1},${KEY_2},${KEY_1}`,
      });
      expect(config.defaultResolvers).toEqual([KEY_1, KEY_2]);
    });

    it("trims whitespace from keys", () => {
      const config = loadCategoryResolverConfig({
        COUNCIL_MEMBERS: ` ${KEY_1} , ${KEY_2} `,
      });
      expect(config.defaultResolvers).toEqual([KEY_1, KEY_2]);
    });

    it("validates that keys are valid Stellar public keys", () => {
      expect(() =>
        loadCategoryResolverConfig({
          COUNCIL_MEMBERS: "INVALID_KEY",
        }),
      ).toThrow();
    });

    it("ignores empty category overrides", () => {
      const config = loadCategoryResolverConfig({
        COUNCIL_MEMBERS: `${KEY_1}`,
        CATEGORY_RESOLVERS_CRYPTO: "",
        CATEGORY_RESOLVERS_SPORTS: "   ",
      });
      expect(config.categoryOverrides.size).toBe(0);
    });

    it("validates category-specific resolver keys", () => {
      expect(() =>
        loadCategoryResolverConfig({
          COUNCIL_MEMBERS: `${KEY_1}`,
          CATEGORY_RESOLVERS_CRYPTO: "INVALID_KEY",
        }),
      ).toThrow();
    });
  });

  describe("getResolversForCategory", () => {
    it("returns category-specific resolvers when override exists", () => {
      const config: CategoryResolverConfig = {
        defaultResolvers: [KEY_1, KEY_2],
        categoryOverrides: new Map([["Crypto", [KEY_3, KEY_4]]]),
      };
      expect(getResolversForCategory(config, "Crypto")).toEqual([KEY_3, KEY_4]);
    });

    it("returns default resolvers when no override exists", () => {
      const config: CategoryResolverConfig = {
        defaultResolvers: [KEY_1, KEY_2],
        categoryOverrides: new Map(),
      };
      expect(getResolversForCategory(config, "Sports")).toEqual([KEY_1, KEY_2]);
    });

    it("returns default resolvers for categories not in override map", () => {
      const config: CategoryResolverConfig = {
        defaultResolvers: [KEY_1, KEY_2],
        categoryOverrides: new Map([["Crypto", [KEY_3]]]),
      };
      expect(getResolversForCategory(config, "Politics")).toEqual([KEY_1, KEY_2]);
    });
  });

  describe("isAuthorizedResolverForCategory", () => {
    const config: CategoryResolverConfig = {
      defaultResolvers: [KEY_1, KEY_2],
      categoryOverrides: new Map([
        ["Crypto", [KEY_3, KEY_4]],
        ["Sports", [KEY_5]],
      ]),
    };

    it("authorizes resolver in category-specific set", () => {
      expect(isAuthorizedResolverForCategory(config, "Crypto", KEY_3)).toBe(true);
      expect(isAuthorizedResolverForCategory(config, "Crypto", KEY_4)).toBe(true);
      expect(isAuthorizedResolverForCategory(config, "Sports", KEY_5)).toBe(true);
    });

    it("rejects resolver not in category-specific set", () => {
      expect(isAuthorizedResolverForCategory(config, "Crypto", KEY_1)).toBe(false);
      expect(isAuthorizedResolverForCategory(config, "Sports", KEY_3)).toBe(false);
    });

    it("authorizes resolver in default set when no override exists", () => {
      expect(isAuthorizedResolverForCategory(config, "Politics", KEY_1)).toBe(true);
      expect(isAuthorizedResolverForCategory(config, "Politics", KEY_2)).toBe(true);
    });

    it("rejects resolver not in default set when no override exists", () => {
      expect(isAuthorizedResolverForCategory(config, "Politics", KEY_3)).toBe(false);
    });
  });

  describe("describeCategoryResolverConfig", () => {
    it("returns safe summary for logging", () => {
      const config: CategoryResolverConfig = {
        defaultResolvers: [KEY_1, KEY_2, KEY_3],
        categoryOverrides: new Map([
          ["Crypto", [KEY_4, KEY_5]],
          ["Sports", [KEY_1]],
        ]),
      };
      const description = describeCategoryResolverConfig(config);
      expect(description.defaultCount).toBe(3);
      expect(description.overrides).toEqual({
        Crypto: 2,
        Sports: 1,
      });
    });

    it("returns empty overrides when none are configured", () => {
      const config: CategoryResolverConfig = {
        defaultResolvers: [KEY_1],
        categoryOverrides: new Map(),
      };
      const description = describeCategoryResolverConfig(config);
      expect(description.defaultCount).toBe(1);
      expect(description.overrides).toEqual({});
    });
  });
});
