/**
 * iPredict Backend API — entrypoint.
 *
 * Run: `npm run dev`
 */

import { loadSecrets, summariseSecretsLoad } from "@ipredict/shared";
import { loadConfig } from "./config/index.js";
import { startServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "0.0.0.0";

async function main(): Promise<void> {
  // Resolve the secrets source before anything reads process.env — the config
  // schemas, the Postgres pool and the Redis client all parse the environment
  // at import/first-use time. See docs/SECRETS.md; the summary is counts only,
  // never names or values.
  const secrets = await loadSecrets();
  console.info(`[ipredict-backend] secrets: ${summariseSecretsLoad(secrets)}`);

  // Validate configuration eagerly at startup so a misconfigured server fails
  // fast with a clear error. The `config` module itself is lazy (it must not
  // throw on import so test files that never touch the database can load);
  // this call surfaces config errors before the listener opens.
  loadConfig();

  await startServer({ port: PORT, host: HOST });
}

main().catch((err) => {
  console.error("[ipredict-backend] fatal:", err);
  process.exit(1);
});
