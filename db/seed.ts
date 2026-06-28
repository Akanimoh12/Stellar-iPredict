import { Client } from "pg";

type Queryable = {
  query(text: string, values?: unknown[]): Promise<unknown>;
};

type SeedMarket = {
  id: number;
  question: string;
  image_url: string | null;
  category: "Crypto" | "Sports" | "Politics" | "Entertainment" | "Science";
  end_time: number;
  total_yes: string;
  total_no: string;
  resolved: boolean;
  outcome: boolean | null;
  cancelled: boolean;
  creator: string;
  bet_count: number;
};

type SeedBet = {
  market_id: number;
  bettor: string;
  net_amount: string;
  gross_amount: string;
  is_yes: boolean;
  claimed: boolean;
};

type SeedLeaderboard = {
  address: string;
  display_name: string;
  points: number;
  won_bets: number;
  lost_bets: number;
};

const SEED_MARKETS: SeedMarket[] = [
  {
    id: 1,
    question: "Will XLM close above $0.20 by Dec 31, 2026?",
    image_url: null,
    category: "Crypto",
    end_time: 1798675200,
    total_yes: "1200.0000000",
    total_no: "800.0000000",
    resolved: false,
    outcome: null,
    cancelled: false,
    creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    bet_count: 3
  },
  {
    id: 2,
    question: "Will Team Alpha win the championship final?",
    image_url: null,
    category: "Sports",
    end_time: 1788206400,
    total_yes: "650.0000000",
    total_no: "900.0000000",
    resolved: false,
    outcome: null,
    cancelled: false,
    creator: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    bet_count: 2
  },
  {
    id: 3,
    question: "Will Candidate Z win the 2026 election?",
    image_url: null,
    category: "Politics",
    end_time: 1790966400,
    total_yes: "1500.0000000",
    total_no: "1400.0000000",
    resolved: true,
    outcome: true,
    cancelled: false,
    creator: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    bet_count: 4
  }
];

const SEED_BETS: SeedBet[] = [
  {
    market_id: 1,
    bettor: "GUSER00000000000000000000000000000000000000000000000001",
    net_amount: "350.0000000",
    gross_amount: "357.0000000",
    is_yes: true,
    claimed: false
  },
  {
    market_id: 1,
    bettor: "GUSER00000000000000000000000000000000000000000000000002",
    net_amount: "500.0000000",
    gross_amount: "510.0000000",
    is_yes: false,
    claimed: false
  },
  {
    market_id: 2,
    bettor: "GUSER00000000000000000000000000000000000000000000000003",
    net_amount: "400.0000000",
    gross_amount: "408.0000000",
    is_yes: true,
    claimed: false
  },
  {
    market_id: 3,
    bettor: "GUSER00000000000000000000000000000000000000000000000004",
    net_amount: "900.0000000",
    gross_amount: "918.0000000",
    is_yes: true,
    claimed: true
  }
];

const SEED_LEADERBOARD: SeedLeaderboard[] = [
  {
    address: "GUSER00000000000000000000000000000000000000000000000001",
    display_name: "alpha_whale",
    points: 120,
    won_bets: 3,
    lost_bets: 1
  },
  {
    address: "GUSER00000000000000000000000000000000000000000000000002",
    display_name: "beta_oracle",
    points: 95,
    won_bets: 2,
    lost_bets: 2
  },
  {
    address: "GUSER00000000000000000000000000000000000000000000000003",
    display_name: "gamma_punter",
    points: 70,
    won_bets: 1,
    lost_bets: 2
  }
];

