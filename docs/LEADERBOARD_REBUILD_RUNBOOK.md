# Leaderboard Rebuild Runbook

> **When to use:** If the leaderboard becomes stale or inconsistent due to event replay, table corruption, or manual database repairs.

---

## Overview

The **leaderboard rebuild job** replays all events from the audit `events` table to recompute the `leaderboard` snapshot from scratch. This is idempotent and safe to run at any time without disrupting the indexer.

### What the Job Does

1. Fetches ALL events (or from a specific ledger onward) from the `events` table
2. Aggregates events into per-user leaderboard entries:
   - **Total predictions:** count of all reward-claim events
   - **Correct predictions:** count of events where `is_winner == true`
   - **Total points:** sum of `points` from all events
   - **Win rate:** `correctPredictions / totalPredictions`
3. Sorts players by total points (descending), then by wins, then by losses
4. Truncates the `leaderboard` table and re-inserts all computed rows
5. Logs start, progress, and completion with timestamps
6. Handles errors gracefully — logs errors per user but never crashes

---

## Trigger a Manual Rebuild

### Option 1: Full Rebuild (Recommended for First Run)

Replay all events since the contract deploy:

```bash
cd indexer
export DATABASE_URL="postgres://user:pass@localhost:5432/ipredict"
npm run rebuild:leaderboard
```

Expected output (JSON):

```json
{
  "timestamp": "2025-01-15T12:34:56.789Z",
  "level": "info",
  "message": "indexer run started",
  "component": "indexer",
  "job": "leaderboard-rebuild",
  "dryRun": false,
  "sinceLedger": null,
  "logLevel": "info"
}
{
  "timestamp": "2025-01-15T12:34:58.123Z",
  "level": "info",
  "message": "poll summary",
  "component": "indexer",
  "job": "leaderboard-rebuild",
  "eventsProcessed": 1247,
  "lagLedgers": 0,
  "durationMs": 1334,
  "lastLedgerSeq": 50000,
  "checkpointLedger": null
}
```

### Option 2: Partial Rebuild (From Specific Ledger)

Replay only events from ledger 10000 onward:

```bash
npm run rebuild:leaderboard -- --since-ledger 10000
```

This is useful for:
- Testing fixes to event-handling logic without replaying everything
- Recovering from a specific point when events were corrupted

### Option 3: Dry-Run (Validate Without Writing)

Compute the rebuild without mutating the database:

```bash
npm run rebuild:leaderboard -- --dry-run
```

The job will:
- Read all events
- Compute rankings
- Print the summary (players count, events processed, duration)
- **NOT** delete or modify the `leaderboard` table
- Roll back all changes (if inside a transaction)

Combine with `--since-ledger` for dry-run from a specific point:

```bash
npm run rebuild:leaderboard -- --dry-run --since-ledger 10000
```

---

## Verify the Rebuild Ran Correctly

### Check Output Logs

Look for the `poll summary` line in the logs:

```json
{
  "level": "info",
  "message": "poll summary",
  "eventsProcessed": 1247,
  "durationMs": 1334,
  "lastLedgerSeq": 50000
}
```

- **eventsProcessed**: number of events aggregated (should match the count in `events` table or after --since-ledger)
- **durationMs**: how long the rebuild took (should be <5s for most datasets)
- **lastLedgerSeq**: the latest ledger from the events (confirms we processed all events)

### Query the Leaderboard Table

```sql
-- Check row count and top 10
SELECT COUNT(*) FROM leaderboard;

SELECT 
  address, 
  display_name, 
  points, 
  won_bets, 
  lost_bets, 
  updated_at
FROM leaderboard
ORDER BY points DESC
LIMIT 10;
```

Expected:
- Non-zero row count if events exist
- Players sorted by `points` descending
- `updated_at` should be very recent (timestamp of the rebuild run)

### Verify Point Calculations

For a specific user, manually check:

