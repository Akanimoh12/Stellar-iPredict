import { startServer } from "./server.js";
import { config } from "./config/index.js";

const PORT = config.PORT;
const HOST = process.env.HOST ?? "0.0.0.0";

async function main(): Promise<void> {
  await startServer({ port: PORT, host: HOST, corsOrigins: config.CORS_ORIGINS });
}

main().catch((err) => {
  console.error("[ipredict-backend] fatal:", err);
  process.exit(1);
});
