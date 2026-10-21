/**
 * Oracle aggregator watchers and integrity tools: submissions, disputes, challenges, stuck markets, and validations.
 */

export {
  detectNewSubmissions,
  SubmissionWatcher,
  type DetectNewSubmissionsResult,
  type NewSubmissionAlert,
  type SubmissionRecord,
  type SubmissionWatcherOptions,
} from "./submission-watcher.js";

export {
  detectDisputeEscalations,
  DisputeEscalationWatcher,
  type DetectDisputeEscalationsResult,
  type DisputeEscalationAlert,
  type DisputeEscalationRecord,
  type DisputeEscalationWatcherOptions,
} from "./dispute-escalation-watcher.js";

export {
  ChallengeBot,
  startChallengeBot,
  type ChallengeBotOptions,
  type OracleSubmission,
  type ChallengeDecision,
  type ChallengeResult,
} from "./challenge-bot.js";

export { detectConflict, type ConflictReport } from "./conflict-detection.js";

export {
  detectStuckMarket,
  detectStuckMarkets,
  type StuckMarketAlert,
  type StuckMarketInput,
} from "./stuck-market.js";

export { ResolverKeyManager } from "./key-rotation.js";

export {
  loadCategoryResolverConfig,
  getResolversForCategory,
  isAuthorizedResolverForCategory,
  describeCategoryResolverConfig,
  type CategoryResolverConfig,
  type MarketCategory,
  MARKET_CATEGORIES,
} from "./category-resolvers.js";

export {
  validateSubmissionData,
  assertCanFinalize,
  createDefaultValidationConfig,
  createStrictValidationConfig,
  createBalancedValidationConfig,
  type SubmissionValidationResult,
  type SubmissionValidationConfig,
} from "./submission-validator.js";
