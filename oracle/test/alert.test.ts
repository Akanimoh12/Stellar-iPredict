/**
 * Tests for oracle alert deduplication, grouping, cooldown, and resolution
 * notifications (issue #583).
 *
 * All tests use an injected clock and mock channels so they run
 * deterministically with no I/O.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  classifyAlertSeverity,
  createAlertRouter,
  createWebhookAlertSender,
  createWebhookAlertChannel,
  createAmbiguousTallyAlertSender,
  type AlertChannel,
  type Alert,
} from "../src/aggregator/alert.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const T0 = 1_700_000_000_000; // arbitrary epoch for tests
const MIN = 60_000;

function makeClock(startMs = T0): { now: () => number; advance: (ms: number) => void } {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

function makeChannel(minSeverity: "SEV1" | "SEV2" | "SEV3" = "SEV3"): {
  channel: AlertChannel;
  received: Alert[][];
} {
  const received: Alert[][] = [];
  const channel: AlertChannel = {
    name: "test",
    minSeverity,
    async send(alerts) { received.push([...alerts]); },
  };
  return { channel, received };
}

// ── classifyAlertSeverity ─────────────────────────────────────────────────────

describe("classifyAlertSeverity", () => {
  it("SEV1 when holdsFunds is true regardless of attempts or error", () => {
    expect(classifyAlertSeverity({ marketId: "1", attempts: 1, error: new Error("any"), holdsFunds: true })).toBe("SEV1");
  });

  it("SEV1 for errors mentioning bond/stake/balance/discrepancy/mismatch/escrow", () => {
    for (const kw of ["bond amount too low", "stake balance mismatch", "escrow discrepancy"]) {
      expect(classifyAlertSeverity({ marketId: "1", attempts: 1, error: new Error(kw) })).toBe("SEV1");
    }
  });

  it("SEV2 for persistent non-fund failures (>=5 attempts)", () => {
    expect(classifyAlertSeverity({ marketId: "1", attempts: 5, error: new Error("contract call reverted") })).toBe("SEV2");
    expect(classifyAlertSeverity({ marketId: "1", attempts: 10, error: new Error("rpc timeout") })).toBe("SEV2");
  });

  it("SEV3 for a small number of likely-transient attempts", () => {
    expect(classifyAlertSeverity({ marketId: "1", attempts: 1, error: new Error("502 bad gateway") })).toBe("SEV3");
    expect(classifyAlertSeverity({ marketId: "1", attempts: 4, error: new Error("timeout") })).toBe("SEV3");
  });
});

// ── createWebhookAlertSender (backwards-compat) ───────────────────────────────

describe("createWebhookAlertSender", () => {
  it("posts a JSON payload describing the persistent failure", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const send = createWebhookAlertSender("https://alerts.example.com/hook", undefined, fetchImpl);

    await send({ marketId: "42", attempts: 3, error: new Error("rpc down") });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://alerts.example.com/hook",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toMatchObject({
      type: "oracle.aggregator.submit_failed",
      marketId: "42",
      attempts: 3,
      error: "rpc down",
    });
  });

  it("does not throw when no webhook is configured", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const send = createWebhookAlertSender(undefined, undefined, fetchImpl);

    await expect(send({ marketId: "42", attempts: 3, error: new Error("x") })).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("swallows webhook delivery errors instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("network unreachable"); });
    const send = createWebhookAlertSender("https://alerts.example.com/hook", undefined, fetchImpl);

    await expect(send({ marketId: "42", attempts: 3, error: new Error("x") })).resolves.toBeUndefined();
  });

  it("includes a severity in the payload", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const send = createWebhookAlertSender("https://alerts.example.com/hook", undefined, fetchImpl);

    await send({ marketId: "9", attempts: 2, error: new Error("bond amount discrepancy") });

    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.severity).toBe("SEV1");
  });
});

// ── createAlertRouter — deduplication ─────────────────────────────────────────

describe("createAlertRouter — deduplication", () => {
  it("fires the first occurrence immediately", async () => {
    const clock = makeClock();
    const { channel, received } = makeChannel();
    const router = createAlertRouter({ channels: [channel], clock: clock.now });

    await router({ marketId: "1", attempts: 6, error: new Error("rpc timeout") });

    expect(received).toHaveLength(1);
    expect(received[0]![0]).toMatchObject({
      type: "oracle.aggregator.submit_failed",
      entityId: "1",
    });
  });

  it("suppresses a second occurrence within the cooldown window", async () => {
    const clock = makeClock();
    const { channel, received } = makeChannel();
    const router = createAlertRouter({ channels: [channel], cooldownMs: 15 * MIN, clock: clock.now });

    await router({ marketId: "1", attempts: 6, error: new Error("rpc timeout") });
    clock.advance(5 * MIN); // still within 15-min cooldown
    await router({ marketId: "1", attempts: 7, error: new Error("rpc timeout") });

    expect(received).toHaveLength(1); // only the first one
  });

  it("re-notifies after the cooldown window elapses", async () => {
    const clock = makeClock();
    const { channel, received } = makeChannel();
    const router = createAlertRouter({ channels: [channel], cooldownMs: 15 * MIN, clock: clock.now });

    await router({ marketId: "1", attempts: 6, error: new Error("rpc timeout") });
    clock.advance(16 * MIN); // past cooldown
    await router({ marketId: "1", attempts: 7, error: new Error("rpc timeout") });

    expect(received).toHaveLength(2);
  });

  it("deduplicates by entityId — different markets fire independently", async () => {
    const clock = makeClock();
    const { channel, received } = makeChannel();
    const router = createAlertRouter({ channels: [channel], cooldownMs: 15 * MIN, clock: clock.now });

    await router({ marketId: "1", attempts: 6, error: new Error("rpc timeout") });
    await router({ marketId: "2", attempts: 6, error: new Error("rpc timeout") });

    expect(received).toHaveLength(2);
  });

  it("ongoing condition fires exactly once per cooldown window across many polls", async () => {
    const clock = makeClock();
    const { channel, received } = makeChannel();
    const router = createAlertRouter({ channels: [channel], cooldownMs: 15 * MIN, clock: clock.now });

    // Simulate 31 polls at 30-second intervals.
    // Poll 1 (t=0): fires immediately.
    // Polls 2–30 (t=30s … t=870s): all within 15-min cooldown, suppressed.
    // Poll 31 (t=900s = 15 min): cooldown elapsed → re-notifies.
    for (let i = 0; i < 31; i++) {
      await router({ marketId: "5", attempts: 6, error: new Error("stuck") });
      clock.advance(30_000); // 30 s per poll
    }

    expect(received).toHaveLength(2);
  });
});

// ── createAlertRouter — resolution notifications ──────────────────────────────

describe("createAlertRouter — resolution notifications", () => {
  it("sends a resolution notification when a previously active condition clears", async () => {
    const clock = makeClock();
    const { channel, received } = makeChannel();
    const router = createAlertRouter({ channels: [channel], clock: clock.now });

    // Condition fires on first poll.
    await router({ marketId: "3", attempts: 6, error: new Error("stuck") });

    const key = "oracle.aggregator.submit_failed:3";
    const activeAfterFire = router.activeConditions();
    expect(activeAfterFire.has(key)).toBe(true);

    // Next poll: condition is absent — reconcile with an empty active-key set.
    await router.reconcile(new Set());

    // Should have received a resolution notification.
    const allAlerts = received.flat();
    const resolution = allAlerts.find((a) => a.resolved === true);
    expect(resolution).toBeDefined();
    expect(resolution!.entityId).toBe("3");

    // Condition removed from active map.
    expect(router.activeConditions().has(key)).toBe(false);
  });

  it("does not send a resolution if the condition is still active", async () => {
    const clock = makeClock();
    const { channel, received } = makeChannel();
    const router = createAlertRouter({ channels: [channel], cooldownMs: 15 * MIN, clock: clock.now });

    await router({ marketId: "7", attempts: 6, error: new Error("stuck") });
    const key = "oracle.aggregator.submit_failed:7";

    // Reconcile with the key still present.
    await router.reconcile(new Set([key]));

    const allAlerts = received.flat();
    expect(allAlerts.some((a) => a.resolved === true)).toBe(false);
    expect(router.activeConditions().has(key)).toBe(true);
  });

  it("resolution notification fires immediately, not after cooldown", async () => {
    const clock = makeClock();
    const { channel, received } = makeChannel();
    const router = createAlertRouter({ channels: [channel], cooldownMs: 60 * MIN, clock: clock.now });

    await router({ marketId: "9", attempts: 6, error: new Error("stuck") });
    // Only 1 min in — well within cooldown.
    clock.advance(1 * MIN);
    await router.reconcile(new Set());

    const resolution = received.flat().find((a) => a.resolved === true);
    expect(resolution).toBeDefined();
  });

  it("a genuinely new occurrence after resolution fires immediately", async () => {
    const clock = makeClock();
    const { channel, received } = makeChannel();
    const router = createAlertRouter({ channels: [channel], cooldownMs: 15 * MIN, clock: clock.now });

    // First occurrence.
    await router({ marketId: "11", attempts: 6, error: new Error("err") });
    // Condition clears.
    await router.reconcile(new Set());
    const countAfterResolution = received.flat().length;

    // New occurrence — should fire immediately even though cooldown hasn't passed.
    await router({ marketId: "11", attempts: 6, error: new Error("err again") });
    expect(received.flat().length).toBe(countAfterResolution + 1);
  });
});

// ── createAlertRouter — grouping ──────────────────────────────────────────────

describe("createAlertRouter — grouping", () => {
  it("assigns matching groupKey to alerts of the same type and severity", async () => {
    const received: Alert[][] = [];
    const channel: AlertChannel = {
      name: "test",
      minSeverity: "SEV3",
      async send(alerts) { received.push([...alerts]); },
    };
    const clock = makeClock();
    const router = createAlertRouter({ channels: [channel], clock: clock.now });

    // Fire two different markets at the same severity — same type.
    await router({ marketId: "20", attempts: 6, error: new Error("rpc error") });
    await router({ marketId: "21", attempts: 6, error: new Error("rpc error") });

    const allAlerts = received.flat();
    // Each gets a groupKey matching its (type, severity) group.
    for (const alert of allAlerts) {
      expect(alert.groupKey).toMatch(/^oracle\.aggregator\.submit_failed:/);
    }
    // Both have the same groupKey since they're same type+severity.
    expect(allAlerts[0]!.groupKey).toBe(allAlerts[1]!.groupKey);
  });
});

// ── createAlertRouter — channel severity filtering ────────────────────────────

describe("createAlertRouter — channel severity filtering", () => {
  it("SEV1-only channel receives SEV1 alerts but not SEV3", async () => {
    const clock = makeClock();
    const { channel: sev1Channel, received: sev1Received } = makeChannel("SEV1");
    const { channel: allChannel, received: allReceived } = makeChannel("SEV3");
    const router = createAlertRouter({
      channels: [sev1Channel, allChannel],
      clock: clock.now,
    });

    // SEV3 alert (2 attempts, no fund keywords).
    await router({ marketId: "30", attempts: 2, error: new Error("transient error") });

    expect(sev1Received.flat()).toHaveLength(0); // SEV1 channel filtered it out
    expect(allReceived.flat()).toHaveLength(1);  // SEV3 channel received it
  });

  it("SEV1 channel receives SEV1 alerts", async () => {
    const clock = makeClock();
    const { channel: sev1Channel, received: sev1Received } = makeChannel("SEV1");
    const router = createAlertRouter({ channels: [sev1Channel], clock: clock.now });

    await router({ marketId: "31", attempts: 1, error: new Error("bond discrepancy"), holdsFunds: true });

    expect(sev1Received.flat()).toHaveLength(1);
    expect(sev1Received[0]![0]!.severity).toBe("SEV1");
  });
});

// ── createWebhookAlertChannel ─────────────────────────────────────────────────

describe("createWebhookAlertChannel", () => {
  it("POSTs a JSON batch to the webhook URL", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const channel = createWebhookAlertChannel({
      name: "webhook",
      webhookUrl: "https://hooks.example.com/alert",
      fetchFn: fetchImpl,
    });

    const alerts: Alert[] = [
      { type: "oracle.aggregator.submit_failed", severity: "SEV2", entityId: "42",
        payload: { marketId: "42" }, firedAt: new Date().toISOString() },
    ];
    await channel.send(alerts);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.example.com/alert");
    const body = JSON.parse(String(init.body));
    expect(body.count).toBe(1);
    expect(body.alerts[0].type).toBe("oracle.aggregator.submit_failed");
  });

  it("filters out alerts below minSeverity", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const channel = createWebhookAlertChannel({
      name: "webhook",
      webhookUrl: "https://hooks.example.com/alert",
      minSeverity: "SEV1",
      fetchFn: fetchImpl,
    });

    const alerts: Alert[] = [
      { type: "oracle.aggregator.submit_failed", severity: "SEV3", entityId: "99",
        payload: {}, firedAt: new Date().toISOString() },
    ];
    await channel.send(alerts);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("swallows delivery errors so a broken webhook cannot stop the aggregator", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const channel = createWebhookAlertChannel({
      name: "webhook",
      webhookUrl: "https://hooks.example.com/alert",
      fetchFn: fetchImpl,
    });

    const alerts: Alert[] = [
      { type: "oracle.aggregator.submit_failed", severity: "SEV2", entityId: "1",
        payload: {}, firedAt: new Date().toISOString() },
    ];
    await expect(channel.send(alerts)).resolves.toBeUndefined();
  });
});

// ── createAmbiguousTallyAlertSender ───────────────────────────────────────────

describe("createAmbiguousTallyAlertSender", () => {
  it("fires the first ambiguous tally alert immediately", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const send = createAmbiguousTallyAlertSender("https://hooks.example.com/tally", undefined, fetchImpl);

    await send({ marketId: "50", yesVotes: 3, noVotes: 3, threshold: 4 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.type).toBe("oracle.aggregator.ambiguous_tally");
    expect(body.marketId).toBe("50");
  });

  it("suppresses a duplicate ambiguous tally within the cooldown window", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const send = createAmbiguousTallyAlertSender("https://hooks.example.com/tally", undefined, fetchImpl);

    await send({ marketId: "51", yesVotes: 3, noVotes: 3, threshold: 4 });
    // Simulate another poll immediately — same condition.
    await send({ marketId: "51", yesVotes: 3, noVotes: 3, threshold: 4 });

    expect(fetchImpl).toHaveBeenCalledTimes(1); // only once
  });

  it("does not throw when no webhook is configured", async () => {
    const fetchImpl = vi.fn();
    const send = createAmbiguousTallyAlertSender(undefined, undefined, fetchImpl as unknown as typeof fetch);

    await expect(send({ marketId: "52", yesVotes: 2, noVotes: 2, threshold: 4 })).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("swallows delivery errors", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("connect timeout"); });
    const send = createAmbiguousTallyAlertSender("https://hooks.example.com/tally", undefined, fetchImpl);

    await expect(send({ marketId: "53", yesVotes: 3, noVotes: 3, threshold: 4 })).resolves.toBeUndefined();
  });
});

// ── State reset ───────────────────────────────────────────────────────────────

describe("AlertRouter._reset", () => {
  it("clears active conditions so alerts fire again after reset", async () => {
    const clock = makeClock();
    const { channel, received } = makeChannel();
    const router = createAlertRouter({ channels: [channel], cooldownMs: 60 * MIN, clock: clock.now });

    await router({ marketId: "99", attempts: 6, error: new Error("err") });
    expect(received).toHaveLength(1);

    // Within cooldown — would be suppressed.
    clock.advance(1 * MIN);
    await router({ marketId: "99", attempts: 6, error: new Error("err") });
    expect(received).toHaveLength(1); // suppressed

    // Reset and fire again.
    router._reset();
    await router({ marketId: "99", attempts: 6, error: new Error("err") });
    expect(received).toHaveLength(2); // fires again
  });
});
