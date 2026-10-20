/**
 * Market mappability (issue #745).
 *
 * A market whose question cannot be mapped to a provider query — an
 * unrecognised ticker, a category no adapter serves, a symbol no provider
 * lists — cannot be resolved by *any* adapter. Today that is discovered when
 * the market expires, at which point resolution is urgent, the market holds
 * user stakes, and the only available action is manual intervention under
 * time pressure.
 *
 * This module moves that discovery to creation time, and gives an operator a
 * way to fix the market afterwards without a redeploy:
 *
 *   1. {@link MarketMappabilityRegistry} knows which provider symbols exist
 *      and which categories are served, plus any operator-supplied additions.
 *   2. {@link validateMarketMappability} answers "can anything resolve this?"
 *      with a reason and the steps to fix it.
 *   3. {@link collectUnmappableMarkets} sweeps open markets so the ones
 *      created before this validation existed are reported with their time
 *      remaining, not discovered at expiry.
 *
 * ## Overrides without a redeploy
 *
 * A symbol that needs adding is a configuration change, not a code change.
 * {@link MappabilityOverrides} reads a JSON file and/or a JSON environment
 * variable on every evaluation, so an operator can drop a file into a mounted
 * volume and have it take effect. A missing override file is not an error —
 * the file is optional — but a *malformed* one is, because silently ignoring
 * it would look exactly like "the override did not apply".
 */

import { readFileSync as readTextFile } from "node:fs";

import type { DataAdapter, Market } from "./index.js";
import { isCryptoMarketParams, isPoliticsMarketParams } from "./index.js";

// ─────────────────────────────────────────────────────────────────────────────
// What can be mapped
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Provider symbols the oracle can query, keyed by adapter.
 *
 * A deliberately short list. It is not an attempt to enumerate every
 * instrument a provider lists — that would go stale weekly and would still not
 * answer the real question, which is "will *an adapter we run* accept this?".
 * It covers the instruments the platform actually creates markets for, and
 * {@link MappabilityOverrides} is the escape hatch for everything else.
 */
export const DEFAULT_MAPPABLE_SYMBOLS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  binance: Object.freeze([
    "BTCUSDT", "ETHUSDT", "XLMUSDT", "SOLUSDT", "ADAUSDT", "DOGEUSDT",
    "LTCUSDT", "BCHUSDT", "LINKUSDT", "DOTUSDT", "MATICUSDT", "AVAXUSDT",
    "ATOMUSDT", "UNIUSDT", "XMRUSDT", "ETCUSDT", "NEARUSDT", "APTUSDT",
    "ARBUSDT", "OPUSDT", "INJUSDT", "FILUSDT", "SUIUSDT", "TRXUSDT",
  ]),
  coinmarketcap: Object.freeze([
    "BTC", "ETH", "XLM", "SOL", "ADA", "DOGE", "LTC", "BCH", "LINK", "DOT",
    "MATIC", "AVAX", "ATOM", "UNI", "XMR", "ETC", "NEAR", "APT", "ARB", "OP",
    "INJ", "FIL", "SUI", "TRX",
  ]),
  coingecko: Object.freeze([
    "bitcoin", "ethereum", "stellar", "solana", "cardano", "dogecoin",
    "litecoin", "bitcoin-cash", "chainlink", "polkadot", "matic-network",
    "avalanche-2", "cosmos", "uniswap", "monero", "ethereum-classic",
    "near", "aptos", "arbitrum", "optimism", "injective-protocol",
    "filecoin", "sui", "tron",
  ]),
});

/** Categories that adapters serve at all. */
export const MAPPABLE_CATEGORIES = Object.freeze(["crypto", "sports", "politics", "science"] as const);

/**
 * Normalizes a category to the form the adapters use.
 *
 * Necessary rather than cosmetic: Postgres stores `MARKET_CATEGORIES`, which
 * is title case (`"Crypto"`), while the adapter layer uses
 * `ADAPTER_MARKET_CATEGORIES`, which is lower case. The sweep reads straight
 * out of the database, so without this every swept market would be rejected
 * for an unsupported category and the sweep would report the entire table.
 */
export function normalizeCategory(category: string): string {
  return category.trim().toLowerCase();
}

