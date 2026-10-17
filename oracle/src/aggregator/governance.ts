/**
 * Oracle aggregator governance re-exports: council config, voting, audits, and inactivity monitoring.
 */

export {
  loadCouncilConfig,
  isCouncilMember,
  describeCouncilConfig,
  hasQuorum,
  meetsThreshold,
  compareCouncilResolvers,
  COUNCIL_SIZE,
  COUNCIL_DEFAULT_THRESHOLD,
  type CouncilConfig,
  type CouncilResolverReport,
} from "../config/council.js";

export { CouncilVoteManager } from "./council-votes.js";

export {
  buildAuditRecord,
  collectCouncilAudit,
  exportCouncilAudit,
  toAuditCsv,
  toAuditJson,
  type AuditFormat,
  type CouncilAuditInput,
  type CouncilAuditRecord,
} from "./council-audit.js";

export {
  checkCouncilInactivity,
  checkCouncilInactivityFromDb,
  checkCouncilWindowExceeded,
  checkCouncilWindowExceededFromDb,
  type CouncilInactivityAlert,
  type CouncilWindowExceededAlert,
  type CouncilInactivityMonitorOptions,
  type EscalatedMarketRecord,
} from "./council-inactivity-monitor.js";
