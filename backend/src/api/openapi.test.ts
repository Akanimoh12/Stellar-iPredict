import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "@/server";
import { DOCS_ROUTE, OPENAPI_VERSION, buildOpenApiDocument } from "@/api/openapi";

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, { summary?: string; tags?: string[] }>>;
  components?: { securitySchemes?: Record<string, unknown> };
}

let server: FastifyInstance | undefined;

async function fetchSpec(): Promise<OpenApiDocument> {
  server = buildServer({ corsOrigins: [] });

  const res = await server.inject({ method: "GET", url: DOCS_ROUTE });

  expect(res.statusCode).toBe(200);
  return res.json() as OpenApiDocument;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("buildOpenApiDocument", () => {
  it("describes the API", () => {
    const doc = buildOpenApiDocument();

    expect(doc.openapi).toBe(OPENAPI_VERSION);
    expect(doc.info.title).toBe("iPredict API");
    expect(doc.info.version).toBe("0.1.0");
  });

  it("accepts a version override", () => {
    expect(buildOpenApiDocument({ version: "1.2.3" }).info.version).toBe("1.2.3");
  });

  it("declares the oracle bearer scheme", () => {
    expect(buildOpenApiDocument().components.securitySchemes.oracleApiKey).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
  });
});

describe("GET /api/docs", () => {
  it("serves the spec as JSON", async () => {
    server = buildServer({ corsOrigins: [] });

    const res = await server.inject({ method: "GET", url: DOCS_ROUTE });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
  });

  it("returns a valid OpenAPI envelope", async () => {
    const spec = await fetchSpec();

    expect(spec.openapi).toBe(OPENAPI_VERSION);
    expect(spec.info).toMatchObject({ title: "iPredict API", version: "0.1.0" });
    expect(spec.components?.securitySchemes).toHaveProperty("oracleApiKey");
  });

  it("generates paths from the registered route schemas", async () => {
    const spec = await fetchSpec();

    expect(spec.paths["/healthz"]).toBeDefined();
    expect(spec.paths["/healthz"].get.summary).toBe("Liveness probe");
    expect(spec.paths["/healthz"].get.tags).toContain("system");
  });

  it("documents itself", async () => {
    const spec = await fetchSpec();

    expect(spec.paths[DOCS_ROUTE]).toBeDefined();
  });

  it("carries the security headers applied to every route", async () => {
    server = buildServer({ corsOrigins: [] });

    const res = await server.inject({ method: "GET", url: DOCS_ROUTE });

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
