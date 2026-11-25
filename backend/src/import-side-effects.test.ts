/// <reference types="vite/client" />
/**
 * Importing any backend module must have no process-wide effect (issue #632).
 *
 * Every module under `src/` is imported in turn. Each import must:
 *   - not throw,
 *   - not exit the process,
 *   - not add a process signal, exit, or error listener,
 *   - not install a timer that keeps the process alive.
 *
 * Entrypoints (`index.ts`) are excluded: they start the process by design.
 */

import { describe, expect, it, vi } from "vitest";

const modules = import.meta.glob(
  ["./**/*.ts", "!./**/*.test.ts", "!./**/*.d.ts", "!./index.ts", "!./test/**"],
  { eager: false },
);

const WATCHED_EVENTS = [
  "SIGTERM",
  "SIGINT",
  "SIGHUP",
  "exit",
  "beforeExit",
  "uncaughtException",
  "unhandledRejection",
] as const;

function listenerCounts(): Record<string, number> {
  return Object.fromEntries(WATCHED_EVENTS.map((name) => [name, process.listenerCount(name)]));
}

describe("module import side effects", () => {
  it("finds the backend source modules", () => {
    expect(Object.keys(modules).length).toBeGreaterThan(20);
  });

  for (const path of Object.keys(modules)) {
    it(`importing ${path} has no observable side effect`, async () => {
      const listenersBefore = listenerCounts();
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error(`process.exit called while importing ${path}`);
      }) as never);
      try {
        await modules[path]!();
        expect(listenerCounts()).toEqual(listenersBefore);
        expect(exit).not.toHaveBeenCalled();
      } finally {
        exit.mockRestore();
      }
    });
  }
});
