import { describe, it, expect, beforeEach } from "vitest";
import { getBetsByMarket, seedBets, clearBets } from "@/db/bets";
import type { Bet } from "@/db/bets";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBets(count: number, offset = 0): Bet[] {
  return Array.from({ length: count }, (_, i) => ({
    address: `GADDR${offset + i + 1}`,
    amount: (offset + i + 1) * 100,
    isYes: (offset + i) % 2 === 0,
    claimed: false,
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getBetsByMarket", () => {
  beforeEach(() => {
    clearBets();
  });

  it("returns first page of bets", () => {
    seedBets(1, makeBets(5));

    const result = getBetsByMarket(1, 0, 2);

    expect(result.bets).toHaveLength(2);
    expect(result.bets[0].address).toBe("GADDR1");
    expect(result.bets[1].address).toBe("GADDR2");
    expect(result.total).toBe(5);
    expect(result.page).toBe(0);
    expect(result.limit).toBe(2);
    expect(result.totalPages).toBe(3);
  });

  it("returns second page", () => {
    seedBets(1, makeBets(5));

    const result = getBetsByMarket(1, 1, 2);

    expect(result.bets).toHaveLength(2);
    expect(result.bets[0].address).toBe("GADDR3");
    expect(result.bets[1].address).toBe("GADDR4");
  });

  it("returns partial last page", () => {
    seedBets(1, makeBets(5));

    const result = getBetsByMarket(1, 2, 2);

    expect(result.bets).toHaveLength(1);
    expect(result.bets[0].address).toBe("GADDR5");
  });

  it("returns empty result for unseeded market", () => {
    const result = getBetsByMarket(999, 0, 10);

    expect(result.bets).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(0);
  });

  it("returns all bets when limit exceeds total", () => {
    seedBets(1, makeBets(3));

    const result = getBetsByMarket(1, 0, 100);

    expect(result.bets).toHaveLength(3);
    expect(result.totalPages).toBe(1);
  });

  it("returns empty bets for out-of-range page", () => {
    seedBets(1, makeBets(3));

    const result = getBetsByMarket(1, 10, 2);

    expect(result.bets).toEqual([]);
    expect(result.total).toBe(3);
    expect(result.totalPages).toBe(2);
  });

  it("returns empty result for negative marketId", () => {
    const result = getBetsByMarket(-1, 0, 10);

    expect(result.bets).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("returns empty result for negative page", () => {
    seedBets(1, makeBets(3));

    const result = getBetsByMarket(1, -1, 10);

    expect(result.bets).toEqual([]);
  });

  it("returns empty result for zero limit", () => {
    seedBets(1, makeBets(3));

    const result = getBetsByMarket(1, 0, 0);

    expect(result.bets).toEqual([]);
  });

  it("isolates markets from each other", () => {
    seedBets(1, makeBets(2));
    seedBets(2, makeBets(3, 2));

    const r1 = getBetsByMarket(1, 0, 10);
    const r2 = getBetsByMarket(2, 0, 10);

    expect(r1.total).toBe(2);
    expect(r2.total).toBe(3);
    expect(r1.bets[0].address).toBe("GADDR1");
    expect(r2.bets[0].address).toBe("GADDR3");
  });
});
