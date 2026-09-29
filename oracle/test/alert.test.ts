import { describe, expect, it, vi } from "vitest";
import { createWebhookAlertSender, classifyAlertSeverity } from "../src/aggregator/alert.js";

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
    const fetchImpl = vi.fn(async () => {
      throw new Error("network unreachable");
    });
    const send = createWebhookAlertSender("https://alerts.example.com/hook", undefined, fetchImpl);

    await expect(send({ marketId: "42", attempts: 3, error: new Error("x") })).resolves.toBeUndefined();
  });

  it("includes a severity in the payload (issue #649)", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const send = createWebhookAlertSender("https://alerts.example.com/hook", undefined, fetchImpl);

    await send({ marketId: "9", attempts: 2, error: new Error("bond amount discrepancy") });

    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.severity).toBe("SEV1");
  });
});

describe("classifyAlertSeverity", () => {
  it("SEV1 when the market holds user funds, whatever the error", () => {
    expect(
      classifyAlertSeverity({ marketId: "1", attempts: 1, error: new Error("rpc timeout"), holdsFunds: true }),
    ).toBe("SEV1");
  });

  it("SEV1 for a bond/stake discrepancy error", () => {
    expect(
      classifyAlertSeverity({ marketId: "1", attempts: 1, error: new Error("stake balance mismatch") }),
    ).toBe("SEV1");
  });

  it("SEV2 for a persistent non-fund failure", () => {
    expect(
      classifyAlertSeverity({ marketId: "1", attempts: 6, error: new Error("contract call reverted") }),
    ).toBe("SEV2");
  });

  it("SEV3 for a small number of likely-transient attempts", () => {
    expect(
      classifyAlertSeverity({ marketId: "1", attempts: 2, error: new Error("temporary rpc 502") }),
    ).toBe("SEV3");
  });
});
