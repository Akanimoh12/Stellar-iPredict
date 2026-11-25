import { describe, expect, it } from "vitest";
import {
  makeMarket,
  marketBuilder,
  MARKET_PRESETS,
  makeBet,
  betBuilder,
  BET_PRESETS,
  makeMarketCreatedEvent,
  makeBetPlacedEvent,
  TEST_ADDRESSES,
  generateAddress,
} from "./index.js";

describe("Market Fixtures", () => {
  it("creates a basic market with defaults", () => {
    const market = makeMarket();
    expect(market.id).toBe(1);
    expect(market.question).toBe("Will Stellar XLM reach $1 in 2026?");
    expect(market.category).toBe("Crypto");
    expect(market.resolved).toBe(false);
    expect(market.cancelled).toBe(false);
  });

  it("overrides defaults with provided options", () => {
    const market = makeMarket({
      id: 42,
      category: "Sports",
      question: "Will Team A win?",
      resolved: true,
      outcome: true,
    });
    expect(market.id).toBe(42);
    expect(market.category).toBe("Sports");
    expect(market.question).toBe("Will Team A win?");
    expect(market.resolved).toBe(true);
    expect(market.outcome).toBe(true);
  });

  it("builds markets with fluent builder pattern", () => {
    const market = marketBuilder()
      .withId(99)
      .withCategory("Politics")
      .withQuestion("Will the bill pass?")
      .resolved(false)
      .withVolume("1000.0000000", "2000.0000000")
      .build();

    expect(market.id).toBe(99);
    expect(market.category).toBe("Politics");
    expect(market.total_yes).toBe("1000.0000000");
    expect(market.total_no).toBe("2000.0000000");
    expect(market.resolved).toBe(false);
  });

  it("creates active market using builder", () => {
    const market = marketBuilder().active().build();
    const endTime = Number(market.end_time);
    const now = Math.floor(Date.now() / 1000);
    expect(endTime).toBeGreaterThan(now);
    expect(market.resolved).toBe(false);
    expect(market.cancelled).toBe(false);
  });

  it("creates ended market using builder", () => {
    const market = marketBuilder().ended().build();
    const endTime = Number(market.end_time);
    const now = Math.floor(Date.now() / 1000);
    expect(endTime).toBeLessThan(now);
  });

  it("creates cancelled market using builder", () => {
    const market = marketBuilder().cancelled().build();
    expect(market.cancelled).toBe(true);
    expect(market.resolved).toBe(false);
  });

  it("provides preset markets", () => {
    const crypto = MARKET_PRESETS.activeCrypto();
    expect(crypto.category).toBe("Crypto");
    expect(crypto.resolved).toBe(false);

    const sports = MARKET_PRESETS.resolvedSports();
    expect(sports.category).toBe("Sports");
    expect(sports.resolved).toBe(true);
    expect(sports.outcome).toBe(true);

    const politics = MARKET_PRESETS.cancelledPolitics();
    expect(politics.cancelled).toBe(true);

    const ended = MARKET_PRESETS.endedPending();
    expect(Number(ended.end_time)).toBeLessThan(Date.now() / 1000);
  });
});

describe("Bet Fixtures", () => {
  it("creates a basic bet with defaults", () => {
    const bet = makeBet();
    expect(bet.market_id).toBe("1");
    expect(bet.bettor).toBe(TEST_ADDRESSES.BETTOR);
    expect(bet.is_yes).toBe(true);
    expect(bet.claimed).toBe(false);
  });

  it("calculates net amount from gross with fee", () => {
    const bet = makeBet({ gross_amount: "100000000" });
    // 3% fee: net = 97000000
    expect(bet.gross_amount).toBe("100000000");
    expect(bet.net_amount).toBe("97000000");
  });

  it("overrides defaults with provided options", () => {
    const bet = makeBet({
      market_id: "42",
      bettor: TEST_ADDRESSES.BETTOR_2,
      is_yes: false,
      claimed: true,
    });
    expect(bet.market_id).toBe("42");
    expect(bet.bettor).toBe(TEST_ADDRESSES.BETTOR_2);
    expect(bet.is_yes).toBe(false);
    expect(bet.claimed).toBe(true);
  });

  it("builds bets with fluent builder pattern", () => {
    const bet = betBuilder()
      .onMarket(42)
      .by(TEST_ADDRESSES.BETTOR)
      .forNo()
      .withAmount("500000000", "485000000")
      .claimed()
      .build();

    expect(bet.market_id).toBe("42");
    expect(bet.bettor).toBe(TEST_ADDRESSES.BETTOR);
    expect(bet.is_yes).toBe(false);
    expect(bet.gross_amount).toBe("500000000");
    expect(bet.net_amount).toBe("485000000");
    expect(bet.claimed).toBe(true);
  });

  it("provides preset bets", () => {
    const yesbet = BET_PRESETS.standardYes(7);
    expect(yesbet.market_id).toBe("7");
    expect(yesbet.is_yes).toBe(true);
    expect(yesbet.gross_amount).toBe("100000000");

    const nobet = BET_PRESETS.standardNo(7);
    expect(nobet.is_yes).toBe(false);

    const whale = BET_PRESETS.whaleBet(7);
    expect(whale.gross_amount).toBe("10000000000");

    const claimed = BET_PRESETS.claimedWin(7);
    expect(claimed.claimed).toBe(true);
  });
});

