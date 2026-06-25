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
}

main().catch((err) => {
  console.error("[ipredict-backend] fatal:", err);
  process.exit(1);
});
