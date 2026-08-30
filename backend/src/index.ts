/**
 * iPredict Backend API — entrypoint.
 *
 * Run: `npm run dev`
 */

import { loadSecrets, summariseSecretsLoad } from "@ipredict/shared";
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

  await startServer({ port: PORT, host: HOST });
}

main().catch((err) => {
  console.error("[ipredict-backend] fatal:", err);
  process.exit(1);
});
