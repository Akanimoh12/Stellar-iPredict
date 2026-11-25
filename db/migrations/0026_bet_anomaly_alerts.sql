CREATE TABLE IF NOT EXISTS bet_anomaly_alerts (
  market_id          BIGINT NOT NULL REFERENCES markets(id) ON DELETE RESTRICT,
  window_start       TIMESTAMPTZ NOT NULL,
  bettor_count       INTEGER NOT NULL CHECK (bettor_count >= 3),
  recent_net_amount  NUMERIC(30,7) NOT NULL CHECK (recent_net_amount > 0),
  same_side_share    NUMERIC(5,4) NOT NULL CHECK (same_side_share BETWEEN 0 AND 1),
  reviewed_at        TIMESTAMPTZ,
  review_outcome     VARCHAR(20) CHECK (
    review_outcome IN ('confirmed', 'false_positive', 'inconclusive')
  ),
  review_note        TEXT,
  PRIMARY KEY (market_id, window_start),
  CHECK ((reviewed_at IS NULL) = (review_outcome IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_bet_anomaly_alerts_unreviewed
  ON bet_anomaly_alerts (window_start DESC)
  WHERE reviewed_at IS NULL;
