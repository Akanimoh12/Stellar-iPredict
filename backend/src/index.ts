/**
 * iPredict Backend API — entrypoint.
 *
 * This is an intentionally minimal scaffold. The real server bootstrap,
 * routes, db/cache wiring, and config validation are tracked as separate
 * issues (see GitHub issues labelled `area:backend`).
 *
 * Run: `npm run dev`
 */

const PORT = Number(process.env.PORT ?? 4000);

async function main(): Promise<void> {
  // TODO(#scaffold): replace with the Fastify server from `src/server.ts`
  // once the "Bootstrap Fastify server" issue is implemented.
  console.log(`[ipredict-backend] scaffold up — API server not yet implemented`);
  console.log(`[ipredict-backend] intended port: ${PORT}`);
  console.log(`[ipredict-backend] pick an issue labelled "area:backend" to start`);
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
