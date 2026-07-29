import { describe, expect, it, vi } from "vitest";
import { createWebhookAlertSender } from "../src/aggregator/alert.js";

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
});
