# Stuck Market Runbook

**Start here when `oracle.monitor.market_stuck` fires.** This is the
on-call procedure: what the alert means, how to find out why a market is
stuck, how to fix each cause, who is allowed to, and what each fix does to
escrowed bonds and bettors' stakes.

Everything below was checked against the code on 2026-09-24:
`contracts/prediction_market/src/lib.rs`, `oracle/src/aggregator/`,
`oracle/src/monitor/` and `infra/docker-compose.production.yml`. Where
the older runbooks say something different, this one is correct. See
[Known errors in the older runbooks](#known-errors-in-the-older-runbooks).

- [Which runbook covers what](#which-runbook-covers-what)
- [1. The alert](#1-the-alert)
- [2. Triage (first 10 minutes)](#2-triage-first-10-minutes)
- [3. Diagnose](#3-diagnose)
- [4. Causes and remediation](#4-causes-and-remediation)
- [5. Manual on-chain intervention](#5-manual-on-chain-intervention)
- [6. Bond and stake consequences](#6-bond-and-stake-consequences)
- [7. Authorization](#7-authorization)
- [8. Verify and close](#8-verify-and-close)
- [Known errors in the older runbooks](#known-errors-in-the-older-runbooks)

## Which runbook covers what

| Runbook | Use it for |
|---|---|
| **This file** | Responding to a stuck market, from the alert to resolution |
| [`COUNCIL_RUNBOOK.md`](./COUNCIL_RUNBOOK.md) | Council members casting votes; severity levels, escalation path and user communication ([Incident Response](./COUNCIL_RUNBOOK.md#incident-response)) |
| [`../src/OPTIMISTIC_ORACLE_RUNBOOK.md`](../src/OPTIMISTIC_ORACLE_RUNBOOK.md) | The bonded optimistic oracle: `submit_outcome`, `challenge`, `finalize_outcome`, `resolve_challenge` |
| [`../src/aggregator/COUNCIL_FLOW_RUNBOOK.md`](../src/aggregator/COUNCIL_FLOW_RUNBOOK.md) | Exercising the council flow by hand on a local or testnet contract (QA, not production) |
| [`../../docs/ORACLE_RUNBOOK.md`](../../docs/ORACLE_RUNBOOK.md) | A merged overview of the council and optimistic runbooks |

For severity, paging and user communication, follow the
[Incident Response](./COUNCIL_RUNBOOK.md#incident-response) section of the
council runbook. This file covers the technical procedure.

## 1. The alert

`oracle-monitor` checks Postgres every `MONITOR_INTERVAL_MS`. It flags every
market whose row in `markets` is still `resolved = FALSE` and
`cancelled = FALSE` more than `STUCK_MARKET_HOURS` (default 6) after
`end_time`. It logs a `warn` line and, if `ALERT_WEBHOOK_URL` is set, POSTs:

```json
{"type":"oracle.monitor.market_stuck","marketId":"42","endTime":1790000000,"hoursPastExpiry":7.4,"stuck":true}
```

Things to know before you start:

- **The alert reads the database, not the chain.** `markets.resolved` and
  `markets.cancelled` are written by the indexer from contract events. A
  market can be resolved on-chain and still alert if the indexer is behind.
- **It fires on every monitor cycle** until the row changes, so repeats of
  the same `marketId` are one incident, not many.
- **Nothing on-chain unsticks a market automatically.** The contract has no
  timeout, auto-cancel or expiry refund. A market with no oracle submission
  stays open until someone calls `resolve_market` or `cancel_market`.
- **The aggregator does not page anyone.** After five consecutive failures on
  a market it only logs (`consecutiveFailures` ≥ 5 on "market processing
  failed"); production wires no alert sender. This alert is usually the
  first signal you get.

## 2. Triage (first 10 minutes)

1. **Is it one market or many?** Many markets alerting together points to
   the aggregator, its configuration, the RPC node or the indexer (causes
   [C1](#c1-aggregator-down-or-not-polling), [C2](#c2-aggregator-not-configured-for-finalization),
   [C3](#c3-resolver-key-not-authorized-on-chain) and
   [C8](#c8-resolved-or-cancelled-on-chain-db-not-updated)).
   A single market points to that market's votes or oracle state.
2. **Is money at risk?** Check whether the market holds stakes (`total_yes`,
   `total_no` in [§3.3](#33-database-state)) and whether an oracle bond is
   escrowed ([§3.4](#34-on-chain-state)). A stuck market with a non-zero pool
   is **SEV1** under the council runbook's severity table. Open an incident
   and name an incident commander before touching anything on-chain.
3. **Do not edit `markets`, `council_votes` or `oracle_submissions` by hand
   to clear the alert.** That hides the market without resolving it. Bettors
   still cannot claim or be refunded, and bonds stay escrowed.

## 3. Diagnose

Work through these in order. Each step either finds the cause or narrows it.

### 3.1 Is the aggregator alive and polling?

Services log through Fluent Bit (see `infra/README.md`), so read the
collected stream rather than `docker compose logs`. Each service's JSON log
line is stored escaped inside the collector's `log` field, which is why the
patterns below match `\"`.

```bash
cd infra
docker compose -f docker-compose.production.yml ps oracle-aggregator
LOGS="docker compose -f docker-compose.production.yml exec -T log-collector cat /var/log/ipredict/containers.log"
$LOGS | grep oracle-aggregator | grep -F 'poll iteration complete' | tail -3
```

A healthy aggregator logs `poll iteration complete` about every
`POLL_INTERVAL_MS` (default 5 s), with `marketsChecked` and `backlogDepth`.
If those lines are missing, go to [C1](#c1-aggregator-down-or-not-polling).
The readiness probe (`/health/ready` on `HEALTH_PORT`) also
reports whether Postgres and the RPC node are reachable. On the metrics
endpoint, `oracle_aggregator_available` and
`oracle_aggregator_consecutive_poll_failures` show whether whole polls are
failing.

### 3.2 What happened the last time the aggregator processed this market?

The aggregator logs every processing attempt under one **correlation id**
(`correlationId`, a UUID; see #467). Find the latest attempt for the market,
then pull everything logged under its id:

```bash
$LOGS | grep -F 'marketId\":\"42\"' | tail -5   # recent attempts for market 42
$LOGS | grep -F '<correlationId from above>'    # the whole story of one attempt
```

If the market has no log lines at all, the aggregator is not picking it up.
Check that the `markets` row is expired, unresolved and not cancelled
([§3.3](#33-database-state)).

Match the last line of the attempt against this table:

| Last line of the attempt | Meaning | Go to |
|---|---|---|
| `aggregator is not configured for finalization, skipping` | `MARKET_CONTRACT_ID` or `RESOLVER_KEY` is unset; the `hasMarketContractId` and `hasResolverKey` fields say which | [C2](#c2-aggregator-not-configured-for-finalization) |
| `threshold not met, market left unresolved` | Not enough council votes for one outcome (`yesVotes`, `noVotes`, `threshold`) | [C4](#c4-council-threshold-not-met) |
| `market processing failed` with `error.message` containing `Error(Contract, #16)` | The resolver key is not an authorized resolver on the contract | [C3](#c3-resolver-key-not-authorized-on-chain) |
| `market processing failed` with an RPC or network error | RPC trouble; `consecutiveFailures` counts consecutive failures | [C5](#c5-rpc-or-network-failures) |
| `market processing failed` with `Market 42 already finalized` | Resolved on-chain, but the decision row could not be written | [C7](#c7-already-finalized-error-after-an-on-chain-resolution) |
| `market is already resolved on-chain, skipping` or `market is cancelled on-chain, skipping` | The chain is done; the database has not caught up | [C8](#c8-resolved-or-cancelled-on-chain-db-not-updated) |
| `market finalized` | The aggregator resolved it; the alert should clear once the indexer records it | [C8](#c8-resolved-or-cancelled-on-chain-db-not-updated) |

If a line carries `originRequestId`, someone submitted an outcome for this
market over the backend's `POST /api/oracle/submit`. Search the backend
logs for that id (`reqId`) to see who submitted and when. The same id is in
`oracle_submissions.request_id`.

### 3.3 Database state

```sql
-- The market as the indexer last recorded it
SELECT id, end_time, to_timestamp(end_time) AS ends_at, resolved, cancelled,
       outcome, total_yes, total_no, bet_count
  FROM markets WHERE id = 42;

-- Council votes the aggregator tallies (COUNCIL_THRESHOLD of COUNCIL_SIZE)
SELECT outcome, count(*) FROM council_votes WHERE market_id = 42 GROUP BY outcome;

-- Oracle submission or finalized decision (at most one row per market)
SELECT status, submitter, outcome, bond_amount, submitted_at, decision,
       tx_hash, finalized_at, request_id
  FROM oracle_submissions WHERE market_id = 42;
```

### 3.4 On-chain state

Read-only views are simulated and cost nothing. Use any configured
`stellar` identity as the source:

```bash
export NETWORK=mainnet   # or testnet
stellar contract invoke --network "$NETWORK" --source-account ops-readonly \
  --id "$MARKET_CONTRACT_ID" -- get_market --market_id 42
stellar contract invoke --network "$NETWORK" --source-account ops-readonly \
  --id "$MARKET_CONTRACT_ID" -- get_oracle_submission --market_id 42
```

- `get_market` gives the chain's `resolved`, `cancelled`, `outcome`,
  `end_time`, `total_yes` and `total_no`.
- `get_oracle_submission` either fails with `Error(Contract, #22)`
  (`SubmissionNotFound`: no submission, so no bond is escrowed) or returns
  the submission: `state` (`Submitted` / `Escalated` / `Finalized`),
  `submitter`, `bond`, `challenge_deadline`, `challenger`,
  `challenger_bond`, `council_deadline`.

## 4. Causes and remediation

Each cause lists what you see, the fix, who may apply it, and what happens
to bonds. For the on-chain calls, see [§5](#5-manual-on-chain-intervention).

### C1. Aggregator down or not polling

- **You see:** no `poll iteration complete` lines, the container is
  restarting, or `/health/ready` is failing. Usually many markets alert at
  once.
- **Fix:** read the aggregator's last error lines, fix the cause (Postgres
  or RPC unreachable, a crash), then run
  `docker compose -f docker-compose.production.yml up -d oracle-aggregator`.
  Once polling resumes, the backlog is worked through oldest first.
- **Who:** the aggregator operator (infrastructure access).
- **Bonds:** none affected.

### C2. Aggregator not configured for finalization

- **You see:** `aggregator is not configured for finalization, skipping` on
  every market.
- **Fix:** set the missing variable in `infra/.env` and restart the
  aggregator. `MARKET_CONTRACT_ID`, `NETWORK_PASSPHRASE` and `RESOLVER_KEY`
  (or `RESOLVER_KEY_FILE`) must all reach `oracle-aggregator`.
- **Who:** the aggregator operator. Handling `RESOLVER_KEY` follows the
  secret-handling rules in `infra/README.md`.
- **Bonds:** none affected.

### C3. Resolver key not authorized on-chain

- **You see:** `market processing failed` with `Error(Contract, #16)`
  (`NotResolver`). The contract only accepts `resolve_market` from the
  admin or a registered resolver.
- **Check:** `stellar contract invoke ... -- is_resolver --resolver <RESOLVER_KEY's public key>`.
- **Fix:** the contract admin registers the key:
  `stellar contract invoke --network "$NETWORK" --source-account <admin> --id "$MARKET_CONTRACT_ID" -- add_resolver --admin <admin address> --resolver <resolver public key>`.
  After a resolver key rotation, remove the old key with `remove_resolver`.
  Rotating the key off-chain does not change the on-chain list.
- **Who:** contract admin only (`add_resolver` and `remove_resolver` check
  `require_admin`).
- **Bonds:** none affected.

### C4. Council threshold not met

- **You see:** `threshold not met, market left unresolved`, with vote
  counts short of `COUNCIL_THRESHOLD` (default 4 of 7), or split so neither
  side reaches it.
- **Fix:** council members who have not voted cast a vote. Each member uses
  their own key:
  ```bash
  COUNCIL_MEMBER_SECRET=S... DATABASE_URL=... COUNCIL_MEMBERS=... \
    npm --prefix oracle run submit -- --market 42 --outcome yes
  ```
  The CLI takes only `--market` and `--outcome`, and refuses keys that are
  not in `COUNCIL_MEMBERS`. It records the vote in `council_votes`. The
  aggregator finalizes on its next poll once one outcome reaches the
  threshold. A member may change their vote by running it again. If the
  council cannot agree (the market was ambiguous or its source never
  reported), use a manual path: force-resolve
  ([§5.1](#51-force-resolve-resolve_market)) or cancel
  ([§5.2](#52-cancel-cancel_market)).
- **Who:** council members, and only for their own vote.
- **Bonds:** none affected by voting.

### C5. RPC or network failures

- **You see:** `market processing failed` with a network, timeout or RPC
  error, `consecutiveFailures` climbing, and possibly other markets failing
  the same way.
- **Fix:** check the RPC endpoint (`SOROBAN_RPC_URL`) and its status. The
  aggregator retries on every poll, and a failure on one market does not
  hold up the others. No action on the market is needed once the RPC node
  recovers. If the failures are confined to one market and look like a
  contract error (`Error(Contract, #n)`), look up the code in
  [§5.5](#55-contract-error-codes).
- **Who:** the aggregator operator.
- **Bonds:** none affected.

### C6. An optimistic-oracle submission is open

- **You see:** `get_oracle_submission` returns `state: Submitted` or
  `Escalated`, and an `oracle_submissions` row with `status` `submitted` or
  `escalated`.
- **`Submitted`, challenge window still open** (`now < challenge_deadline`,
  24 h after submission): working as designed. Wait.
- **`Submitted`, window elapsed:** anyone can call `finalize_outcome`
  ([§5.3](#53-finalize-an-unchallenged-submission-finalize_outcome)). It
  returns the submitter's bond and resolves the market to the submitted
  outcome.
- **`Escalated`:** the market waits for a council ruling, and nothing on-chain
  enforces the 72 h `council_deadline`. The admin or a resolver calls
  `resolve_challenge` with the council's ruling
  ([§5.4](#54-rule-on-a-dispute-resolve_challenge)).
  `oracle.monitor.council_inactive` and
  `oracle.monitor.council_window_exceeded` usually fire first.
- **Who and bonds:** see §5.3 and §5.4.

### C7. "Already finalized" error after an on-chain resolution

- **You see:** `market processing failed` with `Market 42 already
  finalized`, and an `oracle_submissions` row for the market (usually a
  provider's submission, which has `request_id` set).
- **Meaning:** the aggregator's `resolve_market` transaction succeeded
  on-chain. Its decision could not be written because `oracle_submissions`
  allows one row per market and a submission already holds it. This is a
  known limitation of combining the council and optimistic paths on one
  market. The market **is resolved**, and bettors can claim.
- **Fix:** confirm with `get_market` that `resolved: true`. The alert clears
  when the indexer records it. **Any escalated bond is still in escrow:**
  resolving the market does not settle the submission. Follow C6 to release
  it.
- **Who:** the aggregator operator, plus C6's parties for the bonds.

### C8. Resolved or cancelled on-chain, DB not updated

- **You see:** `get_market` shows `resolved: true` or `cancelled: true`,
  but `markets` does not. The aggregator logs `already resolved on-chain,
  skipping` or `cancelled on-chain, skipping`, or it logged `market
  finalized` earlier.
- **Why:** the indexer only learns of a resolution from contract events,
  and the contract emits them for just one path:
  - **Via the optimistic oracle** (`finalize_outcome`, `resolve_challenge`):
    these emit `oracle/finalized`, which the indexer applies. If `markets`
    is still behind, the indexer is lagging. See
    [`docs/INDEXER_RUNBOOK.md`](../../docs/INDEXER_RUNBOOK.md).
  - **Via `resolve_market` or `cancel_market`,** which includes every
    market the aggregator finalizes: **these emit no event**, so the
    indexer never updates `markets`. The alert for the market keeps firing,
    and the aggregator keeps re-checking it on each poll. This is a known
    gap between the contract and the indexer, not an operator error.
- **Fix:** the chain is the source of truth, and bettors can already claim
  or refund. For the event-less path, the only way to bring `markets` in
  line today is a data fix that copies `resolved`, `outcome` or
  `cancelled` from `get_market`. Treat it as a reviewed production change:
  record it in the incident, and only apply it after confirming the chain.
  Never change `markets` to silence an alert for a market that is not
  closed on-chain.
- **Who:** the indexer operator, with the incident commander's approval for
  a data fix.
- **Bonds:** none affected.

## 5. Manual on-chain intervention

Only use these paths when the automated ones have failed (the council cannot
agree, or a dispute has run past its window). They move funds or fix an
outcome permanently: **none of them can be undone.** Get the approvals in
[§7](#7-authorization) first, and record who approved it and why in the
incident.

Every call is made through `stellar contract invoke --network "$NETWORK"
--source-account <identity> --id "$MARKET_CONTRACT_ID" -- <function> ...`.
The source account signs and must be the address passed as
`--caller`/`--admin`.

### 5.1 Force-resolve: `resolve_market`

```bash
stellar contract invoke --network "$NETWORK" --source-account <admin-or-resolver> \
  --id "$MARKET_CONTRACT_ID" -- resolve_market \
  --caller <admin-or-resolver address> --market_id 42 --outcome true
```

- **Authorized:** the admin or any registered resolver.
- **Requires:** market expired, not resolved, not cancelled.
- **Effect:** sets the outcome. Bettors on the winning side can `claim`. If
  nobody bet on the winning side, the whole pool goes to protocol fees.
- **Does not touch the oracle submission.** See [§6](#6-bond-and-stake-consequences).
- **Emits no event,** so the indexer does not record the resolution; see
  [C8](#c8-resolved-or-cancelled-on-chain-db-not-updated).

### 5.2 Cancel: `cancel_market`

```bash
stellar contract invoke --network "$NETWORK" --source-account <admin> \
  --id "$MARKET_CONTRACT_ID" -- cancel_market --admin <admin address> --market_id 42
```

- **Authorized:** the contract admin only. A resolver cannot cancel.
- **Requires:** not resolved, not cancelled. There is no time restriction.
- **Effect:** marks the market cancelled. Nobody is refunded automatically:
  **each bettor must call `cancel_refund` themselves**. The frontend exposes
  it, and it returns their full stake including fees. The call also deducts
  the pool's estimated 2 % fees from the contract's accumulated fees
  (floored at zero), which can draw on fees earned elsewhere.
- **Does not touch the oracle submission.** See [§6](#6-bond-and-stake-consequences).
- **Emits no event,** so the indexer does not record the cancellation; see
  [C8](#c8-resolved-or-cancelled-on-chain-db-not-updated).

Cancel, rather than force-resolve, when the correct outcome cannot be
determined (the source never reported, or the market was ambiguous).

### 5.3 Finalize an unchallenged submission: `finalize_outcome`

```bash
stellar contract invoke --network "$NETWORK" --source-account <any funded account> \
  --id "$MARKET_CONTRACT_ID" -- finalize_outcome --market_id 42
```

- **Authorized:** anyone, once `challenge_deadline` has passed and the
  submission is `Submitted`.
- **Effect:** returns the submitter's bond in full. If the market is still
  open, it resolves to the submitted outcome. If it was already resolved or
  cancelled, it only releases the bond.

### 5.4 Rule on a dispute: `resolve_challenge`

```bash
stellar contract invoke --network "$NETWORK" --source-account <admin-or-resolver> \
  --id "$MARKET_CONTRACT_ID" -- resolve_challenge \
  --caller <admin-or-resolver address> --market_id 42 --outcome true
```

- **Authorized:** the admin or a registered resolver, acting on the
  council's ruling.
- **Requires:** the submission is `Escalated`. `council_deadline` is not
  checked.
- **Effect:** splits the bonds by the ruling (see [§6](#6-bond-and-stake-consequences)).
  If the market is still open, it resolves to the ruling. If it was already
  resolved or cancelled, it only settles the bonds, and the market keeps its
  existing outcome even if the ruling differs.

### 5.5 Contract error codes

| Code | Name | Usual meaning here |
|---|---|---|
| `#3` | `NotAdmin` | Signing key is not the contract admin |
| `#6` | `MarketNotExpired` | `end_time` has not passed on the ledger clock |
| `#7` | `MarketResolved` | Already resolved; check `get_market` |
| `#8` | `MarketCancelled` | Already cancelled |
| `#16` | `NotResolver` | Key is neither admin nor a registered resolver ([C3](#c3-resolver-key-not-authorized-on-chain)) |
| `#22` | `SubmissionNotFound` | No oracle submission for this market |
| `#23` | `AlreadyChallenged` | Submission is escalated; use `resolve_challenge`, not `finalize_outcome` |
| `#24` | `ChallengeWindowNotElapsed` | `finalize_outcome` before `challenge_deadline` |
| `#27` | `OracleInvalidState` | Wrong submission state for this call |

## 6. Bond and stake consequences

Bonds are XLM held by the contract. A submitter posts at least 100 XLM; a
challenger posts at least 200 XLM and more than the submitter. Every
remediation affects them as follows:

| Oracle submission | After force-resolve (`resolve_market`) | After cancel (`cancel_market`) |
|---|---|---|
| **None** (`#22`) | Nothing escrowed. Winners claim. | Nothing escrowed. Bettors refund themselves. |
| **`Submitted`** | Bond stays escrowed until anyone calls `finalize_outcome` after the window. Then it is returned in full, **even if the submitter asserted the other outcome** (no slashing). The submission can no longer be challenged. | Same: `finalize_outcome` after the window returns the bond in full; the market stays cancelled. |
| **`Escalated`** | Both bonds stay escrowed until the admin or a resolver calls `resolve_challenge`. It pays out on its own `outcome` argument, so rule the same way as the force-resolve or the bonds settle against the market's outcome. | Both bonds stay escrowed until `resolve_challenge`. It applies the normal win/lose split: there is no "refund both parties" path. |

`resolve_challenge` splits the bonds like this:

| Ruling | Submitter receives | Challenger receives | Protocol fees receive |
|---|---|---|---|
| Submitter was right | own bond + ½ challenger bond | nothing | ½ challenger bond |
| Challenger was right | nothing | own bond + 90 % of submitter bond | 10 % of submitter bond (council fee) |

Protocol fees stay in the contract until the admin or a fee recipient calls
`withdraw_fees`. No council member is paid directly.

Bettors' stakes:

| Market ends | Bettors |
|---|---|
| Resolved (any path) | Winners `claim` their share of the pool. If nobody backed the winning side, the pool goes to protocol fees. |
| Cancelled | Each bettor calls `cancel_refund` for their full stake. There is no deadline. |

## 7. Authorization

| Action | On-chain requirement | Organizational approval |
|---|---|---|
| Restart or reconfigure the aggregator | none | Aggregator operator |
| Cast a council vote | none (off-chain, `COUNCIL_MEMBERS`) | The council member themselves |
| `add_resolver` / `remove_resolver` | Contract admin key | Protocol/Funds owner |
| `finalize_outcome` | Anyone | Aggregator operator; no funds decision involved |
| `resolve_market` (force-resolve) | Admin or registered resolver | Protocol/Funds owner, via the council multisig for SEV1 |
| `resolve_challenge` | Admin or registered resolver | The council's ruling, executed on the Protocol/Funds owner's approval |
| `cancel_market` | Contract admin key only | Protocol/Funds owner, via the council multisig for SEV1 |

- The contract admin is a **single address**, fixed at `initialize` (the
  deploy scripts use the deployer key). No function rotates it, so treat it
  as the most sensitive key in the system.
- The contract does not enforce the council multisig. It is an
  organizational control: the approval happens before anyone signs. As the
  council runbook's incident response says, the person approving a funds
  action must not be the incident commander.
- The resolver key in `RESOLVER_KEY` is the aggregator's. Use a separate
  registered resolver identity for manual calls, so manual actions are
  attributable.

## 8. Verify and close

1. `get_market` shows the intended final state.
2. `get_oracle_submission` shows `Finalized`, or `#22` if there was never
   a submission. No bond is left escrowed.
3. `markets` matches the chain and `oracle.monitor.market_stuck` has
   stopped firing for the market. For a market closed through
   `resolve_market` or `cancel_market`, that requires the data fix in
   [C8](#c8-resolved-or-cancelled-on-chain-db-not-updated).
4. For a force-resolve or cancel, record in the incident: the approval, the
   signing address, the transaction hash, and whether users need to act
   (claim or `cancel_refund`). Then notify users, following the council
   runbook's user communication templates.
5. `npm --prefix oracle run audit:export -- --format json` captures the
   resolved market for the audit trail (it covers finalized markets only).

## Known errors in the older runbooks

These are wrong in the other runbooks as of this writing. Do not rely on
them during an incident:

- `npm run aggregator` and `npm run check-stuck-markets` do not exist. The
  aggregator runs as `npm --prefix oracle start` (`dist/index.js`), and
  stuck markets are reported by `oracle-monitor`.
- `npm run submit` takes only `--market <id>` and `--outcome <yes|no>`, with
  the key in `COUNCIL_MEMBER_SECRET`. It has no `--market-id`,
  `--member-key`, `--dry-run` or `--finalize` flag, and it never sends a
  transaction.
- The resolver key variable is `RESOLVER_KEY`, not `RESOLVER_SECRET_KEY` or
  `ORACLE_SECRET_KEY`.
- The contract has no `pause` function.
- `resolve_market` cannot cancel a market (`cancel_market` does), and
  neither call settles or returns bonds.
- `COUNCIL_FLOW_RUNBOOK.md` measures the council window from
  `submitted_at`. On-chain, `council_deadline` runs from the challenge
  (`escalated_at`).
- Error names: `#26` is `OracleWindowClosed` and `#28` is
  `OracleBondTooSmall`.
