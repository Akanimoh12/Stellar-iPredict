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

type SeedOracleSubmission = {
  market_id: number;
  submitter: string;
  outcome: "yes" | "no";
  bond_amount: string;
  status: "submitted" | "challenged" | "finalized" | "rejected";
  decision: string | null;
};

type SeedOracleDispute = {
  market_id: number;
  submitter: string;
  challenger: string;
  outcome: "yes" | "no";
  submitter_bond: string;
  challenger_bond: string;
  status: "challenged" | "escalated";
  challenged_at: number;
  escalated_at: number | null;
  council_deadline: number | null;
};

type SeedCouncilVote = {
  market_id: number;
  member: string;
  outcome: boolean;
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
  },
  {
    id: 4,
    question: "Will XLM close above $0.25 by Dec 31, 2026?",
    image_url: null,
    category: "Crypto",
    end_time: 1788048000,
    total_yes: "10.0000000",
    total_no: "5.0000000",
    resolved: false,
    outcome: null,
    cancelled: false,
    creator: "GS100000000000000000000000000000000000000000000000000000",
    bet_count: 0
  },
  {
    id: 5,
    question: "Will Team Beta win the regional final?",
    image_url: null,
    category: "Sports",
    end_time: 1788048000,
    total_yes: "20.0000000",
    total_no: "10.0000000",
    resolved: false,
    outcome: null,
    cancelled: false,
    creator: "GS200000000000000000000000000000000000000000000000000000",
    bet_count: 0
  },
  {
    id: 6,
    question: "Will a resolution pass in the 2026 assembly?",
    image_url: null,
    category: "Politics",
    end_time: 1788048000,
    total_yes: "30.0000000",
    total_no: "15.0000000",
    resolved: false,
    outcome: null,
    cancelled: false,
    creator: "GS300000000000000000000000000000000000000000000000000000",
    bet_count: 0
  },
  {
    id: 7,
    question: "Will the science mission launch this quarter?",
    image_url: null,
    category: "Science",
    end_time: 1788048000,
    total_yes: "0.0000000",
    total_no: "0.0000000",
    resolved: false,
    outcome: null,
    cancelled: false,
    creator: "GS100000000000000000000000000000000000000000000000000000",
    bet_count: 0
  },
  {
    id: 8,
    question: "Will the new policy pass the entertainment vote?",
    image_url: null,
    category: "Entertainment",
    end_time: 1788048000,
    total_yes: "0.0000000",
    total_no: "0.0000000",
    resolved: false,
    outcome: null,
    cancelled: true,
    creator: "GS400000000000000000000000000000000000000000000000000000",
    bet_count: 0
  },
  {
    id: 9,
    question: "Will Team Gamma win the consolation bracket?",
    image_url: null,
    category: "Sports",
    end_time: 1788048000,
    total_yes: "0.0000000",
    total_no: "0.0000000",
    resolved: false,
    outcome: null,
    cancelled: false,
    creator: "GS300000000000000000000000000000000000000000000000000000",
    bet_count: 0
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

// Deterministic oracle fixtures so tests can assert against stable IDs.
// Submitter/challenger/council addresses are 56-char Stellar-style keys.
const SUBMITTER_1 = "GS100000000000000000000000000000000000000000000000000000";
const SUBMITTER_2 = "GS200000000000000000000000000000000000000000000000000000";
const SUBMITTER_3 = "GS300000000000000000000000000000000000000000000000000000";
const SUBMITTER_4 = "GS400000000000000000000000000000000000000000000000000000";
const CHALLENGER_1 = "GC100000000000000000000000000000000000000000000000000000";
const CHALLENGER_2 = "GC200000000000000000000000000000000000000000000000000000";
const CHALLENGER_3 = "GC300000000000000000000000000000000000000000000000000000";
const COUNCIL_MEMBER_1 = "GCOUNCIL100000000000000000000000000000000000000000000000";
const COUNCIL_MEMBER_2 = "GCOUNCIL200000000000000000000000000000000000000000000000";
const COUNCIL_MEMBER_3 = "GCOUNCIL300000000000000000000000000000000000000000000000";
const COUNCIL_MEMBER_4 = "GCOUNCIL400000000000000000000000000000000000000000000000";
const COUNCIL_MEMBER_5 = "GCOUNCIL500000000000000000000000000000000000000000000000";

// One oracle submission per market (oracle_submissions is UNIQUE on
// market_id), one per status so the full lifecycle is represented.
const SEED_ORACLE_SUBMISSIONS: SeedOracleSubmission[] = [
  {
    market_id: 4,
    submitter: SUBMITTER_1,
    outcome: "yes",
    bond_amount: "1000000000",
    status: "submitted",
    decision: null,
  },
  {
    market_id: 5,
    submitter: SUBMITTER_1,
    outcome: "yes",
    bond_amount: "1000000000",
    status: "challenged",
    decision: null,
  },
  {
    market_id: 6,
    submitter: SUBMITTER_2,
    outcome: "yes",
    bond_amount: "1500000000",
    status: "challenged",
    decision: null,
  },
  {
    market_id: 7,
    submitter: SUBMITTER_1,
    outcome: "yes",
    bond_amount: "1000000000",
    status: "finalized",
    decision: "finalized",
  },
  {
    market_id: 8,
    submitter: SUBMITTER_4,
    outcome: "no",
    bond_amount: "1200000000",
    status: "rejected",
    decision: "rejected",
  },
  {
    market_id: 9,
    submitter: SUBMITTER_3,
    outcome: "no",
    bond_amount: "1200000000",
    status: "challenged",
    decision: null,
  },
];

// Disputes mirror the challenged/escalated submissions. The contract rule
// requires the challenger bond to exceed the submitter bond.
const SEED_ORACLE_DISPUTES: SeedOracleDispute[] = [
  {
    market_id: 5,
    submitter: SUBMITTER_1,
    challenger: CHALLENGER_1,
    outcome: "yes",
    submitter_bond: "1000000000",
    challenger_bond: "2000000000",
    status: "challenged",
    challenged_at: 1788206400,
    escalated_at: null,
    council_deadline: null,
  },
  {
    market_id: 6,
    submitter: SUBMITTER_2,
    challenger: CHALLENGER_2,
    outcome: "yes",
    submitter_bond: "1500000000",
    challenger_bond: "3000000000",
    status: "escalated",
    challenged_at: 1788206400,
    escalated_at: 1788207000,
    council_deadline: 1788210600,
  },
  {
    market_id: 9,
    submitter: SUBMITTER_3,
    challenger: CHALLENGER_3,
    outcome: "no",
    submitter_bond: "1200000000",
    challenger_bond: "2500000000",
    status: "escalated",
    challenged_at: 1788206400,
    escalated_at: 1788207100,
    council_deadline: 1788210700,
  },
];

// Council votes for the escalated markets. Market 6 reaches the 4-of-7
// threshold (4 yes votes); market 9 does not (only 3 votes, 2 yes + 1 no).
const SEED_COUNCIL_VOTES: SeedCouncilVote[] = [
  { market_id: 6, member: COUNCIL_MEMBER_1, outcome: true },
  { market_id: 6, member: COUNCIL_MEMBER_2, outcome: true },
  { market_id: 6, member: COUNCIL_MEMBER_3, outcome: true },
  { market_id: 6, member: COUNCIL_MEMBER_4, outcome: true },
  { market_id: 6, member: COUNCIL_MEMBER_5, outcome: false },
  { market_id: 9, member: COUNCIL_MEMBER_1, outcome: true },
  { market_id: 9, member: COUNCIL_MEMBER_2, outcome: true },
  { market_id: 9, member: COUNCIL_MEMBER_3, outcome: false },
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

  await db.query(`
    CREATE TABLE IF NOT EXISTS oracle_submissions (
      id              SERIAL PRIMARY KEY,
      market_id       INTEGER NOT NULL UNIQUE,
      submitter       VARCHAR(255) NOT NULL,
      outcome         VARCHAR(255) NOT NULL,
      bond_amount     NUMERIC NOT NULL,
      submitted_at    TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      status          VARCHAR(20) NOT NULL DEFAULT 'submitted',
      decision        VARCHAR(255),
      tx_hash         CHAR(64),
      finalized_at    TIMESTAMPTZ,
      council_votes   JSONB DEFAULT '{}'::jsonb,
      nonce           VARCHAR(64),
      request_timestamp TIMESTAMPTZ
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS oracle_disputes (
      id                SERIAL PRIMARY KEY,
      market_id         INTEGER NOT NULL UNIQUE,
      submitter         VARCHAR(255) NOT NULL,
      challenger        VARCHAR(255) NOT NULL,
      outcome           VARCHAR(255) NOT NULL,
      submitter_bond    NUMERIC NOT NULL,
      challenger_bond   NUMERIC NOT NULL,
      total_bond        NUMERIC GENERATED ALWAYS AS (submitter_bond + challenger_bond) STORED,
      status            VARCHAR(20) NOT NULL DEFAULT 'challenged',
      challenged_at     TIMESTAMPTZ,
      escalated_at      TIMESTAMPTZ,
      council_deadline  TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS council_votes (
      market_id     BIGINT NOT NULL,
      member        CHAR(56) NOT NULL,
      outcome       BOOLEAN NOT NULL,
      submitted_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (market_id, member)
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

async function seedOracleSubmissions(db: Queryable): Promise<void> {
  const query = `
    INSERT INTO oracle_submissions (
      market_id,
      submitter,
      outcome,
      bond_amount,
      status,
      decision
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (market_id) DO UPDATE SET
      submitter = EXCLUDED.submitter,
      outcome = EXCLUDED.outcome,
      bond_amount = EXCLUDED.bond_amount,
      status = EXCLUDED.status,
      decision = EXCLUDED.decision
  `;

  for (const submission of SEED_ORACLE_SUBMISSIONS) {
    await db.query(query, [
      submission.market_id,
      submission.submitter,
      submission.outcome,
      submission.bond_amount,
      submission.status,
      submission.decision,
    ]);
  }
}

async function seedOracleDisputes(db: Queryable): Promise<void> {
  const query = `
    INSERT INTO oracle_disputes (
      market_id,
      submitter,
      challenger,
      outcome,
      submitter_bond,
      challenger_bond,
      status,
      challenged_at,
      escalated_at,
      council_deadline
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8), to_timestamp($9), to_timestamp($10))
    ON CONFLICT (market_id) DO UPDATE SET
      submitter = EXCLUDED.submitter,
      challenger = EXCLUDED.challenger,
      outcome = EXCLUDED.outcome,
      submitter_bond = EXCLUDED.submitter_bond,
      challenger_bond = EXCLUDED.challenger_bond,
      status = EXCLUDED.status,
      challenged_at = EXCLUDED.challenged_at,
      escalated_at = EXCLUDED.escalated_at,
      council_deadline = EXCLUDED.council_deadline
  `;

  for (const dispute of SEED_ORACLE_DISPUTES) {
    await db.query(query, [
      dispute.market_id,
      dispute.submitter,
      dispute.challenger,
      dispute.outcome,
      dispute.submitter_bond,
      dispute.challenger_bond,
      dispute.status,
      dispute.challenged_at,
      dispute.escalated_at,
      dispute.council_deadline,
    ]);
  }
}

async function seedCouncilVotes(db: Queryable): Promise<void> {
  const query = `
    INSERT INTO council_votes (
      market_id,
      member,
      outcome
    )
    VALUES ($1, $2, $3)
    ON CONFLICT (market_id, member) DO UPDATE SET
      outcome = EXCLUDED.outcome
  `;

  for (const vote of SEED_COUNCIL_VOTES) {
    await db.query(query, [vote.market_id, vote.member, vote.outcome]);
  }
}

export async function runSeed(db: Queryable): Promise<void> {
  await db.query("BEGIN");
  try {
    await ensureSchema(db);
    await seedMarkets(db);
    await seedBets(db);
    await seedLeaderboard(db);
    await seedOracleSubmissions(db);
    await seedOracleDisputes(db);
    await seedCouncilVotes(db);
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