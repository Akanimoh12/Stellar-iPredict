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

  it("documents every registered route", async () => {
    // `registeredRoutes` is populated by an onRoute hook attached before
    // anything else in buildServer, so it lists every route regardless of
    // registration order — unlike the spec, whose generator only sees routes
    // registered after `registerOpenApi` runs (#476). Diffing the two here is
    // the regression test: a route registered ahead of registerOpenApi again
    // (or a brand-new plugin registered in the wrong spot) shows up as a
    // route present in `registeredRoutes` but missing from `spec.paths`.
    server = buildServer({ corsOrigins: [] });

    const routeTable = server.registeredRoutes;
    expect(routeTable.length).toBeGreaterThan(0);

    const res = await server.inject({ method: "GET", url: DOCS_ROUTE });
    expect(res.statusCode).toBe(200);
    const spec = res.json() as OpenApiDocument;

    const missing: string[] = [];
    for (const { method, url } of routeTable) {
      // Fastify route URLs use `:param`; OpenAPI/Swagger paths use `{param}`.
      const openApiPath = url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
      const pathItem = spec.paths[openApiPath];
      const documented = pathItem && Object.keys(pathItem).some(
        (key) => key.toLowerCase() === method.toLowerCase()
      );
      if (!documented) {
        missing.push(`${method} ${url}`);
      }
    }

    expect(
      missing,
      `these routes are registered but missing from the OpenAPI spec: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("documents response shapes, including error responses, for every path", async () => {
    const spec = await fetchSpec();

    const undocumentedResponses: string[] = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const responses = (operation as { responses?: Record<string, unknown> }).responses;
        if (!responses || Object.keys(responses).length === 0) {
          undocumentedResponses.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }

    expect(
      undocumentedResponses,
      `these operations have no documented response shapes: ${undocumentedResponses.join(", ")}`
    ).toEqual([]);
  });

  it("produces a structurally valid OpenAPI 3.1 document", async () => {
    const spec = await fetchSpec();

    // No OpenAPI schema-validation package (e.g. openapi-schema-validator,
    // @apidevtools/swagger-parser) is a dependency of this project, so this
    // asserts the structural invariants the OpenAPI 3.1 spec requires of the
    // top-level document and every operation, rather than pulling in a new
    // dependency for one test.
    expect(spec.openapi).toMatch(/^3\.1\.\d+$/);
    expect(typeof spec.info).toBe("object");
    expect(typeof spec.info.title).toBe("string");
    expect(spec.info.title.length).toBeGreaterThan(0);
    expect(typeof spec.info.version).toBe("string");
    expect(spec.info.version.length).toBeGreaterThan(0);
    expect(typeof spec.paths).toBe("object");
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);

    const validMethods = new Set([
      "get",
      "put",
      "post",
      "delete",
      "options",
      "head",
      "patch",
      "trace",
    ]);

    for (const [path, methods] of Object.entries(spec.paths)) {
      expect(path.startsWith("/"), `path "${path}" must start with "/"`).toBe(true);
      expect(typeof methods).toBe("object");

      for (const [method, operation] of Object.entries(methods)) {
        expect(
          validMethods.has(method.toLowerCase()),
          `"${method}" on ${path} is not a valid OpenAPI HTTP method`
        ).toBe(true);
        expect(typeof (operation as { responses?: unknown }).responses).toBe("object");

        const responses = (operation as { responses: Record<string, unknown> }).responses;
        for (const status of Object.keys(responses)) {
          expect(
            /^[1-5](\d{2}|XX)$|^default$/.test(status),
            `response key "${status}" on ${method.toUpperCase()} ${path} is not a valid status code`
          ).toBe(true);
        }
      }
    }
  });
});
