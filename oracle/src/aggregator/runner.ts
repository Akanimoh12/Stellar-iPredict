export { createProductionDependencies } from "./runner-dependencies.js";
export type {
  AggregatorDependencies,
  AggregatorMarket,
  ProcessMarketContext,
} from "./runner-dependencies.js";
export {
  runAggregator,
  systemClock,
  ShutdownGracePeriodExceededError,
} from "./runner-loop.js";
export type { AggregatorClock, RunAggregatorOptions } from "./runner-loop.js";
export { startAggregator } from "./runner-lifecycle.js";
