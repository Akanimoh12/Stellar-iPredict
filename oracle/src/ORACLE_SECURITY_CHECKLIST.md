# Oracle Change Security Checklist

Copy this checklist into the PR description for any change under `oracle/`
(adapters, aggregator, submitter, config). It's a review aid, not a gate —
reviewers should still read the diff.

## Correctness

- [ ] The change matches the linked issue's "What to build" / acceptance criteria.
- [ ] Inputs from external sources (provider APIs, market params, council votes)
      are validated before use — no `any`-typed data flows into a resolution
      decision unchecked.
- [ ] Error paths are handled explicitly (a caught exception doesn't silently
      resolve a market with default/zero values).

## Idempotency & double-submit / double-payout safety

- [ ] Re-running this code path after a crash/restart cannot submit or pay out
      twice. If it writes durable state (DB row, on-chain tx), it either
      checks prior state first (see `isAlreadyResolved` in
      `submitter/resolveMarket.ts`) or relies on a uniqueness constraint that
      makes the second attempt fail loudly rather than double-apply.
- [ ] If this introduces a new external side effect (webhook, on-chain call,
      payout), confirm it only fires after the corresponding state write has
      durably succeeded — never before, never speculatively.
- [ ] Concurrent invocations (two aggregator instances, a retry racing the
      original attempt) can't both win.

## Data adapters specifically

- [ ] `supports()` rejects markets it can't actually resolve rather than
      throwing deep inside `fetchOutcome()`.
- [ ] Rate limits / `429`s are retried with backoff, not treated as a hard
      failure on the first hit (see `adapters/httpRetry.ts`).
- [ ] Non-retryable client errors (bad symbol, auth failure) fail fast instead
      of burning the retry budget.
- [ ] `confidence` reflects real uncertainty (e.g. stale/partial data lowers
      it) rather than always being hardcoded to `1`.

## Testing

- [ ] Covered by a unit test with a recorded/fixture response, not only a
      live-network manual check.
- [ ] If this changes an operational flow (council voting, finalization,
      key rotation), the relevant runbook is updated — see
      `aggregator/COUNCIL_FLOW_RUNBOOK.md` for the existing example.

## Docs

- [ ] `docs/ORACLE_AND_BACKEND.md` updated if this changes the architecture,
      constants, or data source priority described there.