/** Why a market could not be mapped. Ordered roughly from most to least specific. */
export type UnmappableReason =
  /** No adapter is registered for the market's category. */
  | "unsupported-category"
  /** The category is served, but `params` lack the fields its adapters require. */
  | "missing-params"
  /** A crypto market whose symbol no known provider lists. */
  | "unknown-symbol"
  /** A politics market whose provider id no adapter recognises. */
  | "unknown-market-id"
  /**
   * The market's adapter params are not available, so it could not be
   * classified either way. See {@link UNKNOWN_PARAMS_NOTE}.
   */
  | "unknown-params";

/**
 * A limitation worth stating rather than working around silently.
 *
 * Market→adapter params (`symbol`, `comparator`, `threshold`) exist **only** in
 * the oracle's in-memory market objects. They are not in the `market_created`
 * contract event, and `markets` has no column for them — a query of the
 * database cannot tell you what any given market should be resolved against.
 *
 * That is exactly why this issue exists, and it constrains what the sweep can
 * do: with only `id`, `question` and `category`, a market cannot be classified
 * as mappable or unmappable. The sweep therefore reports such a market as
 * `unknown-params` — *unclassified*, needing a human — rather than guessing
 * from the question text or, worse, reporting it as fine.
 *
 * Supplying the params removes the ambiguity:
 * `sweepUnmappable` accepts them via `--params <file>`, and creation-time
 * validation is unaffected because it runs where the params are still in hand.
 */
export const UNKNOWN_PARAMS_NOTE =
  "Market→adapter params are not stored in the database or emitted on chain, so this market " +
  "could not be classified. Supply its params (--params <file>) or validate it at creation time.";

/** A single, actionable reason a market cannot be resolved. */
export interface MappabilityVerdict {
  /** Whether any adapter can resolve this market. */
  mappable: boolean;
  /** Adapters that can resolve it, in priority order. Empty when unmappable. */
  supportedAdapters: string[];
  reason?: UnmappableReason;
  /** One sentence, safe to show a user or log verbatim. */
  detail?: string;
  /**
   * What to do about it. Present only when unmappable — an unmappable market
   * with no next step is the situation this module exists to end.
   */
  remedy?: string;
  /** The symbol/marketId that failed, for a targeted override. */
  offendingValue?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Overrides
// ─────────────────────────────────────────────────────────────────────────────

export interface MappabilityOverride {
  /** Extra symbols an adapter can query, e.g. `binance: ["TONUSDT"]`. */
  symbols?: Record<string, string[]>;
  /** Extra categories that are considered served, e.g. `["entertainment"]`. */
  categories?: string[];
  /**
   * Explicitly mark a symbol as unservable, overriding a default. Used when a
   * provider delists something the default list still claims.
   */
  unsupported?: Record<string, string[]>;
}

export interface MappabilityOverridesOptions {
  /** Path to a JSON file holding {@link MappabilityOverride}. Optional. */
  filePath?: string;
  /** Environment to read `MARKET_MAPPABILITY_OVERRIDES` from. */
  env?: Record<string, string | undefined>;
  /** Injected file reader, for tests. */
  readFile?: (path: string) => string;
}

const OVERRIDE_ENV_VAR = "MARKET_MAPPABILITY_OVERRIDES";

/**
 * Operator-supplied additions, read fresh on every lookup.
 *
 * Re-read rather than cached because the point is to let an operator add a
 * mapping for a market that needs one *without a redeploy* — a cached snapshot
 * taken at process start would be the same as no override at all for exactly
 * the case it exists for.
 */
export class MappabilityOverrides {
  private readonly filePath: string | undefined;
  private readonly env: Record<string, string | undefined>;
  private readonly readFile: (path: string) => string;

  constructor(options: MappabilityOverridesOptions = {}) {
    this.filePath = options.filePath ?? process.env.MARKET_MAPPABILITY_OVERRIDES_FILE;
    this.env = options.env ?? process.env;
    this.readFile = options.readFile ?? ((path) => readTextFile(path, "utf8"));
  }

