/**
 * Oracle Aggregator Public Module API
 *
 * This barrel module groups aggregator exports by domain concern:
 * - Runner: Aggregator loop and worker process lifecycle (`./runner.js`)
 * - Governance: Council config, votes, audits, and inactivity monitoring (`./governance.js`)
 * - Bonds: Bond minimum monitoring, reconciliations, and dashboards (`./bonds.js`)
 * - Settlement: Decision finalization, on-chain/off-chain submitters, notifications (`./settlement.js`)
 * - Watchers: Submission, dispute, conflict, and stuck market detection (`./watchers.js`)
 * - Metrics & Health: Observability, Prometheus metrics, and health checks (`./metrics.js`, `./health.js`)
 *
 * Consumers needing narrow imports can import directly from sub-modules (e.g. `./runner.js`, `./governance.js`)
 * to avoid pulling in heavy transitive dependencies like `@stellar/stellar-sdk` or `pg`.
 */

// ── Aggregator Runner & Lifecycle ───────────────────────────────────────────
export {
  runAggregator,
  startAggregator,
  createProductionDependencies,
  systemClock,
  ShutdownGracePeriodExceededError,
  type AggregatorMarket,
  type ProcessMarketContext,
  type AggregatorDependencies,
  type AggregatorClock,
  type RunAggregatorOptions,
} from "./runner.js";

// ── Governance & Council ────────────────────────────────────────────────────
export {
  loadCouncilConfig,
  isCouncilMember,
  describeCouncilConfig,
  hasQuorum,
  meetsThreshold,
  compareCouncilResolvers,
  COUNCIL_SIZE,
  COUNCIL_DEFAULT_THRESHOLD,
  CouncilVoteManager,
  buildAuditRecord,
  collectCouncilAudit,
  exportCouncilAudit,
  toAuditCsv,
  toAuditJson,
  checkCouncilInactivity,
  checkCouncilInactivityFromDb,
  checkCouncilWindowExceeded,
  checkCouncilWindowExceededFromDb,
  type CouncilConfig,
  type CouncilResolverReport,
  type AuditFormat,
  type CouncilAuditInput,
  type CouncilAuditRecord,
  type CouncilInactivityAlert,
  type CouncilWindowExceededAlert,
  type CouncilInactivityMonitorOptions,
  type EscalatedMarketRecord,
} from "./governance.js";

// ── Bonds & Reconciliation ──────────────────────────────────────────────────
export {
  checkBondMinimum,
  checkBondMinimumFromDb,
  getBondDashboardData,
  reconcileBonds,
  runBondReconciliation,
  recordSettlement,
  type BondAlert,
  type BondMonitorOptions,
  type OracleSubmissionRecord,
  type BondDashboardData,
  type BondRefundDiscrepancy,
  type BondReconciliationOptions,
  type BondReconciliationResult,
  type BondSettlement,
  type RecordSettlementInput,
  type TerminalSubmission,
} from "./bonds.js";

// ── Settlement, Submissions & Finalization ──────────────────────────────────
export {
  MarketAlreadyFinalizedError,
  finalizeMarketDecision,
  queryMarketState,
  queryRegisteredResolvers,
  resolveMarketOnChain,
  createStellarSubmitter,
  OffChainSubmitterService,
  notifyFinalized,
  createPostgresNotificationStore,
  failedWebhookNotificationsTableSql,
  computeTally,
  createPostgresSubmissionStore,
  SubmissionTracker,
  selectThresholdOutcome,
  type OnChainSubmitter,
  type ResolveMarketResult,
  type DataAdapter,
  type OffChainSubmitterOptions,
  type OffChainSubmitterStore,
  type SubmittedOutcomeResult,
  type FinalizeNotification,
  type FinalizeNotifierOptions,
  type MarketTally,
  type SubmissionStore,
} from "./settlement.js";

// ── Watchers, Integrity & Dispute Escalations ───────────────────────────────
export {
  detectConflict,
  detectStuckMarket,
  detectStuckMarkets,
  ResolverKeyManager,
  ChallengeBot,
  startChallengeBot,
  detectNewSubmissions,
  SubmissionWatcher,
  detectDisputeEscalations,
  DisputeEscalationWatcher,
  loadCategoryResolverConfig,
  getResolversForCategory,
  isAuthorizedResolverForCategory,
  describeCategoryResolverConfig,
  MARKET_CATEGORIES,
  validateSubmissionData,
  assertCanFinalize,
  createDefaultValidationConfig,
  createStrictValidationConfig,
  createBalancedValidationConfig,
  type ConflictReport,
  type StuckMarketAlert,
  type StuckMarketInput,
  type ChallengeBotOptions,
  type OracleSubmission,
  type ChallengeDecision,
  type ChallengeResult,
  type DetectNewSubmissionsResult,
  type NewSubmissionAlert,
  type SubmissionRecord,
  type SubmissionWatcherOptions,
  type DetectDisputeEscalationsResult,
  type DisputeEscalationAlert,
  type DisputeEscalationRecord,
  type DisputeEscalationWatcherOptions,
  type CategoryResolverConfig,
  type MarketCategory,
  type SubmissionValidationResult,
  type SubmissionValidationConfig,
} from "./watchers.js";

// ── Metrics & Health ────────────────────────────────────────────────────────
export {
  OracleMetricsCollector,
  OracleMetricsServer,
  ORACLE_METRICS_DEFAULT_PORT,
  collectOracleMetrics,
  loadOracleMetricsConfig,
  serializeOracleMetrics,
  startOracleMetrics,
  type OracleMetricsConfig,
  type OracleMetricsRuntime,
  type OracleMetricsSnapshot,
  type ResolutionLagSample,
} from "../metrics/index.js";

export {
  AggregatorMetrics,
  AggregatorMetricsServer,
  DEFAULT_LAG_BUCKETS_HOURS,
  ORACLE_RESOLUTION_LAG_H_METRIC,
  createPostgresResolutionMetricStore,
  type AggregatorMetricsServerOptions,
  type AggregatorMetricsSnapshot,
  type NamedMetric,
  type ResolutionLagEntry,
} from "./metrics.js";

export {
  AggregatorHealthServer,
  type AggregatorHealthServerOptions,
  type DependencyCheckResult,
  type ReadinessCheckResult,
} from "./health.js";
