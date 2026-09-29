import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  checkLiveness,
  checkReadiness,
  recordPollLoopProgress,
  type HealthCheckDeps,
} from "../health.js";

describe("health", () => {
  beforeEach(() => {
    // Reset the internal state by recording fresh progress
    recordPollLoopProgress(100);
  });

  describe("checkLiveness", () => {
    it("returns ok when poll loop has advanced recently", () => {
      recordPollLoopProgress(150);
      const result = checkLiveness();

      expect(result.status).toBe("ok");
      expect(result.checks.pollLoop?.status).toBe("ok");
      expect(result.checks.pollLoop?.lastLedger).toBe(150);
    });

    it("returns unhealthy when poll loop is stalled", async () => {
      recordPollLoopProgress(100);
      
      // Wait long enough to exceed the stall threshold (mocked via env)
      const originalEnv = process.env.POLL_LOOP_STALL_THRESHOLD_MS;
      process.env.POLL_LOOP_STALL_THRESHOLD_MS = "10"; // 10ms for test
      
      await new Promise((resolve) => setTimeout(resolve, 20));
      
      const result = checkLiveness();
      
      expect(result.status).toBe("unhealthy");
      expect(result.checks.pollLoop?.status).toBe("stalled");
      expect(result.checks.pollLoop?.stalledForMs).toBeGreaterThan(10);
      
      // Restore
      if (originalEnv) {
        process.env.POLL_LOOP_STALL_THRESHOLD_MS = originalEnv;
      } else {
        delete process.env.POLL_LOOP_STALL_THRESHOLD_MS;
      }
    });
  });

  describe("checkReadiness", () => {
    it("returns ok when all dependencies are healthy and lag is acceptable", async () => {
      const deps: HealthCheckDeps = {
        db: {
          query: vi.fn().mockResolvedValue({ rows: [{ result: 1 }] }),
        },
        rpc: {
          getLatestLedger: vi.fn().mockResolvedValue({ sequence: 200 }),
        },
        getLastProcessedLedger: () => 190, // Lag of 10
      };

      const result = await checkReadiness(deps);

      expect(result.status).toBe("ok");
      expect(result.checks.database?.status).toBe("ok");
      expect(result.checks.rpc?.status).toBe("ok");
      expect(result.checks.lag?.status).toBe("ok");
      expect(result.checks.lag?.ledgersBehind).toBe(10);
    });

    it("returns unhealthy when database is unreachable", async () => {
      const deps: HealthCheckDeps = {
        db: {
          query: vi.fn().mockRejectedValue(new Error("connection refused")),
        },
        rpc: {
          getLatestLedger: vi.fn().mockResolvedValue({ sequence: 200 }),
        },
        getLastProcessedLedger: () => 190,
      };

      const result = await checkReadiness(deps);

      expect(result.status).toBe("unhealthy");
      expect(result.checks.database?.status).toBe("unreachable");
      expect(result.checks.database?.error).toContain("connection refused");
    });

    it("returns unhealthy when rpc is unreachable", async () => {
      const deps: HealthCheckDeps = {
        db: {
          query: vi.fn().mockResolvedValue({ rows: [{ result: 1 }] }),
        },
        rpc: {
          getLatestLedger: vi.fn().mockRejectedValue(new Error("rpc timeout")),
        },
        getLastProcessedLedger: () => 190,
      };

      const result = await checkReadiness(deps);

      expect(result.status).toBe("unhealthy");
      expect(result.checks.rpc?.status).toBe("unreachable");
      expect(result.checks.rpc?.error).toContain("rpc timeout");
    });

    it("returns degraded when lag is high", async () => {
      const originalEnv = process.env.MAX_LAG_LEDGERS;
      process.env.MAX_LAG_LEDGERS = "100";

      const deps: HealthCheckDeps = {
        db: {
          query: vi.fn().mockResolvedValue({ rows: [{ result: 1 }] }),
        },
        rpc: {
          getLatestLedger: vi.fn().mockResolvedValue({ sequence: 300 }),
        },
        getLastProcessedLedger: () => 100, // Lag of 200, exceeds threshold
      };

      const result = await checkReadiness(deps);

      expect(result.status).toBe("degraded");
      expect(result.checks.lag?.status).toBe("high");
      expect(result.checks.lag?.ledgersBehind).toBe(200);
      expect(result.checks.lag?.threshold).toBe(100);

      if (originalEnv) {
        process.env.MAX_LAG_LEDGERS = originalEnv;
      } else {
        delete process.env.MAX_LAG_LEDGERS;
      }
    });
  });
});
