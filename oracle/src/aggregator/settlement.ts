/**
 * Oracle aggregator settlement re-exports: on-chain and off-chain finalization and notifications.
 */

export {
  MarketAlreadyFinalizedError,
  finalizeMarketDecision,
  queryMarketState,
  queryRegisteredResolvers,
} from "./market-finalizer.js";

export {
  resolveMarketOnChain,
  createStellarSubmitter,
  type OnChainSubmitter,
  type ResolveMarketResult,
} from "../submitter/resolveMarket.js";

export {
  OffChainSubmitterService,
  type DataAdapter,
  type OffChainSubmitterOptions,
  type OffChainSubmitterStore,
  type SubmittedOutcomeResult,
} from "../submitter/offChainSubmitter.js";

export {
  notifyFinalized,
  createPostgresNotificationStore,
  failedWebhookNotificationsTableSql,
  type FinalizeNotification,
  type FinalizeNotifierOptions,
} from "./finalize-notifier.js";

export {
  computeTally,
  createPostgresSubmissionStore,
  SubmissionTracker,
  type MarketTally,
  type SubmissionStore,
} from "./tally.js";

export { selectThresholdOutcome } from "./threshold.js";
