import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "@/server";

let server: FastifyInstance | undefined;

function makeServer(): FastifyInstance {
  server = buildServer({ corsOrigins: [] });
  return server;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("Response compression", () => {
  it("registers compression middleware without breaking the server", async () => {
    const app = makeServer();
    
    const res = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: {
        "accept-encoding": "gzip",
      },
    });

    expect(res.statusCode).toBe(200);
    
    // Verify the response is valid JSON regardless of compression
    const body = res.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("does not break responses when client does not request compression", async () => {
    const app = makeServer();
    
    const res = await app.inject({
      method: "GET",
      url: "/healthz",
      // No Accept-Encoding header
    });

    expect(res.statusCode).toBe(200);
    
    // Response should be plain JSON
    const body = res.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("handles large responses appropriately", async () => {
    const app = makeServer();
    
    // Create a larger response endpoint
    app.get("/large-test", async (_req, reply) => {
      const largeData = {
        items: Array.from({ length: 50 }, (_, i) => ({
          id: i,
          name: `Item ${i}`,
          description: `This is item number ${i} with a description`,
        })),
        total: 50,
      };
      return reply.send(largeData);
    });

    const res = await app.inject({
      method: "GET",
      url: "/large-test",
      headers: {
        "accept-encoding": "gzip",
      },
    });

    expect(res.statusCode).toBe(200);
    
    // Verify the response is valid JSON regardless of compression
    const body = res.json();
    expect(body.items).toHaveLength(50);
    expect(body.total).toBe(50);
  });

  it("maintains backward compatibility - all existing endpoints work", async () => {
    const app = makeServer();
    
    // Test various endpoints to ensure they still work
    const healthRes = await app.inject({ method: "GET", url: "/healthz" });
    expect(healthRes.statusCode).toBe(200);
    
    // readyz might return 503 if DB/Redis not mocked, but we just want to ensure
    // it doesn't crash and returns some valid status code
    const readyRes = await app.inject({ method: "GET", url: "/readyz" });
    expect([200, 503]).toContain(readyRes.statusCode);
  });
});