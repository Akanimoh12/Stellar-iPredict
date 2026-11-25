/**
 * The backend's one startup sequence — issue #632.
 *
 * Initialisation used to be spread across import-time side effects, so the
 * order in which modules were loaded decided what they saw. Now every step is
 * an explicit call, in the order below. Importing any module in `src/` does
 * nothing on its own; only {@link startBackend} starts the process.
 *
 * The order matters and is fixed:
 *
 * 1. **secrets** — resolve `*_FILE` / vault references into `process.env`.
 *    Must run before anything reads the environment.
 * 2. **config** — validate the environment. A `ConfigError` stops startup here,
 *    before any socket is opened.
 * 3. **database-driver** — set process-wide `pg` type parsers.
 * 4. **server** — build the Fastify app, connect, and start listening.
 *
 * Failures are thrown, not exited. The entrypoint (`index.ts`) reports them
 * and exits, so this module can be tested without killing the test runner.
 */

import { loadSecrets, summariseSecretsLoad } from "@ipredict/shared";
import { loadConfig } from "./config/index.js";
import { configurePgTypeParsers } from "./db/pool.js";
import { startServer, type ServerConfig } from "./server.js";

/** The steps in the order they run. Exported so tests can assert the order. */
export const STARTUP_STEPS = ["secrets", "config", "database-driver", "server"] as const;
export type StartupStep = (typeof STARTUP_STEPS)[number];

/** Every side effect {@link startBackend} performs, injectable for tests. */
export interface StartupDependencies {
  loadSecrets: typeof loadSecrets;
  summariseSecrets: typeof summariseSecretsLoad;
  loadConfig: typeof loadConfig;
  configureDatabaseDriver: typeof configurePgTypeParsers;
  startServer: (config: ServerConfig) => Promise<unknown>;
  log: (line: string) => void;
}

const defaultDependencies: StartupDependencies = {
  loadSecrets,
  summariseSecrets: summariseSecretsLoad,
  loadConfig,
  configureDatabaseDriver: configurePgTypeParsers,
  startServer,
  log: (line) => console.info(line),
};

/**
 * Runs the startup sequence and resolves once the server is listening.
 *
 * @throws the first failing step's error; later steps do not run.
 */
export async function startBackend(
  server: ServerConfig,
  dependencies: StartupDependencies = defaultDependencies,
): Promise<void> {
  // 1. secrets
  const secrets = await dependencies.loadSecrets();
  dependencies.log(`[ipredict-backend] secrets: ${dependencies.summariseSecrets(secrets)}`);

  // 2. config — throws ConfigError on invalid input; nothing below runs.
  dependencies.loadConfig();

  // 3. database driver
  dependencies.configureDatabaseDriver();

  // 4. server
  await dependencies.startServer(server);
}