async function ensureSchema(db: Queryable): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS markets (
      id            BIGINT PRIMARY KEY,
      question      TEXT NOT NULL,
      image_url     TEXT,
      category      VARCHAR(20) NOT NULL,
      end_time      BIGINT NOT NULL,
      total_yes     NUMERIC(30,7) NOT NULL DEFAULT 0,
      total_no      NUMERIC(30,7) NOT NULL DEFAULT 0,
      resolved      BOOLEAN NOT NULL DEFAULT FALSE,
      outcome       BOOLEAN,
      cancelled     BOOLEAN NOT NULL DEFAULT FALSE,
      creator       CHAR(56) NOT NULL,
      bet_count     INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMP DEFAULT NOW(),
      updated_at    TIMESTAMP DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS bets (
      market_id     BIGINT REFERENCES markets(id),
      bettor        CHAR(56) NOT NULL,
      net_amount    NUMERIC(30,7) NOT NULL,
      gross_amount  NUMERIC(30,7) NOT NULL,
      is_yes        BOOLEAN NOT NULL,
      claimed       BOOLEAN NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (market_id, bettor)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS leaderboard (
      address       CHAR(56) PRIMARY KEY,
      display_name  VARCHAR(50),
      points        BIGINT NOT NULL DEFAULT 0,
      won_bets      INTEGER NOT NULL DEFAULT 0,
      lost_bets     INTEGER NOT NULL DEFAULT 0,
      updated_at    TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function seedMarkets(db: Queryable): Promise<void> {
  const query = `
    INSERT INTO markets (
      id,
      question,
      image_url,
      category,
      end_time,
      total_yes,
      total_no,
      resolved,
      outcome,
      cancelled,
      creator,
      bet_count,
      updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      question = EXCLUDED.question,
      image_url = EXCLUDED.image_url,
      category = EXCLUDED.category,
      end_time = EXCLUDED.end_time,
      total_yes = EXCLUDED.total_yes,
      total_no = EXCLUDED.total_no,
      resolved = EXCLUDED.resolved,
      outcome = EXCLUDED.outcome,
      cancelled = EXCLUDED.cancelled,
      creator = EXCLUDED.creator,
      bet_count = EXCLUDED.bet_count,
      updated_at = NOW()
  `;

  for (const market of SEED_MARKETS) {
    await db.query(query, [
      market.id,
      market.question,
      market.image_url,
      market.category,
      market.end_time,
      market.total_yes,
      market.total_no,
      market.resolved,
      market.outcome,
      market.cancelled,
      market.creator,
      market.bet_count
    ]);
  }
}

async function seedBets(db: Queryable): Promise<void> {
  const query = `
    INSERT INTO bets (
      market_id,
      bettor,
      net_amount,
      gross_amount,
      is_yes,
      claimed
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (market_id, bettor) DO UPDATE SET
      net_amount = EXCLUDED.net_amount,
      gross_amount = EXCLUDED.gross_amount,
      is_yes = EXCLUDED.is_yes,
      claimed = EXCLUDED.claimed
  `;

  for (const bet of SEED_BETS) {
    await db.query(query, [
      bet.market_id,
      bet.bettor,
      bet.net_amount,
      bet.gross_amount,
      bet.is_yes,
      bet.claimed
    ]);
  }
}

async function seedLeaderboard(db: Queryable): Promise<void> {
  const query = `
    INSERT INTO leaderboard (
      address,
      display_name,
      points,
      won_bets,
      lost_bets,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (address) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      points = EXCLUDED.points,
      won_bets = EXCLUDED.won_bets,
      lost_bets = EXCLUDED.lost_bets,
      updated_at = NOW()
  `;

  for (const row of SEED_LEADERBOARD) {
    await db.query(query, [
      row.address,
      row.display_name,
      row.points,
      row.won_bets,
      row.lost_bets
    ]);
  }
}

export async function runSeed(db: Queryable): Promise<void> {
  await db.query("BEGIN");
  try {
    await ensureSchema(db);
    await seedMarkets(db);
    await seedBets(db);
    await seedLeaderboard(db);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

async function main(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL ?? "postgresql://ipredict:ipredict@localhost:5432/ipredict";

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await runSeed(client);
    console.log("[ipredict-db] seed completed successfully");
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("[ipredict-db] seed failed", error);
    process.exit(1);
  });
}