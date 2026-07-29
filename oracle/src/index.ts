import { startAggregator } from "./aggregator/index.js";

startAggregator().catch((error: unknown) => {
  console.error("[ipredict-oracle] fatal:", error);
  process.exit(1);
});
