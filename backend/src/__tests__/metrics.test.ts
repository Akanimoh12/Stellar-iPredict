import { describe, it, expect, afterEach } from "vitest";
import { buildServer } from "../server.js";
import { metrics, resetMetrics } from "../metrics.js";
import type { FastifyInstance } from "fastify";

let server: FastifyInstance | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  resetMetrics();
});

describe("API Metrics - Server Errors", () => {
  it("increments metric for 500 responses", async () => {
    server = buildServer();

    server.get("/test-500", async (_req, reply) => {
      reply.status(500).send({ error: "Internal Server Error" });
    });

    await server.ready();

    const res = await server.inject({ method: "GET", url: "/test-500" });

    expect(res.statusCode).toBe(500);
    expect(metrics.serverErrors.get()).toBe(1);
  });

  it("increments metric for 502 responses", async () => {
    server = buildServer();

    server.get("/test-502", async (_req, reply) => {
      reply.status(502).send({ error: "Bad Gateway" });
    });

    await server.ready();

    const res = await server.inject({ method: "GET", url: "/test-502" });

    expect(res.statusCode).toBe(502);
    expect(metrics.serverErrors.get()).toBe(1);
  });

  it("increments metric for 503 responses", async () => {
    server = buildServer();

    server.get("/test-503", async (_req, reply) => {
      reply.status(503).send({ error: "Service Unavailable" });
    });

    await server.ready();

    const res = await server.inject({ method: "GET", url: "/test-503" });

    expect(res.statusCode).toBe(503);
    expect(metrics.serverErrors.get()).toBe(1);
  });

  it("increments metric for 504 responses", async () => {
    server = buildServer();

    server.get("/test-504", async (_req, reply) => {
      reply.status(504).send({ error: "Gateway Timeout" });
    });

    await server.ready();

    const res = await server.inject({ method: "GET", url: "/test-504" });

    expect(res.statusCode).toBe(504);
    expect(metrics.serverErrors.get()).toBe(1);
  });

  it("increments metric for multiple 5xx responses", async () => {
    server = buildServer();

    server.get("/test-500", async (_req, reply) => {
      reply.status(500).send({ error: "Internal Server Error" });
    });

    server.get("/test-503", async (_req, reply) => {
      reply.status(503).send({ error: "Service Unavailable" });
    });

    await server.ready();

    await server.inject({ method: "GET", url: "/test-500" });
    await server.inject({ method: "GET", url: "/test-503" });
    await server.inject({ method: "GET", url: "/test-500" });

    expect(metrics.serverErrors.get()).toBe(3);
  });

  it("does not increment metric for 200 responses", async () => {
    server = buildServer();

    server.get("/test-200", async (_req, reply) => {
      reply.status(200).send({ status: "ok" });
    });

    await server.ready();

    const res = await server.inject({ method: "GET", url: "/test-200" });

    expect(res.statusCode).toBe(200);
    expect(metrics.serverErrors.get()).toBe(0);
  });

  it("does not increment metric for 201 responses", async () => {
    server = buildServer();

    server.post("/test-201", async (_req, reply) => {
      reply.status(201).send({ created: true });
    });

    await server.ready();

    const res = await server.inject({ method: "POST", url: "/test-201" });

    expect(res.statusCode).toBe(201);
    expect(metrics.serverErrors.get()).toBe(0);
  });

  it("does not increment metric for 400 responses", async () => {
    server = buildServer();

    server.get("/test-400", async (_req, reply) => {
      reply.status(400).send({ error: "Bad Request" });
    });

    await server.ready();

    const res = await server.inject({ method: "GET", url: "/test-400" });

    expect(res.statusCode).toBe(400);
    expect(metrics.serverErrors.get()).toBe(0);
  });

  it("does not increment metric for 404 responses", async () => {
    server = buildServer();

    await server.ready();

    const res = await server.inject({ method: "GET", url: "/nonexistent" });

    expect(res.statusCode).toBe(404);
    expect(metrics.serverErrors.get()).toBe(0);
  });

  it("does not increment metric for 301 redirect responses", async () => {
    server = buildServer();

    server.get("/test-301", async (_req, reply) => {
      reply.status(301).header("Location", "/other").send();
    });

    await server.ready();

    const res = await server.inject({ method: "GET", url: "/test-301" });

    expect(res.statusCode).toBe(301);
    expect(metrics.serverErrors.get()).toBe(0);
  });

  it("does not increment metric for 302 redirect responses", async () => {
    server = buildServer();

    server.get("/test-302", async (_req, reply) => {
      reply.status(302).header("Location", "/other").send();
    });

    await server.ready();

    const res = await server.inject({ method: "GET", url: "/test-302" });

    expect(res.statusCode).toBe(302);
    expect(metrics.serverErrors.get()).toBe(0);
  });

  it("does not increment metric for 304 not modified responses", async () => {
    server = buildServer();

    server.get("/test-304", async (_req, reply) => {
      reply.status(304).send();
    });

    await server.ready();

    const res = await server.inject({ method: "GET", url: "/test-304" });

    expect(res.statusCode).toBe(304);
    expect(metrics.serverErrors.get()).toBe(0);
  });

  it("handles mixed response codes correctly", async () => {
    server = buildServer();

    server.get("/test-200", async (_req, reply) => {
      reply.status(200).send({ status: "ok" });
    });

    server.get("/test-400", async (_req, reply) => {
      reply.status(400).send({ error: "Bad Request" });
    });

    server.get("/test-500", async (_req, reply) => {
      reply.status(500).send({ error: "Internal Server Error" });
    });

    await server.ready();

    await server.inject({ method: "GET", url: "/test-200" });
    await server.inject({ method: "GET", url: "/test-400" });
    await server.inject({ method: "GET", url: "/test-500" });
    await server.inject({ method: "GET", url: "/test-200" });
    await server.inject({ method: "GET", url: "/test-500" });

    expect(metrics.serverErrors.get()).toBe(2);
  });

  it("resets metrics correctly", async () => {
    server = buildServer();

    server.get("/test-500", async (_req, reply) => {
      reply.status(500).send({ error: "Internal Server Error" });
    });

    await server.ready();

    await server.inject({ method: "GET", url: "/test-500" });
    expect(metrics.serverErrors.get()).toBe(1);

    resetMetrics();
    expect(metrics.serverErrors.get()).toBe(0);

    await server.inject({ method: "GET", url: "/test-500" });
    expect(metrics.serverErrors.get()).toBe(1);
  });

  it("existing /healthz endpoint does not increment metric", async () => {
    server = buildServer();
    await server.ready();

    const res = await server.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
    expect(metrics.serverErrors.get()).toBe(0);
  });
});