  /**
   * The merged override, or `undefined` when nothing is configured.
   *
   * Throws on malformed input rather than ignoring it. An operator who writes
   * a broken override file must be told, because the alternative — silently
   * falling back to the defaults — looks exactly like the override having been
   * applied and had no effect.
   */
  load(): MappabilityOverride | undefined {
    let merged: MappabilityOverride | undefined;

    const fromEnv = this.env[OVERRIDE_ENV_VAR];
    if (fromEnv !== undefined && fromEnv.trim().length > 0) {
      merged = mergeOverride(merged, parseOverride(fromEnv, OVERRIDE_ENV_VAR));
    }

    if (this.filePath !== undefined && this.filePath.length > 0) {
      let raw: string;
      try {
        raw = this.readFile(this.filePath);
      } catch (error) {
        throw new Error(
          `market mappability overrides: cannot read ${this.filePath} — ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      merged = mergeOverride(merged, parseOverride(raw, this.filePath));
    }

    return merged;
  }
}

function mergeOverride(base: MappabilityOverride | undefined, next: MappabilityOverride): MappabilityOverride {
  if (!base) return next;
  return {
    symbols: mergeSymbolMaps(base.symbols, next.symbols),
    unsupported: mergeSymbolMaps(base.unsupported, next.unsupported),
    categories: [...(base.categories ?? []), ...(next.categories ?? [])],
  };
}

function mergeSymbolMaps(
  base: Record<string, string[]> | undefined,
  next: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  if (!base) return next;
  if (!next) return base;
  const merged: Record<string, string[]> = { ...base };
  for (const [adapter, symbols] of Object.entries(next)) {
    merged[adapter] = [...(merged[adapter] ?? []), ...symbols];
  }
  return merged;
}

function parseOverride(raw: string, source: string): MappabilityOverride {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `market mappability overrides: ${source} is not valid JSON — ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`market mappability overrides: ${source} must be a JSON object`);
  }

  const record = parsed as Record<string, unknown>;
  const override: MappabilityOverride = {};

  if (record.symbols !== undefined) {
    override.symbols = readSymbolMap(record.symbols, `${source} .symbols`);
  }
  if (record.unsupported !== undefined) {
    override.unsupported = readSymbolMap(record.unsupported, `${source} .unsupported`);
  }
  if (record.categories !== undefined) {
    if (!Array.isArray(record.categories) || record.categories.some((c) => typeof c !== "string")) {
      throw new Error(`market mappability overrides: ${source} .categories must be a list of strings`);
    }
    override.categories = record.categories as string[];
  }

  return override;
}

function readSymbolMap(value: unknown, label: string): Record<string, string[]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`market mappability overrides: ${label} must be an object of adapter → symbols`);
  }
  const result: Record<string, string[]> = {};
  for (const [adapter, symbols] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(symbols) || symbols.some((s) => typeof s !== "string")) {
      throw new Error(`market mappability overrides: ${label}.${adapter} must be a list of strings`);
    }
    result[adapter] = symbols as string[];
  }
  return result;
}

