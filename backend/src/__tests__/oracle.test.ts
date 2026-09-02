import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { registerOracleRoutes } from "../api/oracle.js";

describe("registerOracleRoutes - pool validation", () => {
  it("should throw at registration time when neither pool nor dbOverride is provided", () => {
    const server = Fastify();

    expect(() => {
      registerOracleRoutes(server);
    }).toThrow(
      "Oracle routes require a database pool. Pass options.pool to buildServer or dbOverride to registerOracleRoutes.",
    );
  });

  it("should not throw when pool is provided", () => {
    const server = Fastify();
    const mockPool = {
      query: () => Promise.resolve({ rows: [] }),
    };

    expect(() => {
      registerOracleRoutes(server, mockPool as any);
    }).not.toThrow();
  });

  it("should not throw when dbOverride is provided", () => {
    const server = Fastify();
    const mockDb = {
      query: () => Promise.resolve({ rows: [] }),
    };

    expect(() => {
      registerOracleRoutes(server, undefined, mockDb);
    }).not.toThrow();
  });

  it("should not throw when both pool and dbOverride are provided", () => {
    const server = Fastify();
    const mockPool = {
      query: () => Promise.resolve({ rows: [] }),
    };
    const mockDb = {
      query: () => Promise.resolve({ rows: [] }),
    };

    expect(() => {
      registerOracleRoutes(server, mockPool as any, mockDb);
    }).not.toThrow();
  });
});
