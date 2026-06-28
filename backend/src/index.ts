import { startServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "0.0.0.0";
import { config } from "./config/index.js";

const PORT = config.PORT;

async function main(): Promise<void> {
  await startServer({ port: PORT, host: HOST });
}

main().catch((err) => {
  console.error("[ipredict-backend] fatal:", err);
  process.exit(1);
});
