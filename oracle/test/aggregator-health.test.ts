import { describe, expect, it, vi } from "vitest";
import { AggregatorHealthServer } from "../src/aggregator/health.js";

describe("AggregatorHealthServer", () => {
  it("starts, serves /health/live and /health/ready, and stops cleanly", async () => {
    let lastPoll: number | null = Date.now();
    const server = new AggregatorHealthServer({
      port: 0,
      host: "127.0.0.1",
      maxStaleMs: 10_000,
      getLastPollCompletedAt: () => lastPoll,
      checkReadiness: async () => ({
        db: { ok: true, latencyMs: 5 },
        rpc: { ok: true, latencyMs: 12 },
      }),
    });

    await server.start();
    const addr = server.address();
    expect(addr).not.toBeNull();
    const port = addr!.port;

    const liveRes = await fetch(`http://127.0.0.1:${port}/health/live`);
    expect(liveRes.status).toBe(200);
    const liveBody = await liveRes.json();
    expect(liveBody.status).toBe("live");

    const readyRes = await fetch(`http://127.0.0.1:${port}/health/ready`);
    expect(readyRes.status).toBe(200);
    const readyBody = await readyRes.json();
    expect(readyBody.status).toBe("ready");
    expect(readyBody.checks.db.ok).toBe(true);

    await server.stop();
  });

  it("fails liveness probe when poll iteration is too stale", async () => {
    const server = new AggregatorHealthServer({
      port: 0,
      host: "127.0.0.1",
      maxStaleMs: 1_000,
      getLastPollCompletedAt: () => Date.now() - 5_000,
      checkReadiness: async () => ({
        db: { ok: true },
        rpc: { ok: true },
      }),
    });

    await server.start();
    const port = server.address()!.port;

    const res = await fetch(`http://127.0.0.1:${port}/livez`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("dead");

    await server.stop();
  });

  it("fails readiness probe when database or RPC is unreachable", async () => {
    const server = new AggregatorHealthServer({
      port: 0,
      host: "127.0.0.1",
      maxStaleMs: 10_000,
      getLastPollCompletedAt: () => Date.now(),
      checkReadiness: async () => ({
        db: { ok: true, latencyMs: 2 },
        rpc: { ok: false, error: "RPC Connection Refused" },
      }),
    });

    await server.start();
    const port = server.address()!.port;

    const res = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("not ready");
    expect(body.checks.rpc.ok).toBe(false);

    await server.stop();
  });
});
