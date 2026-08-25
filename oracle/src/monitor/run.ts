import { startMonitor } from "./index.js";

startMonitor().catch((error: unknown) => {
  console.error("[ipredict-oracle-monitor] fatal:", error);
  process.exit(1);
});
