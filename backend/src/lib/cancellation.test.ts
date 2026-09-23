/**
 * Tests for registerCancellationHook (#475).
 *
 * Verified directly against Fastify (not just fake EventEmitters) so we
 * exercise the real onRequest hook wiring; the "client disconnect" itself is
 * simulated by emitting `close` on `reply.raw` before the handler responds,
 * since Fastify's `inject()` doesn't tear down a real socket.
 */

import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerCancellationHook } from "./cancellation.js";

describe("registerCancellationHook", () => {
  it("does not abort when the request completes normally", async () => {
    const app = Fastify();
    registerCancellationHook(app);

    let sawSignal: AbortSignal | undefined;
    app.get("/ok", async (request) => {
      sawSignal = request.abortSignal;
      return { ok: true };
    });

    const res = await app.inject({ method: "GET", url: "/ok" });

    expect(res.statusCode).toBe(200);
    expect(sawSignal?.aborted).toBe(false);

    await app.close();
  });

  it("aborts request.abortSignal when reply.raw emits 'close' before the response finishes", async () => {
    const app = Fastify();
    registerCancellationHook(app);

    let capturedSignal: AbortSignal | undefined;
    let handlerSawAbort = false;

    app.get("/slow", async (request, reply) => {
      capturedSignal = request.abortSignal;
      // Simulate the client disconnecting mid-handler: fire 'close' on the
      // real raw ServerResponse before we've written anything.
      expect(reply.raw.writableEnded).toBe(false);
      reply.raw.emit("close");

      // Give the signal's listener a turn to run.
      await new Promise((resolve) => setImmediate(resolve));
      handlerSawAbort = capturedSignal?.aborted ?? false;

      return { ok: true };
    });

    await app.inject({ method: "GET", url: "/slow" });

    expect(handlerSawAbort).toBe(true);
    expect(capturedSignal?.aborted).toBe(true);

    await app.close();
  });

  it("ignores 'close' once the response has already finished", async () => {
    const app = Fastify();
    registerCancellationHook(app);

    let capturedSignal: AbortSignal | undefined;
    app.get("/fast", async (request) => {
      capturedSignal = request.abortSignal;
      return { ok: true };
    });

    const res = await app.inject({ method: "GET", url: "/fast" });
    expect(res.statusCode).toBe(200);

    // By the time inject() resolves, 'finish' (and often 'close') has
    // already fired on a completed response; the signal must not have been
    // aborted by that trailing 'close'.
    expect(capturedSignal?.aborted).toBe(false);

    await app.close();
  });
});
