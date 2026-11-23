import { describe, expect, it, vi } from "vitest";
import { FeatureFlagManager } from "../src/config/featureFlags.js";
import {
  ExternalCallTimeoutError,
  withExternalTimeout,
} from "../src/adapters/timeoutManager.js";
import {
  checkPostgres,
  checkRedis,
  checkSorobanRpc,
  verifyStartupDependencies,
  DependencyCheckError,
} from "../src/config/dependencyCheck.js";
import {
  AuditTrailManager,
  type SoftDeletableRecord,
} from "../../backend/src/lib/auditTrail.js";

describe("Issue #640: Feature Flags for Progressive Rollout", () => {
  it("enables flags dynamically and evaluates safe fallback by default", () => {
    const manager = new FeatureFlagManager();
    expect(manager.isFlagEnabled("signature_v2")).toBe(false);

    manager.setFlag("signature_v2", { enabled: true });
    expect(manager.isFlagEnabled("signature_v2")).toBe(true);
  });

  it("supports partial enablement by provider or market subset", () => {
    const manager = new FeatureFlagManager({
      new_threshold_rule: {
        enabled: true,
        allowedProviders: ["provider-alpha", "provider-beta"],
        allowedMarkets: ["market-101", "market-202"],
      },
    });

    // Allowed provider and market
    expect(
      manager.isFlagEnabled("new_threshold_rule", {
        providerId: "provider-alpha",
        marketId: "market-101",
      })
    ).toBe(true);

    // Disallowed provider
    expect(
      manager.isFlagEnabled("new_threshold_rule", {
        providerId: "provider-gamma",
        marketId: "market-101",
      })
    ).toBe(false);

    // Disallowed market
    expect(
      manager.isFlagEnabled("new_threshold_rule", {
        providerId: "provider-alpha",
        marketId: "market-999",
      })
    ).toBe(false);
  });

  it("records active flags for decision tracing", () => {
    const manager = new FeatureFlagManager({
      flag_a: { enabled: true, allowedProviders: ["p1"] },
      flag_b: { enabled: true },
      flag_c: { enabled: false },
    });

    const active = manager.getActiveFlagsForDecision({ providerId: "p1" });
    expect(active).toEqual(["flag_a", "flag_b"]);
  });
});

describe("Issue #642: External Call Timeout Manager", () => {
  it("resolves quickly when external call finishes within timeout", async () => {
    const quickPromise = Promise.resolve("success");
    const result = await withExternalTimeout(quickPromise, 100, "fastOperation");
    expect(result).toBe("success");
  });

  it("bounds simulated hangs and produces classifiable ExternalCallTimeoutError", async () => {
    const hangingPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("late"), 500);
    });

    await expect(
      withExternalTimeout(hangingPromise, 50, "hangingHttpCall")
    ).rejects.toThrow(ExternalCallTimeoutError);

    try {
      await withExternalTimeout(hangingPromise, 50, "hangingHttpCall");
    } catch (err: any) {
      expect(err).toBeInstanceOf(ExternalCallTimeoutError);
      expect(err.name).toBe("ExternalCallTimeoutError");
      expect(err.errorCategory).toBe("TIMEOUT_ERROR");
      expect(err.operationName).toBe("hangingHttpCall");
      expect(err.timeoutMs).toBe(50);
    }
  });
});

describe("Issue #643: Startup Dependency Checks & Clear Diagnostics", () => {
  it("distinguishes misconfiguration from unavailability for Postgres", async () => {
    // Malformed URL -> misconfiguration
    const misconfig = await checkPostgres("invalid-postgres-url");
    expect(misconfig.healthy).toBe(false);
    expect(misconfig.failureKind).toBe("misconfiguration");

    // Valid URL but ping failed -> unavailability
    const unavailable = await checkPostgres(
      "postgresql://user:pass@localhost:5432/ipredict",
      async () => false
    );
    expect(unavailable.healthy).toBe(false);
    expect(unavailable.failureKind).toBe("unavailability");

    // Healthy check
    const healthy = await checkPostgres(
      "postgresql://user:pass@localhost:5432/ipredict",
      async () => true
    );
    expect(healthy.healthy).toBe(true);
  });

  it("distinguishes misconfiguration from unavailability for Redis and RPC", async () => {
    const redisMisconfig = await checkRedis("not_a_valid_redis_url");
    expect(redisMisconfig.failureKind).toBe("misconfiguration");

    const rpcMisconfig = await checkSorobanRpc("ftp://not-http-rpc");
    expect(rpcMisconfig.failureKind).toBe("misconfiguration");

    const rpcUnavailable = await checkSorobanRpc(
      "https://soroban-testnet.stellar.org",
      async () => {
        throw new Error("ECONNREFUSED");
      }
    );
    expect(rpcUnavailable.failureKind).toBe("unavailability");
  });

  it("reports verified dependencies on healthy startup", async () => {
    const report = await verifyStartupDependencies(
      {
        postgresUrl: "postgresql://localhost:5432/db",
        redisUrl: "redis://localhost:6379",
        sorobanRpcUrl: "https://soroban-testnet.stellar.org",
      },
      {
        pingPostgres: async () => true,
        pingRedis: async () => true,
        pingSorobanRpc: async () => true,
      }
    );

    expect(report.allHealthy).toBe(true);
    expect(report.checks.length).toBe(3);
    expect(report.checks.every((c) => c.healthy)).toBe(true);
  });

  it("throws DependencyCheckError on failure when requested", async () => {
    await expect(
      verifyStartupDependencies(
        {
          postgresUrl: "invalid-url",
        },
        {},
        true
      )
    ).rejects.toThrow(DependencyCheckError);
  });
});

describe("Issue #1012: Soft Delete and Admin Audit Trail", () => {
  it("records admin audit actions with actor, target, timestamp, and values", () => {
    const audit = new AuditTrailManager();
    const logger = { info: vi.fn() };

    const entry = audit.recordAdminAudit(
      {
        action: "update",
        actor: "admin-pubkey-xyz",
        targetId: 42,
        entityType: "market_config",
        timestamp: new Date(),
        previousValue: { threshold: 2 },
        newValue: { threshold: 3 },
      },
      logger
    );

    expect(entry.actor).toBe("admin-pubkey-xyz");
    expect(entry.targetId).toBe(42);
    expect(audit.getAllAuditEntries().length).toBe(1);
    expect(logger.info).toHaveBeenCalled();
  });

  it("applies consistent soft delete semantics and audit trail", () => {
    const audit = new AuditTrailManager();

    interface Market extends SoftDeletableRecord {
      id: number;
      name: string;
    }

    const market: Market = { id: 101, name: "Stellar vs BTC" };
    const { updatedEntity, auditEntry } = audit.softDeleteEntity(
      market,
      "admin-alice",
      "market",
      "Duplicated market"
    );

    expect(updatedEntity.is_deleted).toBe(true);
    expect(updatedEntity.deleted_by).toBe("admin-alice");
    expect(updatedEntity.deleted_at).toBeInstanceOf(Date);

    expect(auditEntry.action).toBe("soft_delete");
    expect(auditEntry.isSoftDeleted).toBe(true);
    expect(auditEntry.metadata).toEqual({ reason: "Duplicated market" });
  });
});
