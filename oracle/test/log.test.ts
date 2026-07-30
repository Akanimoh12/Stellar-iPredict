import { describe, expect, it } from "vitest";
import { createLogger, parseLogLevel } from "../src/log.js";

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
