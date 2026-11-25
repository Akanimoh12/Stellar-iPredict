import { runMaintenanceCli } from "./maintenance.js";

runMaintenanceCli().catch((error: unknown) => {
  console.error("indexer maintenance failed", error);
  process.exitCode = 1;
});
