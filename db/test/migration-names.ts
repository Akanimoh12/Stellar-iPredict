// Applied migrations are identified by full filename. Freeze historical collisions
// exactly; renaming them would replay DDL on deployed databases. New collisions fail.
export const LEGACY_MIGRATION_GROUPS: Record<string, readonly string[]> = {
  "0015": [
    "0015_idempotency_keys.sql",
    "0015_oracle_disputes_total_bond_generated.sql",
    "0015_oracle_updated_at.sql"
  ],
  "0014": [
    "0014_markets_active_partial_index.sql",
    "0014_oracle_dispute_bond_constraints.sql",
    "0014_oracle_providers.sql"
  ],
  "0013": [
    "0013_events_archival.sql",
    "0013_stats_indexes.sql"
  ],
  "0011": [
    "0011_create_token_balances.sql",
    "0011_extend_oracle_submissions.sql"
  ],
  "0022": [
    "0022_oracle_resolution_lag.sql",
    "0022_oracle_submissions_request_id.sql"
  ]
};
