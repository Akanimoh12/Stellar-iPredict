# Bet-pattern alerts

The indexer flags a market for **human review only**. A flag does not reject,
pause, limit, resolve, or otherwise change any bet or market. Detection is
performed as part of the idempotent bet-event write and the alert is persisted
in `bet_anomaly_alerts`; at most one flag is stored per market per UTC hour.

## Initial detection criteria

All of the following must be true for the trailing one-hour window:

1. The market is unresolved, uncancelled, and has between zero and 24 hours
   remaining.
2. At least **3 distinct bettors** placed bets.
3. Combined net bet volume is at least **100 tokens** (1,000,000,000 raw
   7-decimal units).
4. Combined recent net volume is at least **20%** of the market's volume before
   this event.
5. At least **90%** of that recent net volume is on the same side.

These deliberately conjunctive thresholds avoid alerting on a single ordinary
large bet or low-volume markets. They are initial conservative criteria, not a
claim that every flagged market is manipulation. A flag includes the market,
hour bucket, distinct bettor count, recent volume, and side concentration.
Indexer logs emit the `indexer.bet_pattern.detected` warning with
`action=manual_review_only`. Oracle integrations can use
`createBetPatternAlertSender` to forward the same review-only payload to a
webhook.

## Reviewing alerts and measuring false positives

Use `getUnreviewedBetAnomalies` in `backend/src/db/bets.ts` to obtain the review
queue and `reviewBetAnomaly` to record one of:

- `confirmed` — suspicious pattern was substantiated;
- `false_positive` — legitimate activity; or
- `inconclusive` — insufficient evidence.

`getBetAnomalyReviewMetrics` reports flagged count, conclusive review count,
false-positive count, and the measured false-positive rate:

`false_positive_rate = false_positive / (confirmed + false_positive)`

Inconclusive and unreviewed alerts are excluded from the denominator. The rate
is `null` until at least one conclusive review exists; no accuracy rate should
be claimed before that. Review decisions are audit data and do not change
market state. Reassess thresholds against reviewed outcomes before changing
them; especially monitor alert volume and false-positive rate together so
lowering one does not make the signal unusable.
