import type { Market, MarketCategory } from "@ipredict/shared";
import { TEST_ADDRESSES } from "./addresses.js";

export interface MarketFixtureOptions {
  id?: number;
  question?: string;
  image_url?: string | null;
  category?: MarketCategory;
  end_time?: string;
  total_yes?: string;
  total_no?: string;
  resolved?: boolean;
  outcome?: boolean | null;
  cancelled?: boolean;
  creator?: string;
  bet_count?: number;
  created_at?: Date;
  updated_at?: Date;
}

/**
 * Creates a market fixture with sensible defaults for testing.
 * Used by backend API tests, cache tests, and integration tests.
 */
export function makeMarket(options: MarketFixtureOptions = {}): Market {
  const now = new Date();
  const futureEndTime = Math.floor(Date.now() / 1000) + 86400 * 30; // 30 days from now
  
  return {
    id: options.id ?? 1,
    question: options.question ?? "Will Stellar XLM reach $1 in 2026?",
    image_url: options.image_url !== undefined ? options.image_url : "https://example.com/image.png",
    category: options.category ?? "Crypto",
    end_time: options.end_time ?? futureEndTime.toString(),
    total_yes: options.total_yes ?? "100.0000000",
    total_no: options.total_no ?? "50.0000000",
    resolved: options.resolved ?? false,
    outcome: options.outcome ?? null,
    cancelled: options.cancelled ?? false,
    creator: options.creator ?? TEST_ADDRESSES.CREATOR,
    bet_count: options.bet_count ?? 5,
    created_at: options.created_at ?? now,
    updated_at: options.updated_at ?? now,
  };
}

/**
 * Builder pattern for more complex market construction.
 * 
 * @example
 * const market = marketBuilder()
 *   .withId(42)
 *   .resolved(true)
 *   .withCategory("Sports")
 *   .build();
 */
export class MarketBuilder {
  private options: MarketFixtureOptions = {};

  withId(id: number): this {
    this.options.id = id;
    return this;
  }

  withQuestion(question: string): this {
    this.options.question = question;
    return this;
  }

  withCategory(category: MarketCategory): this {
    this.options.category = category;
    return this;
  }

  withImageUrl(url: string | null): this {
    this.options.image_url = url;
    return this;
  }

  withEndTime(timestamp: string): this {
    this.options.end_time = timestamp;
    return this;
  }

  ended(): this {
    const pastTime = Math.floor(Date.now() / 1000) - 86400; // 1 day ago
    this.options.end_time = pastTime.toString();
    return this;
  }

  active(): this {
    const futureTime = Math.floor(Date.now() / 1000) + 86400 * 30; // 30 days from now
    this.options.end_time = futureTime.toString();
    this.options.resolved = false;
    this.options.cancelled = false;
    return this;
  }

  resolved(outcome: boolean): this {
    this.options.resolved = true;
    this.options.outcome = outcome;
    return this;
  }

  cancelled(): this {
    this.options.cancelled = true;
    this.options.resolved = false;
    return this;
  }

  withVolume(totalYes: string, totalNo: string): this {
    this.options.total_yes = totalYes;
    this.options.total_no = totalNo;
    return this;
  }

  withBetCount(count: number): this {
    this.options.bet_count = count;
    return this;
  }

  createdBy(creator: string): this {
    this.options.creator = creator;
    return this;
  }

  build(): Market {
    return makeMarket(this.options);
  }
}

export function marketBuilder(): MarketBuilder {
  return new MarketBuilder();
}

/** Common market presets for frequent test scenarios */
export const MARKET_PRESETS = {
  /** Active crypto market with moderate volume */
  activeCrypto: (): Market =>
    marketBuilder()
      .withId(1)
      .withCategory("Crypto")
      .withQuestion("Will Bitcoin reach $100k in 2026?")
      .active()
      .withVolume("1000.0000000", "500.0000000")
      .build(),

  /** Resolved sports market (yes outcome) */
  resolvedSports: (): Market =>
    marketBuilder()
      .withId(2)
      .withCategory("Sports")
      .withQuestion("Will Team A win the championship?")
      .resolved(true)
      .withVolume("2000.0000000", "1000.0000000")
      .build(),

  /** Cancelled politics market */
  cancelledPolitics: (): Market =>
    marketBuilder()
      .withId(3)
      .withCategory("Politics")
      .withQuestion("Will the bill pass?")
      .cancelled()
      .build(),

  /** Ended but not yet resolved market */
  endedPending: (): Market =>
    marketBuilder()
      .withId(4)
      .withCategory("Science")
      .withQuestion("Will the experiment succeed?")
      .ended()
      .withVolume("500.0000000", "500.0000000")
      .build(),
} as const;
