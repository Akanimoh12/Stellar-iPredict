/**
 * The backend's log output uses the shared field names (issue #630).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { LOG_FIELDS } from "@ipredict/shared";
import {
  createLoggerOptions,
  formatLogLine,
  logSlowQuery,
  serializeLogError,
} from "./log.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLoggerOptions (Fastify/pino)", () => {
  it("writes the message under `message`, not pino's `msg`", () => {
    expect(createLoggerOptions({} as NodeJS.ProcessEnv).messageKey).toBe(LOG_FIELDS.message);
  });

  it("writes the level as a string label, not a number", () => {
    const options = createLoggerOptions({} as NodeJS.ProcessEnv);
    expect(options.formatters.level("warn")).toEqual({ level: "warn" });
  });

  it("writes an ISO timestamp under `timestamp` as a valid JSON fragment", () => {
    const fragment = createLoggerOptions({} as NodeJS.ProcessEnv).timestamp();
    const parsed = JSON.parse(`{${fragment.slice(1)}}`) as Record<string, string>;
    expect(Object.keys(parsed)).toEqual([LOG_FIELDS.timestamp]);
    expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
  });

  it("binds the backend service name", () => {
    expect(createLoggerOptions({} as NodeJS.ProcessEnv).base.service).toBe("backend");
  });

  it("serialises errors under `error`", () => {
    const serialised = serializeLogError(new Error("boom")) as Record<string, unknown>;
    expect(serialised.message).toBe("boom");
    expect(typeof serialised.stack).toBe("string");
    expect(serializeLogError("plain")).toBe("plain");
  });
});

describe("structured console lines", () => {
  it("formatLogLine carries timestamp, level, message and service", () => {
    const record = JSON.parse(formatLogLine("error", "thing failed", { attempt: 2 })) as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({
      level: "error",
      message: "thing failed",
      service: "backend",
      attempt: 2,
    });
    expect(typeof record.timestamp).toBe("string");
    expect(record).not.toHaveProperty("msg");
  });

  it("logSlowQuery writes a line the slow-query analyzer recognises by `message`", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    logSlowQuery({ query: "SELECT 1", durationMs: 250.04, thresholdMs: 200 });

    const record = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(record).toMatchObject({
      level: "warn",
      message: "slow db query",
      query: "SELECT 1",
      durationMs: 250,
      thresholdMs: 200,
    });
    expect(record).not.toHaveProperty("msg");
  });
});