describe("Event Fixtures", () => {
  it("creates market_created event", () => {
    const event = makeMarketCreatedEvent({ market_id: 7n, category: "Sports" });
    expect(event.name).toBe("market_created");
    expect(event.topics).toEqual(["mkt", "created"]);
    expect(event.data.market_id).toBe(7n);
    expect(event.data.category).toBe("Sports");
    expect(event.data.creator).toBe(TEST_ADDRESSES.CREATOR);
  });

  it("creates bet_placed event", () => {
    const event = makeBetPlacedEvent({
      market_id: 42n,
      user: TEST_ADDRESSES.BETTOR,
      is_yes: false,
      amount: 200000000n,
    });
    expect(event.name).toBe("bet_placed");
    expect(event.topics).toEqual(["bet", "placed"]);
    expect(event.data.market_id).toBe(42n);
    expect(event.data.user).toBe(TEST_ADDRESSES.BETTOR);
    expect(event.data.is_yes).toBe(false);
    expect(event.data.amount).toBe(200000000n);
  });

  it("event data uses bigint for numeric fields", () => {
    const event = makeMarketCreatedEvent();
    expect(typeof event.data.market_id).toBe("bigint");
    expect(typeof event.data.end_time).toBe("bigint");
  });
});

describe("Test Addresses", () => {
  it("provides well-known addresses", () => {
    expect(TEST_ADDRESSES.CREATOR).toMatch(/^G[A-Z2-7]{55}$/);
    expect(TEST_ADDRESSES.BETTOR).toMatch(/^G[A-Z2-7]{55}$/);
    expect(TEST_ADDRESSES.ORACLE_SUBMITTER).toMatch(/^G[A-Z2-7]{55}$/);
  });

  it("generates valid Stellar addresses from seed", () => {
    const addr1 = generateAddress("alice");
    const addr2 = generateAddress("bob");
    expect(addr1).toMatch(/^G[A-Z2-7]{55}$/);
    expect(addr2).toMatch(/^G[A-Z2-7]{55}$/);
    expect(addr1).not.toBe(addr2);
    expect(addr1.length).toBe(56);
  });

  it("generates deterministic addresses", () => {
    const addr1 = generateAddress("test");
    const addr2 = generateAddress("test");
    expect(addr1).toBe(addr2);
  });
});

describe("Cross-Package Integration", () => {
  it("market and bet fixtures work together", () => {
    const market = marketBuilder().withId(7).active().build();
    const bet1 = betBuilder().onMarket(market.id).forYes().build();
    const bet2 = betBuilder().onMarket(market.id).forNo().build();

    expect(bet1.market_id).toBe(String(market.id));
    expect(bet2.market_id).toBe(String(market.id));
    expect(bet1.is_yes).toBe(true);
    expect(bet2.is_yes).toBe(false);
  });

  it("event fixtures align with market/bet data", () => {
    const market = makeMarket({ id: 42 });
    const event = makeMarketCreatedEvent({
      market_id: BigInt(market.id),
      category: market.category,
      question: market.question,
    });

    expect(Number(event.data.market_id)).toBe(market.id);
    expect(event.data.category).toBe(market.category);
    expect(event.data.question).toBe(market.question);
  });
});
