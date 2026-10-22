import { describe, it, expect, vi } from 'vitest';
import {
  getBetsByBettor,
  getBetsByMarketFromDb,
  getBetAnomalyReviewMetrics,
  getUnreviewedBetAnomalies,
  reviewBetAnomaly,
  type BetRow,
} from './bets';
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

  describe("bet anomaly review helpers", () => {
    it("returns queued alerts without changing market state", async () => {
      const alert = {
        market_id: "42",
        window_start: new Date("2026-10-21T22:00:00Z"),
        bettor_count: 3,
        recent_net_amount: "1500000000",
        same_side_share: "0.95",
        reviewed_at: null,
        review_outcome: null,
        review_note: null,
      };
      const db = { query: vi.fn().mockResolvedValue({ rows: [alert] }) };
      await expect(getUnreviewedBetAnomalies(db)).resolves.toEqual([alert]);
      expect(db.query.mock.calls[0]?.[0]).toContain("WHERE reviewed_at IS NULL");
    });

    it("records a review and computes the conclusive false-positive rate", async () => {
      const db = {
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [{ market_id: "42" }] })
          .mockResolvedValueOnce({
            rows: [{ flagged: 5, reviewed: 4, false_positives: 1 }],
          }),
      };
      await expect(
        reviewBetAnomaly(
          db,
          "42",
          new Date("2026-10-21T22:00:00Z"),
          "false_positive",
          "Normal seasonal activity",
        ),
      ).resolves.toBeUndefined();
      await expect(getBetAnomalyReviewMetrics(db)).resolves.toEqual({
        flagged: 5,
        reviewed: 4,
        falsePositives: 1,
        falsePositiveRate: 0.25,
      });
    });

    it("reports no measured false-positive rate before conclusive reviews", async () => {
      const db = {
        query: vi.fn().mockResolvedValue({
          rows: [{ flagged: 0, reviewed: 0, false_positives: 0 }],
        }),
      };
      await expect(getBetAnomalyReviewMetrics(db)).resolves.toMatchObject({
        reviewed: 0,
        falsePositiveRate: null,
      });
    });

    it("surfaces a missing or previously reviewed alert", async () => {
      const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
      await expect(
        reviewBetAnomaly(db, "42", new Date(), "confirmed"),
      ).rejects.toThrow("not found or has already been reviewed");
    });
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

  it('orders tied bet timestamps by the primary key to prevent duplicate or skipped pages', async () => {
    const mockRows: BetRow[] = [
      {
        market_id: '42',
        bettor: 'GBOB',
        net_amount: '10.0000000',
        gross_amount: '10.0000000',
        is_yes: true,
        claimed: false,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        market_id: '42',
        bettor: 'GALICE',
        net_amount: '20.0000000',
        gross_amount: '20.0000000',
        is_yes: false,
        claimed: false,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
      },
    ];

    const mockDb = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: mockRows })
        .mockResolvedValueOnce({ rows: [{ total: 2 }] }),
    };

    const result = await getBetsByMarketFromDb(42, 1, 10, mockDb as any);

    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY created_at DESC, bettor DESC'),
      [42, 10, 0],
    );
    expect(result.bets).toEqual(mockRows);
  });
});
<<<<<<< HEAD

describe("getBetsByBettorPaginated", () => {
  it("fetches a stable page and the total count using parameterized queries", async () => {
    const rows: BetRow[] = [
      {
        market_id: "7",
        bettor: "GBETTOR",
        net_amount: "100",
        gross_amount: "102",
        is_yes: true,
        claimed: false,
        created_at: new Date(),
      },
    ];
    const query = vi.fn()
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: [{ total: 21 }] });
    const mockPool = { query } as unknown as Pool;

    const result = await getBetsByBettorPaginated(mockPool, "GBETTOR", 2, 10);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("ORDER BY created_at DESC, market_id DESC"),
      ["GBETTOR", 10, 10],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("COUNT(*)::INT AS total"),
      ["GBETTOR"],
    );
    expect(result).toEqual({
      bets: rows,
      total: 21,
      page: 2,
      limit: 10,
      totalPages: 3,
    });
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
=======
>>>>>>> 4241d68 (Detect concentrated late betting patterns)
