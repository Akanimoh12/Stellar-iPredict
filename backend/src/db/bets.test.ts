import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getBetsByBettor, BetRow } from './bets';
import { Pool } from 'pg';

describe('getBetsByBettor', () => {
  it('should return bets for a given bettor using a parameterized query', async () => {
    // Mock data based on the BetRow interface
    const mockDate = new Date();
    const mockRows: BetRow[] = [
      {
        market_id: '1',
        bettor: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        net_amount: '100.0000000',
        gross_amount: '102.0000000',
        is_yes: true,
        claimed: false,
        created_at: mockDate,
      },
      {
        market_id: '2',
        bettor: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        net_amount: '50.0000000',
        gross_amount: '51.0000000',
        is_yes: false,
        claimed: true,
        created_at: mockDate,
      }
    ];

    // Create a mock pool with a vi.fn() spy
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: mockRows })
    } as unknown as Pool;

    const bettorAddress = 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const result = await getBetsByBettor(mockPool, bettorAddress);

    // Verify the query execution
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    
    // Verify the parameterization (no string interpolation)
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE bettor = $1'),
      [bettorAddress]
    );

    // Verify the returned shapes exactly match
    expect(result).toEqual(mockRows);
  });

  it('preserves exact string amounts larger than Number.MAX_SAFE_INTEGER without precision loss', async () => {
    const hugeAmountStr = '10000000000000000000.1234567';
    const mockRow: BetRow = {
      market_id: '99',
      bettor: 'GBETTOR_LARGE_INTEGER_ADDRESS',
      net_amount: hugeAmountStr,
      gross_amount: hugeAmountStr,
      is_yes: true,
      claimed: false,
      created_at: new Date(),
    };

    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [mockRow] })
    } as unknown as Pool;

    const result = await getBetsByBettor(mockPool, 'GBETTOR_LARGE_INTEGER_ADDRESS');
    expect(result[0].net_amount).toBe(hugeAmountStr);
    expect(result[0].gross_amount).toBe(hugeAmountStr);
    expect(typeof result[0].net_amount).toBe('string');
  });
});

import { getBetsByMarket, seedBets, clearBets, type Bet } from './bets.js';

function makeBets(count: number, offset = 0): Bet[] {
  return Array.from({ length: count }, (_, i) => ({
    address: `GADDR${offset + i + 1}`,
    amount: (offset + i + 1) * 100,
    isYes: (offset + i) % 2 === 0,
    claimed: false,
  }));
}

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

