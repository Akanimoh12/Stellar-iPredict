import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";

export type MarketCategory = "Crypto" | "Sports" | "Politics" | "Entertainment" | "Science" | "Other";

export const MARKET_CATEGORIES: readonly MarketCategory[] = [
  "Crypto",
  "Sports",
  "Politics",
  "Entertainment",
  "Science",
  "Other",
] as const;

export interface CategoryResolverConfig {
  /** Default resolver set for all categories unless overridden. */
  defaultResolvers: readonly string[];
  /** Optional category-specific resolver sets. */
  categoryOverrides: ReadonlyMap<MarketCategory, readonly string[]>;
}

const publicKeyString = z.string().refine(StrKey.isValidEd25519PublicKey, {
  message: "must be a valid Stellar Ed25519 public key",
});

/**
 * Parses comma-separated resolver keys and validates each one.
 * Deduplicates and returns an array of valid Stellar public keys.
 */
function parseResolverKeys(value: string): readonly string[] {
  const keys = value
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);

  const unique = Array.from(new Set(keys));
  const schema = z.array(publicKeyString);
  return schema.parse(unique);
}

/**
 * Loads category-specific resolver mappings from environment variables.
 *
 * Environment variables:
 * - `COUNCIL_MEMBERS` or `DEFAULT_RESOLVERS`: Default resolver set (required)
 * - `CATEGORY_RESOLVERS_<CATEGORY>`: Optional override for specific categories
 *   Examples: `CATEGORY_RESOLVERS_CRYPTO`, `CATEGORY_RESOLVERS_SPORTS`
 *
 * Each value is a comma-separated list of Stellar public keys (G...).
 * If a category-specific override is not set, the default resolver set is used.
 */
export function loadCategoryResolverConfig(
  env: NodeJS.ProcessEnv = process.env,
): CategoryResolverConfig {
  // Load default resolver set from COUNCIL_MEMBERS or DEFAULT_RESOLVERS
  const defaultValue = env.COUNCIL_MEMBERS || env.DEFAULT_RESOLVERS;
  if (!defaultValue) {
    throw new Error("COUNCIL_MEMBERS or DEFAULT_RESOLVERS is required for default resolver set");
  }
  const defaultResolvers = parseResolverKeys(defaultValue);

  if (defaultResolvers.length === 0) {
    throw new Error("Default resolver set must contain at least one valid public key");
  }

  // Load category-specific overrides
  const categoryOverrides = new Map<MarketCategory, readonly string[]>();
  for (const category of MARKET_CATEGORIES) {
    const envKey = `CATEGORY_RESOLVERS_${category.toUpperCase()}`;
    const value = env[envKey];
    if (value) {
      const resolvers = parseResolverKeys(value);
      if (resolvers.length > 0) {
        categoryOverrides.set(category, resolvers);
      }
    }
  }

  return { defaultResolvers, categoryOverrides };
}

/**
 * Returns the resolver set for a given market category.
 * Falls back to default resolvers if no category-specific override exists.
 */
export function getResolversForCategory(
  config: CategoryResolverConfig,
  category: MarketCategory,
): readonly string[] {
  return config.categoryOverrides.get(category) ?? config.defaultResolvers;
}

/**
 * Checks if a public key is authorized to resolve a market in the given category.
 */
export function isAuthorizedResolverForCategory(
  config: CategoryResolverConfig,
  category: MarketCategory,
  publicKey: string,
): boolean {
  const resolvers = getResolversForCategory(config, category);
  return resolvers.includes(publicKey);
}

/**
 * Returns a summary of the category resolver configuration (safe for logging).
 */
export function describeCategoryResolverConfig(
  config: CategoryResolverConfig,
): { defaultCount: number; overrides: Record<string, number> } {
  const overrides: Record<string, number> = {};
  for (const [category, resolvers] of config.categoryOverrides.entries()) {
    overrides[category] = resolvers.length;
  }
  return {
    defaultCount: config.defaultResolvers.length,
    overrides,
  };
}
