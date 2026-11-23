/**
 * Tests for the explicit startup sequence (issue #632).
 */

import { describe, expect, it } from "vitest";
import { ConfigError } from "@ipredict/shared";
import { STARTUP_STEPS, startBackend, type StartupDependencies } from "./startup.js";

/** Builds dependencies that record the order of calls. */
function recordingDeps(overrides: Partial<StartupDependencies> = {}) {
  const calls: string[] = [];
  const deps: StartupDependencies = {
    loadSecrets: async () => {
      calls.push("secrets");
      return { backend: "env", counts: {} } as never;
    },
    summariseSecrets: () => "backend=env",
    loadConfig: () => {
      calls.push("config");
      return {} as never;
    },
    configureDatabaseDriver: () => {
      calls.push("database-driver");
    },
    startServer: async () => {
      calls.push("server");
      return {};
    },
    log: () => undefined,
    ...overrides,
  };
  return { calls, deps };
}

describe("startBackend", () => {
  it("documents the four steps in their fixed order", () => {
    expect([...STARTUP_STEPS]).toEqual(["secrets", "config", "database-driver", "server"]);
  });

  it("runs every step in the documented order", async () => {
    const { calls, deps } = recordingDeps();
    await startBackend({ port: 4000, host: "127.0.0.1" }, deps);
    expect(calls).toEqual([...STARTUP_STEPS]);
  });

  it("stops before the server when configuration is invalid", async () => {
    const { calls, deps } = recordingDeps({
      loadConfig: () => {
        calls.push("config");
        throw new ConfigError("ipredict-backend", [{ path: ["DATABASE_URL"], message: "required" }]);
      },
    });

    await expect(startBackend({ port: 4000, host: "127.0.0.1" }, deps)).rejects.toBeInstanceOf(
      ConfigError,
    );
    expect(calls).toEqual(["secrets", "config"]);
  });

  it("logs the secrets summary, never the secret values", async () => {
    const lines: string[] = [];
    const { deps } = recordingDeps({
      summariseSecrets: () => "backend=file count=2",
      log: (line) => lines.push(line),
    });
    await startBackend({ port: 4000, host: "127.0.0.1" }, deps);
    expect(lines).toEqual(["[ipredict-backend] secrets: backend=file count=2"]);
  });
});
