import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockSimulateTransaction = vi.fn();
const mockBuildAndSendTx = vi.fn();

vi.mock("@/services/soroban", () => ({
  simulateTransaction: (...args: unknown[]) => mockSimulateTransaction(...args),
  buildAndSendTx: (...args: unknown[]) => mockBuildAndSendTx(...args),
}));

vi.mock("@/services/cache", () => ({
  get: () => null,
  set: vi.fn(),
  invalidate: vi.fn(),
  invalidateAll: vi.fn(),
}));

vi.mock("@/services/referral", () => ({
  getDisplayName: vi.fn().mockResolvedValue(""),
}));

vi.mock("@stellar/stellar-sdk", () => ({
  Address: class {
    _addr: string;
    constructor(addr: string) {
      this._addr = addr;
    }
    toScVal() {
      return { type: "address", value: this._addr };
    }
  },
  nativeToScVal: (val: unknown, opts: { type: string }) => ({
    type: opts.type,
    value: val,
  }),
  xdr: {},
}));

vi.mock("@/config/network", () => ({
  MARKET_CONTRACT_ID: "CMARKET123",
  ADMIN_PUBLIC_KEY: "GADMIN456",
  TOTAL_FEE_BPS: 200,
  PLATFORM_FEE_BPS: 150,
  REFERRAL_FEE_BPS: 50,
}));

import {
  getMarket,
  getMarkets,
  getBet,
  getOdds,
  placeBet,
  resolveMarket,
  claim,
} from "@/services/market";

// ── Tests ──────────────────────────────────────────────────────────────────

describe("market service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getMarket", () => {
    it("returns parsed Market object on success", async () => {
      mockSimulateTransaction.mockResolvedValueOnce({
        id: 1n,
        question: "Will ETH flip BTC?",
        image_url: "/eth.png",
        end_time: 1700000000n,
        total_yes: 1000n,
        total_no: 500n,
        resolved: false,
        outcome: false,
        cancelled: false,
        creator: "GCREATOR",
        bet_count: 5n,
      });

      const market = await getMarket(1);
      expect(market).not.toBeNull();
      expect(market!.id).toBe(1);
      expect(market!.question).toBe("Will ETH flip BTC?");
      expect(market!.totalYes).toBe(1000);
      expect(market!.totalNo).toBe(500);
      expect(market!.betCount).toBe(5);
    });

    it("returns null on error", async () => {
      mockSimulateTransaction.mockRejectedValueOnce(new Error("not found"));
      const market = await getMarket(999);
      expect(market).toBeNull();
    });
  });

  describe("getMarkets", () => {
    it("returns array of markets", async () => {
      // First call: get_market_count => 2
      mockSimulateTransaction.mockResolvedValueOnce(2n);
      // Then two get_market calls
      mockSimulateTransaction
        .mockResolvedValueOnce({
          id: 1n,
          question: "Q1",
          image_url: "",
          end_time: 100n,
          total_yes: 10n,
          total_no: 5n,
          resolved: false,
          outcome: false,
          cancelled: false,
          creator: "G1",
          bet_count: 2n,
        })
        .mockResolvedValueOnce({
          id: 2n,
          question: "Q2",
          image_url: "",
          end_time: 200n,
          total_yes: 20n,
          total_no: 15n,
          resolved: false,
          outcome: false,
          cancelled: false,
          creator: "G2",
          bet_count: 4n,
        });

      const markets = await getMarkets();
      expect(markets).toHaveLength(2);
      expect(markets[0].question).toBe("Q1");
      expect(markets[1].question).toBe("Q2");
    });

    it("returns empty array when count is 0", async () => {
      mockSimulateTransaction.mockResolvedValueOnce(0);
      const markets = await getMarkets();
      expect(markets).toEqual([]);
    });
  });

  describe("getBet", () => {
    it("returns parsed Bet on success", async () => {
      mockSimulateTransaction.mockResolvedValueOnce({
        amount: 100n,
        is_yes: true,
        claimed: false,
      });

      const bet = await getBet(1, "GUSER");
      expect(bet).not.toBeNull();
      expect(bet!.amount).toBe(100);
      expect(bet!.isYes).toBe(true);
      expect(bet!.claimed).toBe(false);
    });

    it("returns null on error", async () => {
      mockSimulateTransaction.mockRejectedValueOnce(new Error("no bet"));
      const bet = await getBet(1, "GUSER");
      expect(bet).toBeNull();
    });
  });

  describe("getOdds", () => {
    it("returns odds from contract", async () => {
      mockSimulateTransaction.mockResolvedValueOnce([60n, 40n]);
      const odds = await getOdds(1);
      expect(odds.yesPercent).toBe(60);
      expect(odds.noPercent).toBe(40);
    });

    it("returns 50/50 on error", async () => {
      mockSimulateTransaction.mockRejectedValueOnce(new Error("fail"));
      const odds = await getOdds(1);
      expect(odds).toEqual({ yesPercent: 50, noPercent: 50 });
    });
  });

  describe("placeBet", () => {
    it("calls buildAndSendTx with correct params", async () => {
      const mockSign = vi.fn();
      mockBuildAndSendTx.mockResolvedValueOnce({
        success: true,
        hash: "abc123",
      });

      const result = await placeBet("GUSER", 1, true, 100, mockSign);
      expect(result.success).toBe(true);
      expect(result.hash).toBe("abc123");
      expect(mockBuildAndSendTx).toHaveBeenCalledTimes(1);
      expect(mockBuildAndSendTx.mock.calls[0][2]).toBe("place_bet");
    });

    it("returns error result on failure", async () => {
      const mockSign = vi.fn();
      mockBuildAndSendTx.mockResolvedValueOnce({
        success: false,
        error: "Tx failed",
      });

      const result = await placeBet("GUSER", 1, true, 100, mockSign);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Tx failed");
    });
  });

  describe("resolveMarket", () => {
    it("sends correct outcome", async () => {
      const mockSign = vi.fn();
      mockBuildAndSendTx.mockResolvedValueOnce({ success: true, hash: "h1" });

      const result = await resolveMarket("GADMIN", 1, true, mockSign);
      expect(result.success).toBe(true);
      expect(mockBuildAndSendTx.mock.calls[0][2]).toBe("resolve_market");
    });
  });

  describe("claim", () => {
    it("returns transaction result", async () => {
      const mockSign = vi.fn();
      mockBuildAndSendTx.mockResolvedValueOnce({
        success: true,
        hash: "claim_hash",
      });

      const result = await claim("GUSER", 1, mockSign);
      expect(result.success).toBe(true);
      expect(mockBuildAndSendTx.mock.calls[0][2]).toBe("claim");
    });
  });
});
