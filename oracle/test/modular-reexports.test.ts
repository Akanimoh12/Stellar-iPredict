import { describe, expect, it } from "vitest";

describe("oracle aggregator modular re-exports (#644)", () => {
  it("allows importing narrowly from runner module without full barrel", async () => {
    const runner = await import("../src/aggregator/runner.js");
    expect(typeof runner.runAggregator).toBe("function");
    expect(typeof runner.startAggregator).toBe("function");
    expect(typeof runner.createProductionDependencies).toBe("function");
    expect(typeof runner.systemClock.now).toBe("function");
  });

  it("allows importing governance concern narrowly", async () => {
    const gov = await import("../src/aggregator/governance.js");
    expect(typeof gov.loadCouncilConfig).toBe("function");
    expect(typeof gov.CouncilVoteManager).toBe("function");
    expect(typeof gov.buildAuditRecord).toBe("function");
    expect(typeof gov.checkCouncilInactivity).toBe("function");
  });

  it("allows importing bonds concern narrowly", async () => {
    const bonds = await import("../src/aggregator/bonds.js");
    expect(typeof bonds.checkBondMinimum).toBe("function");
    expect(typeof bonds.getBondDashboardData).toBe("function");
    expect(typeof bonds.reconcileBonds).toBe("function");
  });

  it("allows importing settlement concern narrowly", async () => {
    const settlement = await import("../src/aggregator/settlement.js");
    expect(typeof settlement.finalizeMarketDecision).toBe("function");
    expect(typeof settlement.resolveMarketOnChain).toBe("function");
    expect(typeof settlement.OffChainSubmitterService).toBe("function");
    expect(typeof settlement.notifyFinalized).toBe("function");
  });

  it("allows importing watchers concern narrowly", async () => {
    const watchers = await import("../src/aggregator/watchers.js");
    expect(typeof watchers.detectNewSubmissions).toBe("function");
    expect(typeof watchers.detectDisputeEscalations).toBe("function");
    expect(typeof watchers.detectConflict).toBe("function");
    expect(typeof watchers.detectStuckMarket).toBe("function");
    expect(typeof watchers.validateSubmissionData).toBe("function");
  });

  it("maintains complete backward compatibility on main barrel index.js", async () => {
    const index = await import("../src/aggregator/index.js");
    expect(typeof index.runAggregator).toBe("function");
    expect(typeof index.startAggregator).toBe("function");
    expect(typeof index.loadCouncilConfig).toBe("function");
    expect(typeof index.checkBondMinimum).toBe("function");
    expect(typeof index.finalizeMarketDecision).toBe("function");
    expect(typeof index.detectNewSubmissions).toBe("function");
    expect(typeof index.OracleMetricsCollector).toBe("function");
    expect(typeof index.AggregatorHealthServer).toBe("function");
  });
});
