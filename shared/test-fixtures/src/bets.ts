import type { Bet } from "@ipredict/shared";
import { TEST_ADDRESSES } from "./addresses.js";

export interface BetFixtureOptions {
  market_id?: string;
  bettor?: string;
  net_amount?: string;
  gross_amount?: string;
  is_yes?: boolean;
  claimed?: boolean;
  created_at?: Date;
}

/**
 * Creates a bet fixture with sensible defaults for testing.
 */
export function makeBet(options: BetFixtureOptions = {}): Bet {
  const grossAmount = options.gross_amount ?? "100000000"; // 100 XLM in stroops
  const feePercent = 0.03; // 3% fee
  const netAmount = options.net_amount ?? String(Math.floor(Number(grossAmount) * (1 - feePercent)));
  
  return {
    market_id: options.market_id ?? "1",
    bettor: options.bettor ?? TEST_ADDRESSES.BETTOR,
    net_amount: netAmount,
    gross_amount: grossAmount,
    is_yes: options.is_yes ?? true,
    claimed: options.claimed ?? false,
    created_at: options.created_at ?? new Date(),
  };
}

/**
 * Builder pattern for bet construction.
 */
export class BetBuilder {
  private options: BetFixtureOptions = {};

  onMarket(marketId: string | number): this {
    this.options.market_id = String(marketId);
    return this;
  }

  by(bettor: string): this {
    this.options.bettor = bettor;
    return this;
  }

  forYes(): this {
    this.options.is_yes = true;
    return this;
  }

  forNo(): this {
    this.options.is_yes = false;
    return this;
  }

  withAmount(grossAmount: string, netAmount?: string): this {
    this.options.gross_amount = grossAmount;
    if (netAmount) {
      this.options.net_amount = netAmount;
    }
    return this;
  }

  claimed(): this {
    this.options.claimed = true;
    return this;
  }

  unclaimed(): this {
    this.options.claimed = false;
    return this;
  }

  createdAt(date: Date): this {
    this.options.created_at = date;
    return this;
  }

  build(): Bet {
    return makeBet(this.options);
  }
}

export function betBuilder(): BetBuilder {
  return new BetBuilder();
}

/** Common bet presets */
export const BET_PRESETS = {
  /** Standard 100 XLM bet on yes */
  standardYes: (marketId: number = 1): Bet =>
    betBuilder()
      .onMarket(marketId)
      .forYes()
      .withAmount("100000000", "97000000")
      .build(),

  /** Standard 100 XLM bet on no */
  standardNo: (marketId: number = 1): Bet =>
    betBuilder()
      .onMarket(marketId)
      .forNo()
      .withAmount("100000000", "97000000")
      .build(),

  /** Large whale bet (10,000 XLM) */
  whaleBet: (marketId: number = 1): Bet =>
    betBuilder()
      .onMarket(marketId)
      .forYes()
      .withAmount("10000000000", "9700000000")
      .build(),

  /** Claimed winning bet */
  claimedWin: (marketId: number = 1): Bet =>
    betBuilder()
      .onMarket(marketId)
      .forYes()
      .withAmount("100000000", "97000000")
      .claimed()
      .build(),
} as const;
