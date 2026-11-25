/** @deprecated Use `npm run maintenance -- bet-counts`.
 * Keep this executable for older cron jobs and runbooks.
 */
import { runMaintenanceCli } from "./maintenance.js";

runMaintenanceCli(["bet-counts", ...process.argv.slice(2)]).catch((error: unknown) => {
  console.error("bet_count backfill failed", error);
  process.exitCode = 1;
});
