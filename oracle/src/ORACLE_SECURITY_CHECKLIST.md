# Oracle Change Security Checklist

Copy this checklist into the PR description for any change under `oracle/`
(adapters, aggregator, submitter, config). It is a verified review control and deployment gate.

## Governance & Verification Cadence

- **Owner**: Security Lead & Oracle Maintainers Group (`security@drips.network`)
- **Review Cadence**:
  - **Pre-Merge / Pre-Release**: Mandatory review on every PR touching `oracle/`, `backend/src/api/oracle.ts`, or oracle database models.
  - **Weekly Audit**: Recurring audit and verification of production configuration, signing keys, and provider telemetry.

---

## 1. Authentication, Credentials & Keys

| Control | Status | Implementing Reference |
| :--- | :--- | :--- |
| **No Hardcoded Keys**: Production environments require explicitly provided `ORACLE_API_KEY` and reject hardcoded/fallback secrets | `[x] Verified` | `backend/src/api/oracle.ts`, `infra/docker-compose.production.yml` |
| **Cryptographic Signatures**: Ed25519 payload signatures verified on submitted resolutions before state transition | `[x] Verified` | `oracle/src/aggregator/submit.ts`, `oracle/src/lib/crypto.ts` |
| **Credential Redaction**: API keys and tokens stripped before persistence in `adapter_raw_payloads` or error logs | `[x] Verified` | `oracle/src/adapters/provenance.ts`, `backend/src/lib/log.ts` (#611) |
| **Signing Key Isolation**: `RESOLVER_KEY` provided strictly to `oracle-aggregator`; monitor and API containers run without signing access | `[x] Verified` | `infra/docker-compose.production.yml` |

## 2. Quorum, Council & Escalation

| Control | Status | Implementing Reference |
| :--- | :--- | :--- |
| **Multi-Key Council Quorum**: Minimum threshold of distinct council member signatures required for disputed finalization | `[x] Verified` | `oracle/src/aggregator/tally.ts`, `db/migrations/0008_council_votes.sql` |
| **Registered Oracle Providers**: Only active, whitelisted public keys permitted to submit outcomes | `[x] Verified` | `db/migrations/0014_oracle_providers.sql` |
| **Bounded Dispute Window**: Timelocks enforced for challenging submissions before on-chain execution | `[x] Verified` | `db/migrations/0009_oracle_disputes.sql` |
| **Inactivity Watchdog**: Oracle monitor alerts if council members remain inactive past threshold | `[x] Verified` | `oracle/src/monitor/run.ts` |

## 3. Idempotency & State Transition Safety

| Control | Status | Implementing Reference |
| :--- | :--- | :--- |
| **Re-execution Safety**: Double-submit and double-payout prevented via database uniqueness constraints | `[x] Verified` | `db/migrations/0006_oracle_submissions.sql` |
| **Idempotency Keys**: Bounded retry window using SHA-256 payload hashing | `[x] Verified` | `db/migrations/0015_idempotency_keys.sql` |
| **State Machine Enforcement**: Database trigger disallows illegal status transitions | `[x] Verified` | `db/migrations/0016_oracle_submission_transitions.sql` |
| **Bounded Storage**: Payload size caps enforce max storage limit per audit record | `[x] Verified` | `db/migrations/0028_adapter_raw_payloads.sql` |

## 4. Operational & Runbook Coverage

- [x] All new and existing alert types are indexed in `docs/RUNBOOK_INDEX.md`.
- [x] Alert payloads contain valid, navigable `runbook_url` references.
- [x] Incident response and council escalation runbook documented in `oracle/docs/COUNCIL_FLOW_RUNBOOK.md`.


## 5. Front-Running & Contract Integrity

- [ ] Front-running (#604): the change does not add any reward to the
      unchallenged submission path, publish a pending outcome before it is
      on-chain, or otherwise make "submit first" profitable. If it does,
      revisit the accepted-risk analysis in
      `docs/ORACLE_AND_BACKEND.md` § "Front-running analysis".
- [ ] Contract integrity (#610): if this targets a new contract or a redeployed
      one, its pinned hash is in `EXPECTED_WASM_HASHES`
      (`docs/DEPLOYMENT-GUIDE.md` § "Contract WASM integrity").