// `readFileSync` is imported lazily so the module stays usable in environments
// (like a bundled CLI) where node:fs is present but not wanted at import time.
function readFileSync(path: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync: read } = require("node:fs") as typeof import("node:fs");
  return read(path, "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

export interface MappabilityRegistryOptions {
  symbols?: Record<string, readonly string[]>;
  categories?: readonly string[];
}

/**
 * The set of markets any configured adapter can resolve.
 *
 * Constructed with the adapter ids actually in use, so "mappable" means
 * "mappable *by this deployment*" rather than "mappable in principle" — a
 * deployment that never configures CoinMarketCap should not consider a
 * CMC-only symbol resolvable.
 */
export class MarketMappabilityRegistry {
  private readonly symbols: Map<string, Set<string>>;
  private readonly categories: Set<string>;

  constructor(adapterIds: readonly string[], options: MappabilityRegistryOptions = {}) {
    const base = options.symbols ?? DEFAULT_MAPPABLE_SYMBOLS;
    this.symbols = new Map();
    for (const adapterId of adapterIds) {
      // Fall back to the defaults for an adapter we hold no explicit symbol
      // list for, so adding an adapter does not also mean editing this table.
      this.symbols.set(adapterId, new Set(base[adapterId] ?? []));
    }
    this.categories = new Set(options.categories ?? MAPPABLE_CATEGORIES);
  }

  /**
   * Builds a registry from live adapters, so the symbol lists cover exactly
   * the adapters this deployment runs.
   */
  static fromAdapters(
    adapters: readonly DataAdapter[],
    options: MappabilityRegistryOptions = {},
  ): MarketMappabilityRegistry {
    return new MarketMappabilityRegistry(
      adapters.map((adapter) => adapter.id),
      options,
    );
  }

  /** Adapter ids this registry knows about. */
  get adapterIds(): string[] {
    return [...this.symbols.keys()];
  }

  /** Adds symbols for an adapter at runtime. The in-process equivalent of an override. */
  addSymbols(adapterId: string, symbols: readonly string[]): void {
    const set = this.symbols.get(adapterId) ?? new Set<string>();
    for (const symbol of symbols) set.add(symbol.toUpperCase());
    this.symbols.set(adapterId, set);
  }

  /** Marks a category as served. */
  addCategory(category: string): void {
    this.categories.add(category);
  }

  /** Whether any known adapter can query this symbol. */
  isSymbolKnown(symbol: string, overrides?: MappabilityOverride): boolean {
    const normalized = symbol.trim().toUpperCase();

    // An `unsupported` entry wins over everything, including an added
    // symbol: it exists for the case where a provider delists something the
    // default list still claims, and a symbol cannot be both.
    const blocked = new Set(
      Object.values(overrides?.unsupported ?? {}).flatMap((symbols) =>
        symbols.map((s) => s.toUpperCase()),
      ),
    );
    if (blocked.has(normalized)) return false;

    for (const symbols of Object.values(overrides?.symbols ?? {})) {
      if (symbols.some((s) => s.toUpperCase() === normalized)) return true;
    }

    for (const set of this.symbols.values()) {
      if (set.has(normalized)) return true;
    }
    return false;
  }

  /** Whether any adapter serves this category. */
  isCategorySupported(category: string, overrides?: MappabilityOverride): boolean {
    const normalized = normalizeCategory(category);
    if (this.categories.has(normalized)) return true;
    return (overrides?.categories ?? []).some((c) => normalizeCategory(c) === normalized);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidateMappabilityOptions {
  /** Live adapters. When given, `supports()` is the authority on the final answer. */
  adapters?: readonly DataAdapter[];
  /** Operator overrides, usually from {@link MappabilityOverrides}. */
  overrides?: MappabilityOverride;
  /** Registry to check against. Required unless `adapters` is given. */
  registry?: MarketMappabilityRegistry;
}

/**
 * Answers whether anything can resolve this market, and if not, why.
 *
 * Two layers, in a deliberate order:
 *
 *   1. **Live adapters** are consulted first. `supports()` is what resolution
 *      will actually call, so an adapter claiming the market settles it.
 *   2. **The registry** answers for everything the adapters did not. This
 *      layer is what makes creation-time validation possible at all: it works
 *      when no adapter is loaded, which is the situation when a market is
 *      created and the oracle may not even be running.
 *
 * The registry is consulted *before* concluding "unmappable", not after, and
 * that ordering is load-bearing: an operator override exists precisely to
 * declare a mapping valid when the shipped defaults do not know it. If the
 * registry ran only as a fallback, adding an override would leave the adapters
 * still refusing the market and the override would do nothing.
 */
export function validateMarketMappability(
  market: Market,
  options: ValidateMappabilityOptions = {},
): MappabilityVerdict {
  const { adapters, overrides, registry } = options;

  // Layer 1: an adapter claims it. Definitive.
  const supportedAdapters = adapters?.filter((adapter) => adapter.supports(market)).map((a) => a.id) ?? [];
  if (adapters && supportedAdapters.length > 0) {
    return { mappable: true, supportedAdapters };
  }

  const effective = registry ?? (adapters ? MarketMappabilityRegistry.fromAdapters(adapters) : undefined);
  if (!effective) {
    // Nothing to check against. Saying "mappable" would be a guess, and this
    // function's entire value is not guessing.
    return {
      mappable: false,
      supportedAdapters: [],
      reason: "unsupported-category",
      detail: "No mappability registry or adapter set was supplied, so mappability could not be determined",
      remedy: "Pass `registry` or `adapters` to validateMarketMappability",
    };
  }

  if (!effective.isCategorySupported(market.category, overrides)) {
    return {
      mappable: false,
      supportedAdapters: [],
      reason: "unsupported-category",
      detail: `No adapter serves category "${market.category}"`,
      remedy:
        `Add "${normalizeCategory(market.category)}" to MARKET_MAPPABILITY_OVERRIDES .categories if an adapter does serve it, ` +
        `or create the market with a supported category (${[...MAPPABLE_CATEGORIES].join(", ")})`,
    };
  }

  const category = normalizeCategory(market.category);

  // Params are not in the database or on chain, so a market reaching the
  // validator without them could belong to any adapter. Classifying it either
  // way would be a guess, and this function's whole value is not guessing.
  if (market.params === undefined || market.params === null) {
    return {
      mappable: false,
      supportedAdapters: [],
      reason: "unknown-params",
      detail: `No adapter params available for market "${market.id}"`,
      remedy: UNKNOWN_PARAMS_NOTE,
    };
  }

  if (category === "crypto") {
    if (!isCryptoMarketParams(market.params)) {
      return {
        mappable: false,
        supportedAdapters: [],
        reason: "missing-params",
        detail: 'Crypto markets need params.symbol, params.comparator ("gte"|"lte") and params.threshold',
        remedy: "Set all three params on the market; without them no adapter can build a query",
      };
    }
    if (!effective.isSymbolKnown(market.params.symbol, overrides)) {
      const symbol = market.params.symbol;
      return {
        mappable: false,
        supportedAdapters: [],
        reason: "unknown-symbol",
        detail: `No configured provider lists "${symbol}"`,
        offendingValue: symbol,
        remedy: unknownSymbolRemedy(symbol),
      };
    }
  }

  if (category === "politics" && !isPoliticsMarketParams(market.params)) {
    return {
      mappable: false,
      supportedAdapters: [],
      reason: "missing-params",
      detail: 'Politics markets need params.marketId and params.expectedOutcome',
      remedy: "Set both params on the market; without them no adapter can build a query",
    };
  }

  // The registry knows the category, the params are well-formed, and — for
  // crypto — the symbol is listed. Anything that reached this point is
  // mappable, including via an override that the live adapters do not know
  // about. That is the whole point of an override.
  return { mappable: true, supportedAdapters };
}

/** Quote suffixes offered in a remedy, so the suggestion is not nonsense. */
const QUOTE_SUFFIXES = ["USDT", "USDC", "USD", "BTC", "ETH"] as const;

function unknownSymbolRemedy(symbol: string): string {
  const upper = symbol.toUpperCase();
  // Appending a suffix to a symbol that already carries one produces
  // "TIAUSDTUSDT", which an operator may reasonably take literally.
  const needsSuffix = !QUOTE_SUFFIXES.some((suffix) => upper.endsWith(suffix));
  const bare = needsSuffix ? upper.replace(QUOTE_SUFFIXES.find((s) => upper.endsWith(s)) ?? "", "") : upper;

  return (
    `Add the provider's own symbol to MARKET_MAPPABILITY_OVERRIDES .symbols, e.g. ` +
    `{"binance":["${needsSuffix ? `${bare}USDT` : upper}"],"coinmarketcap":["${bare}"]}. ` +
    "Confirm the symbol exists at the provider first — an override declares a mapping valid, " +
    "it cannot make a provider list an instrument."
  );
}

/**
 * Throws unless the market is mappable.
 *
 * The creation-time form: an unmappable market should be *rejected* while
 * there is still time to create a different one, rather than accepted and
 * discovered at expiry.
 */
export function assertMarketMappable(
  market: Market,
  options: ValidateMappabilityOptions = {},
): MappabilityVerdict {
  const verdict = validateMarketMappability(market, options);
  if (verdict.mappable) return verdict;

  throw new UnmappableMarketError(market, verdict);
}

export class UnmappableMarketError extends Error {
  readonly marketId: string;
  readonly reason: UnmappableReason;
  readonly verdict: MappabilityVerdict;

  constructor(market: Market, verdict: MappabilityVerdict) {
    super(
      `Market "${market.id}" cannot be resolved by any adapter: ${verdict.detail}. ${verdict.remedy ?? ""}`.trim(),
    );
    this.name = "UnmappableMarketError";
    this.marketId = market.id;
    this.reason = verdict.reason ?? "unsupported-category";
    this.verdict = verdict;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sweep
// ─────────────────────────────────────────────────────────────────────────────

/** A market that is open but that no adapter can resolve. */
export interface UnmappableOpenMarket {
  id: string;
  question?: string;
  category: string;
  /** Market end time, epoch seconds. */
  endTimeSeconds?: number;
  /** Seconds until the market expires. Negative once it has. */
  secondsUntilExpiry?: number;
  reason: UnmappableReason;
  detail: string;
  remedy: string;
  /** True once the market has already expired unresolved. */
  pastExpiry: boolean;
}

/** The minimum shape a sweep needs; narrower than `Market` on purpose. */
export interface SweepableMarket {
  id: string;
  category: string;
  /**
   * Category-specific adapter params. Optional because the database does not
   * store them — see {@link UNKNOWN_PARAMS_NOTE}. A market without them is
   * reported as `unknown-params` rather than assumed mappable.
   */
  params?: Record<string, unknown>;
  question?: string;
  /** Epoch seconds, or an ISO string. */
  endTime?: string | number;
}

export interface SweepOptions extends ValidateMappabilityOptions {
  /** Evaluation instant. Injectable so the sweep is deterministic in tests. */
  now?: number;
  /** Only consider markets ending within this many seconds. Defaults to 30 days. */
  withinSeconds?: number;
  /** Include markets that have already expired. Defaults to true. */
  includeExpired?: boolean;
}

const DEFAULT_SWEEP_WINDOW_SECONDS = 30 * 24 * 60 * 60;

function toEpochSeconds(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? Math.floor(value) : undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
}

/**
 * Finds open markets that no adapter can resolve, most urgent first.
 *
 * This is the catch-up for markets created before creation-time validation
 * existed, and the ongoing sweep that catches a symbol a provider delists
 * after creation. Ordering by time remaining is the point: a market expiring
 * in an hour and one expiring in a month are not the same problem.
 */
export function collectUnmappableMarkets(
  markets: readonly SweepableMarket[],
  options: SweepOptions = {},
): UnmappableOpenMarket[] {
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  const within = options.withinSeconds ?? DEFAULT_SWEEP_WINDOW_SECONDS;
  const includeExpired = options.includeExpired ?? true;

  const found: UnmappableOpenMarket[] = [];

  for (const market of markets) {
    const endTime = toEpochSeconds(market.endTime);
    if (endTime !== undefined) {
      const secondsUntilExpiry = endTime - nowSeconds;
      if (secondsUntilExpiry < -within) continue;
      if (!includeExpired && secondsUntilExpiry < 0) continue;
      if (secondsUntilExpiry > within) continue;
    }

    const verdict = validateMarketMappability(
      {
        id: market.id,
        // The sweep reads from Postgres, so the category arrives in the
        // title-case storage form; the adapters use lower case. Normalization
        // happens inside the validator, so passing it through unchanged is
        // correct and keeps one definition of "supported category".
        category: market.category as Market["category"],
        ...(market.params === undefined ? {} : { params: market.params }),
        ...(market.question === undefined ? {} : { question: market.question }),
      } as Market,
      options,
    );

    if (verdict.mappable) continue;

    const secondsUntilExpiry = endTime === undefined ? undefined : endTime - nowSeconds;

    found.push({
      id: market.id,
      ...(market.question === undefined ? {} : { question: market.question }),
      category: market.category,
      ...(endTime === undefined
        ? {}
        : { endTimeSeconds: endTime, ...(secondsUntilExpiry === undefined ? {} : { secondsUntilExpiry }) }),
      reason: verdict.reason ?? "unsupported-category",
      detail: verdict.detail ?? "not mappable",
      remedy: verdict.remedy ?? "no remedy recorded",
      pastExpiry: secondsUntilExpiry !== undefined && secondsUntilExpiry <= 0,
    });
  }

  return found.sort(
    (a, b) => (a.secondsUntilExpiry ?? Number.MAX_SAFE_INTEGER) - (b.secondsUntilExpiry ?? Number.MAX_SAFE_INTEGER),
  );
}
