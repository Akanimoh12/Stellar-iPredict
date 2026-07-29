import { describe, expect, it, vi } from "vitest";
import { resolveMarketOnChain, type ResolveMarketDependencies } from "../src/submitter/resolveMarket.js";
import { OffChainSubmitterService, type DataAdapter, type OffChainSubmitterStore } from "../src/submitter/offChainSubmitter.js";
import { checkBondMinimum, type OracleSubmissionRecord } from "../src/aggregator/bond-monitor.js";
import { checkCouncilInactivity, type EscalatedMarketRecord } from "../src/aggregator/council-inactivity-monitor.js";

describe("Aggregator & Submitter Features (#122, #155, #153, #154)", () => {
  describe("Aggregator Dry-Run Mode (#122)", () => {
    it("runs flow in dry-run mode without submitting on-chain", async () => {
      const recorded: any[] = [];
      const deps: ResolveMarketDependencies = {
        submitter: {
          submitResolution: vi.fn(),
        },
        isAlreadyResolved: async () => false,
        recordResult: async (res) => { recorded.push(res); },
        dryRun: true,
      };

      const result = await resolveMarketOnChain(deps, "market-101", true);

      expect(result).not.toBeNull();
      expect(result?.dryRun).toBe(true);
      expect(result?.txHash).toContain("dry-run-market-101");
      expect(deps.submitter.submitResolution).not.toHaveBeenCalled();
      expect(recorded).toHaveLength(1);
    });

    it("prevents double resolution even in dry-run mode", async () => {
      const deps: ResolveMarketDependencies = {
        submitter: { submitResolution: vi.fn() },
        isAlreadyResolved: async () => true,
        recordResult: async () => {},
        dryRun: true,
      };

      const result = await resolveMarketOnChain(deps, "market-101", true);
      expect(result).toBeNull();
    });
  });

  describe("Off-Chain Submitter Service (#155)", () => {
    it("posts outcome from data adapters and prevents double-submit", async () => {
      const mockAdapter: DataAdapter = {
        name: "CoinGecko",
        fetchOutcome: async () => ({ outcome: true, confidence: 0.95 }),
      };

      const submittedRecords = new Set<string>();
      const store: OffChainSubmitterStore = {
        isAlreadySubmitted: async (id) => submittedRecords.has(id),
        recordSubmission: async (res) => { submittedRecords.add(res.marketId); },
      };

      const service = new OffChainSubmitterService(
        {
          server: {} as any,
          contractId: "C123",
          networkPassphrase: "Test",
          submitterKeypair: {} as any,
          adapters: [mockAdapter],
          dryRun: true,
        },
        store,
      );

      const res1 = await service.processMarket("m1");
      expect(res1?.outcome).toBe(true);
      expect(res1?.adapterName).toBe("CoinGecko");

      // Double submit attempt should return null
      const res2 = await service.processMarket("m1");
      expect(res2).toBeNull();
    });
  });

  describe("Bond-Below-Minimum Monitor (#153)", () => {
    it("alerts if a submission bond is below the required minimum", async () => {
      const submissions: OracleSubmissionRecord[] = [
        { marketId: "m1", submitter: "ADDR1", bond: 50_0000000n, status: "submitted" },
        { marketId: "m2", submitter: "ADDR2", bond: 100_0000000n, status: "submitted" },
      ];

      const alerts = await checkBondMinimum(submissions, { requiredMinimumBond: 100_0000000n });
      expect(alerts).toHaveLength(1);
      expect(alerts[0].marketId).toBe("m1");
      expect(alerts[0].currentBond).toBe(50_0000000n);
    });
  });

  describe("Council Inactivity Monitor (#154)", () => {
    it("alerts when council has not voted for >= 48 hours", async () => {
      const now = new Date("2026-07-29T18:00:00Z");
      const hoursAgo50 = new Date(now.getTime() - 50 * 60 * 60 * 1000);
      const hoursAgo10 = new Date(now.getTime() - 10 * 60 * 60 * 1000);

      const records: EscalatedMarketRecord[] = [
        { marketId: "m-stuck", escalatedAt: hoursAgo50, status: "escalated", hasCouncilVotes: false },
        { marketId: "m-active", escalatedAt: hoursAgo10, status: "escalated", hasCouncilVotes: true },
      ];

      const alerts = await checkCouncilInactivity(records, now, { inactivityThresholdHours: 48 });
      expect(alerts).toHaveLength(1);
      expect(alerts[0].marketId).toBe("m-stuck");
      expect(alerts[0].inactiveDurationHours).toBeGreaterThanOrEqual(48);
    });
  });
});
