import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createLogger, parseLogLevel, createCorrelationId, isValidRequestId } from "../src/log.js";

describe("parseLogLevel", () => {
  it("normalizes supported levels and falls back to info", () => {
    expect(parseLogLevel("DEBUG")).toBe("debug");
    expect(parseLogLevel("warn")).toBe("warn");
    expect(parseLogLevel("something-else")).toBe("info");
  });
});

describe("createLogger", () => {
  it("emits JSON records with timestamps and filters below the configured level", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "warn",
      timestamp: () => "2026-06-25T12:00:00.000Z",
      sink: (line) => lines.push(line),
      bindings: { component: "oracle-aggregator" },
    });

    logger.info("hidden", { ignored: true });
    logger.error("boom", { error: new Error("kaboom"), iteration: 2 });

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(record).toMatchObject({
      timestamp: "2026-06-25T12:00:00.000Z",
      level: "error",
      message: "boom",
      component: "oracle-aggregator",
      iteration: 2,
    });
    expect(record.error).toMatchObject({
      name: "Error",
      message: "kaboom",
    });
  });

  it("supports child bindings", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      timestamp: () => "2026-06-25T12:01:00.000Z",
      sink: (line) => lines.push(line),
    });

    logger.child({ component: "oracle-aggregator", job: "poller" }).debug("child message", {
      marketsChecked: 4,
    });

    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(record).toMatchObject({
      timestamp: "2026-06-25T12:01:00.000Z",
      level: "debug",
      message: "child message",
      component: "oracle-aggregator",
      job: "poller",
      marketsChecked: 4,
    });
  });
});

describe("correlation ids (#467)", () => {
  it("mints UUIDs the backend's request id rule accepts", async () => {
    const { isValidRequestId: backendIsValid } = await import("../../backend/src/lib/log.js");
    for (let i = 0; i < 20; i++) {
      const id = createCorrelationId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(backendIsValid(id)).toBe(true);
    }
    expect(createCorrelationId()).not.toBe(createCorrelationId());
  });

  // The rule exists three times — backend, oracle and the CHECK constraint in
  // migration 0022 — because each side of the process boundary enforces it.
  // This pins all three to the same verdicts.
  it("validates exactly like the backend and the database", async () => {
    const { isValidRequestId: backendIsValid } = await import("../../backend/src/lib/log.js");
    const migration = readFileSync(
      new URL("../../db/migrations/0022_oracle_submissions_request_id.sql", import.meta.url),
      "utf8",
    );
    const check = /request_id ~ '([^']+)'/.exec(migration)?.[1];
    expect(check).toBeDefined();
    const dbAccepts = (value: string) => new RegExp(check!).test(value);

    const samples = [
      "3f2b8c1e-0000-4000-8000-000000000001",
      "req-1",
      "trace.id:42_x",
      "a".repeat(128),
      "a".repeat(129),
      "",
      "has space",
      "semi;colon",
      "new\nline",
      "ünicode",
    ];
    for (const sample of samples) {
      expect(isValidRequestId(sample), sample).toBe(backendIsValid(sample));
      expect(dbAccepts(sample), sample).toBe(backendIsValid(sample));
    }
    expect(isValidRequestId(undefined)).toBe(false);
    expect(isValidRequestId(42)).toBe(false);
  });
});
