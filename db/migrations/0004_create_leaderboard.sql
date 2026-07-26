CREATE TABLE IF NOT EXISTS leaderboard (
  address      CHAR(56) PRIMARY KEY,
  display_name VARCHAR(50),
  points       BIGINT NOT NULL DEFAULT 0,
  won_bets     INTEGER NOT NULL DEFAULT 0,
  lost_bets    INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lb_points ON leaderboard(points DESC);