```sql
-- Count events for user and sum points
SELECT 
  COUNT(*) as event_count,
  SUM(CASE WHEN payload->>'is_winner' = 'true' THEN 1 ELSE 0 END) as won_bets,
  SUM(CASE WHEN payload->>'is_winner' = 'false' THEN 1 ELSE 0 END) as lost_bets,
  SUM((payload->>'points')::int) as total_points
FROM events
WHERE payload->>'user' = 'GUSER_ADDRESS'
  OR actor = 'GUSER_ADDRESS'
  OR payload->>'referrer' = 'GUSER_ADDRESS';

-- Compare to leaderboard
SELECT * FROM leaderboard WHERE address = 'GUSER_ADDRESS';
```

---

## Common Issues & Fixes

### Issue: "DATABASE_URL is required"

**Cause:** Environment variable not set.

**Fix:**

```bash
export DATABASE_URL="postgres://user:password@localhost:5432/ipredict"
npm run rebuild:leaderboard
```

Or set it inline:

```bash
DATABASE_URL="postgres://..." npm run rebuild:leaderboard
```

---

### Issue: Rebuild Runs But Leaderboard Table is Empty

**Cause:** The `events` table has no rows (or no matching events after `--since-ledger`).

**Fix:**

1. Check that events have been indexed:

```sql
SELECT COUNT(*) FROM events;
SELECT * FROM events LIMIT 5;
```

2. Verify the indexer is running and polling for events:

```bash
npm run dev  # in indexer directory
```

3. If the `events` table is truly empty and you've just deployed, give the indexer 1-2 minutes to fetch and index the first batch of events from the contract.

---

### Issue: Rebuild Hangs or Takes > 30 Seconds

**Cause:** Database is slow, or the `events` table is huge (millions of rows).

**Fix:**

1. Run a dry-run to measure time without I/O overhead:

```bash
npm run rebuild:leaderboard -- --dry-run
```

2. Check database query performance:

```sql
-- Verify events table has an index on ledger_seq
EXPLAIN ANALYZE
SELECT * FROM events ORDER BY ledger_seq ASC, id ASC;
```

If the plan shows a sequential scan, ensure indexes exist:

```sql
CREATE INDEX idx_events_ledger ON events(ledger_seq DESC);
```

3. Use `--since-ledger` to rebuild from a recent checkpoint instead of from genesis:

```bash
npm run rebuild:leaderboard -- --since-ledger 999999
```

---

### Issue: Rebuild Fails with "Lock timeout" or "Connection lost"

**Cause:** Database is heavily loaded or the connection closed mid-transaction.

**Fix:**

1. Retry the rebuild after a brief wait:

```bash
sleep 5 && npm run rebuild:leaderboard
```

2. Ensure the database pool is healthy:

```sql
-- Check for stuck connections
SELECT pid, usename, state, query FROM pg_stat_activity WHERE state != 'idle';
```

3. If stuck connections exist, terminate them:

```sql
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE state = 'active' AND query_start < NOW() - INTERVAL '5 minutes';
```

Then retry the rebuild.

---

### Issue: Points or Rankings Don't Match Expectations

**Cause:** Event payload fields have changed, or new event types aren't recognized.

**Fix:**

1. Check the event payload structure:

```sql
SELECT 
  event_type, 
  COUNT(*) as count,
  jsonb_agg(DISTINCT payload::text LIMIT 1) as sample_payload
FROM events
GROUP BY event_type
ORDER BY count DESC;
```

2. If new fields or event types exist, check the `leaderboard-rebuild.ts` file for handling logic:

```typescript
// Look at functions like:
// - looksLikeClaimEvent()
// - handleReferralBonus()
// - firstNumber(), firstBoolean(), etc.
```

3. Update `leaderboard-rebuild.ts` to recognize new event types or payload fields (see the job implementation).

4. Re-run the rebuild:

```bash
npm run rebuild:leaderboard
```

---

## Automation & Scheduling

The leaderboard rebuild is a **manual, on-demand job** by design:

- **Not automatically scheduled.** It only runs when explicitly triggered.
- **Safe to run concurrently** with the live indexer (uses a transaction).
- **Idempotent.** Running it twice produces the same result.

### Optional: Schedule a Periodic Rebuild

To automatically rebuild every hour, add a cron job:

```bash
# Linux/macOS (in crontab -e)
0 * * * * cd /path/to/indexer && npm run rebuild:leaderboard >> /var/log/leaderboard-rebuild.log 2>&1
```

Or using systemd timer (Linux):

```ini
# /etc/systemd/system/leaderboard-rebuild.service
[Unit]
Description=Leaderboard Rebuild Job
After=network.target

[Service]
Type=oneshot
WorkingDirectory=/path/to/indexer
Environment="DATABASE_URL=postgres://..."
ExecStart=/usr/bin/npm run rebuild:leaderboard

# /etc/systemd/system/leaderboard-rebuild.timer
[Unit]
Description=Run Leaderboard Rebuild Hourly

[Timer]
OnBootSec=1min
OnUnitActiveSec=1h

[Install]
WantedBy=timers.target
```

Enable:

```bash
sudo systemctl enable leaderboard-rebuild.timer
sudo systemctl start leaderboard-rebuild.timer
```

---

## Step-by-Step Examples

### Scenario 1: First-Time Leaderboard Setup

```bash
# 1. Verify database connectivity
psql -c "SELECT 1" "$DATABASE_URL"

# 2. Check tables exist
psql -c "SELECT COUNT(*) FROM events; SELECT COUNT(*) FROM leaderboard;" "$DATABASE_URL"

# 3. Run dry-run first to validate
cd indexer
npm run rebuild:leaderboard -- --dry-run

# 4. Run the actual rebuild
npm run rebuild:leaderboard

# 5. Verify results
psql -c "SELECT COUNT(*) as player_count, AVG(points) as avg_points FROM leaderboard;" "$DATABASE_URL"
```

### Scenario 2: Events Were Replayed, Leaderboard is Stale

```bash
# Check how many events exist
psql -c "SELECT COUNT(*) FROM events;" "$DATABASE_URL"

# Run a dry-run to see what would be rebuilt
npm run rebuild:leaderboard -- --dry-run

# If it looks good, do the rebuild
npm run rebuild:leaderboard

# Confirm
psql -c "SELECT updated_at FROM leaderboard ORDER BY updated_at DESC LIMIT 1;" "$DATABASE_URL"
```

### Scenario 3: Only Rebuild from a Recent Ledger

```bash
# Find the last good checkpoint (e.g., from indexer logs)
# Last good ledger: 50000

# Rebuild from ledger 50001 onward (dry-run first)
npm run rebuild:leaderboard -- --dry-run --since-ledger 50001

# Then run for real
npm run rebuild:leaderboard -- --since-ledger 50001

# Verify
psql -c "SELECT COUNT(*) FROM leaderboard;" "$DATABASE_URL"
```

---

## Performance Notes

- **Events table size:** 10,000 events = ~100ms
- **Events table size:** 100,000 events = ~1s
- **Events table size:** 1M events = ~10s

For production deployments with >1M events:

1. Ensure indexes exist on `events(ledger_seq, id)`
2. Consider running dry-run first to estimate time
3. Run during off-peak hours (low API traffic)
4. Use `--since-ledger` to partition the rebuild across multiple runs if needed

---

## Rollback

If the rebuild produces an incorrect leaderboard:

```sql
-- Restore from backup
-- (Assumes you have a pre-rebuild backup)
TRUNCATE leaderboard;
RESTORE TABLE leaderboard FROM backup_leaderboard_YYYY_MM_DD;
```

Or, manually restore previous state:

```bash
# If you ran with --dry-run first (good practice!):
# The database was never modified. Re-run to apply changes.
npm run rebuild:leaderboard
```

---

## Support

For issues or questions:

1. Check the logs (JSON structured logs in stdout/stderr)
2. Verify the `events` table has the expected data
3. Consult the **Common Issues & Fixes** section above
4. Open an issue on GitHub with:
   - The full log output (redact sensitive keys)
   - Event count from the `events` table
   - Expected vs. actual leaderboard row count/points

