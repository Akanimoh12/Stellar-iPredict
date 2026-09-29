import { TEST_ADDRESSES } from "./addresses.js";

/**
 * Decoded contract event fixtures for indexer and integration tests.
 * These represent events as they come off the Stellar blockchain.
 */

export interface DecodedEventFixture {
  name: string;
  contractId: string;
  ledger: number;
  txHash: string;
  eventIndex: number;
  topics: readonly (string | undefined)[];
  data: Record<string, unknown>;
}

export const CONTRACT_IDS = {
  MARKET: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABF4",
  TOKEN: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB2D",
  REFERRAL: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4M",
  LEADERBOARD: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB5O",
} as const;

const DEFAULT_LEDGER = 4723100;
const DEFAULT_TX_HASH = "c" + "a".repeat(63);

export interface MarketCreatedEventData {
  market_id: bigint;
  question: string;
  category: string;
  end_time: bigint;
  creator: string;
  image_url: string;
}

export function makeMarketCreatedEvent(overrides: Partial<MarketCreatedEventData> = {}): DecodedEventFixture {
  return {
    name: "market_created",
    contractId: CONTRACT_IDS.MARKET,
    ledger: DEFAULT_LEDGER,
    txHash: DEFAULT_TX_HASH,
    eventIndex: 0,
    topics: ["mkt", "created"],
    data: {
      market_id: overrides.market_id ?? 7n,
      question: overrides.question ?? "Will ADA reach $5 by the end of 2026?",
      category: overrides.category ?? "Crypto",
      end_time: overrides.end_time ?? 1798675200n,
      creator: overrides.creator ?? TEST_ADDRESSES.CREATOR,
      image_url: overrides.image_url ?? "https://media.ipredict.dev/markets/7.png",
    },
  };
}

export interface MarketResolvedEventData {
  market_id: bigint;
  outcome: boolean;
}

export function makeMarketResolvedEvent(overrides: Partial<MarketResolvedEventData> = {}): DecodedEventFixture {
  return {
    name: "market_resolved",
    contractId: CONTRACT_IDS.MARKET,
    ledger: DEFAULT_LEDGER,
    txHash: DEFAULT_TX_HASH,
    eventIndex: 1,
    topics: ["mkt", "resolved"],
    data: {
      market_id: overrides.market_id ?? 3n,
      outcome: overrides.outcome ?? true,
    },
  };
}

export interface MarketCancelledEventData {
  market_id: bigint;
}

export function makeMarketCancelledEvent(overrides: Partial<MarketCancelledEventData> = {}): DecodedEventFixture {
  return {
    name: "market_cancelled",
    contractId: CONTRACT_IDS.MARKET,
    ledger: DEFAULT_LEDGER,
    txHash: DEFAULT_TX_HASH,
    eventIndex: 2,
    topics: ["mkt", "cancelled"],
    data: {
      market_id: overrides.market_id ?? 5n,
    },
  };
}

export interface BetPlacedEventData {
  market_id: bigint;
  user: string;
  is_yes: boolean;
  amount: bigint;
  net_amount: bigint;
  fee: bigint;
  is_increase: boolean;
}

export function makeBetPlacedEvent(overrides: Partial<BetPlacedEventData> = {}): DecodedEventFixture {
  return {
    name: "bet_placed",
    contractId: CONTRACT_IDS.MARKET,
    ledger: DEFAULT_LEDGER,
    txHash: DEFAULT_TX_HASH,
    eventIndex: 3,
    topics: ["bet", "placed"],
    data: {
      market_id: overrides.market_id ?? 7n,
      user: overrides.user ?? TEST_ADDRESSES.BETTOR,
      is_yes: overrides.is_yes ?? true,
      amount: overrides.amount ?? 100000000n,
      net_amount: overrides.net_amount ?? 97000000n,
      fee: overrides.fee ?? 3000000n,
      is_increase: overrides.is_increase ?? false,
    },
  };
}

export interface OracleSubmissionEventData {
  market_id: bigint;
  submitter: string;
  outcome: string;
  bond_amount: bigint;
}

export function makeOracleSubmissionEvent(overrides: Partial<OracleSubmissionEventData> = {}): DecodedEventFixture {
  return {
    name: "oracle_submission",
    contractId: CONTRACT_IDS.MARKET,
    ledger: DEFAULT_LEDGER,
    txHash: DEFAULT_TX_HASH,
    eventIndex: 5,
    topics: ["submit_outcome"],
    data: {
      market_id: overrides.market_id ?? 1n,
      submitter: overrides.submitter ?? TEST_ADDRESSES.ORACLE_SUBMITTER,
      outcome: overrides.outcome ?? "yes",
      bond_amount: overrides.bond_amount ?? 1000n,
    },
  };
}

export interface OracleChallengedEventData {
  market_id: bigint;
  challenger: string;
  outcome: string;
  bond: bigint;
  submitter: string;
  submitter_bond: bigint;
  challenged_at: bigint;
}

export function makeOracleChallengedEvent(overrides: Partial<OracleChallengedEventData> = {}): DecodedEventFixture {
  return {
    name: "oracle_challenged",
    contractId: CONTRACT_IDS.MARKET,
    ledger: DEFAULT_LEDGER,
    txHash: DEFAULT_TX_HASH,
    eventIndex: 6,
    topics: ["oracle", "challenged"],
    data: {
      market_id: overrides.market_id ?? 3n,
      challenger: overrides.challenger ?? TEST_ADDRESSES.ORACLE_CHALLENGER,
      outcome: overrides.outcome ?? "yes",
      bond: overrides.bond ?? 2000n,
      submitter: overrides.submitter ?? TEST_ADDRESSES.ORACLE_SUBMITTER,
      submitter_bond: overrides.submitter_bond ?? 1000n,
      challenged_at: overrides.challenged_at ?? 1798675000n,
    },
  };
}

export interface OracleFinalizedEventData {
  market_id: bigint;
  outcome: string;
  challenged: boolean;
  submitter: string;
  challenger: string | null;
  submitter_payout: bigint;
  challenger_payout: bigint;
  council_fee: bigint;
  protocol_credit: bigint;
  finalized_at: bigint;
}

export function makeOracleFinalizedEvent(overrides: Partial<OracleFinalizedEventData> = {}): DecodedEventFixture {
  return {
    name: "oracle_finalized",
    contractId: CONTRACT_IDS.MARKET,
    ledger: DEFAULT_LEDGER,
    txHash: DEFAULT_TX_HASH,
    eventIndex: 4,
    topics: ["oracle", "finalized"],
    data: {
      market_id: overrides.market_id ?? 3n,
      outcome: overrides.outcome ?? "yes",
      challenged: overrides.challenged ?? false,
      submitter: overrides.submitter ?? TEST_ADDRESSES.ORACLE_SUBMITTER,
      challenger: overrides.challenger ?? null,
      submitter_payout: overrides.submitter_payout ?? 500000001n,
      challenger_payout: overrides.challenger_payout ?? 0n,
      council_fee: overrides.council_fee ?? 100n,
      protocol_credit: overrides.protocol_credit ?? 100000n,
      finalized_at: overrides.finalized_at ?? 1798675200n,
    },
  };
}

export interface ReferralRegisteredEventData {
  user: string;
  display_name: string;
  referrer: string;
  welcome_points: bigint;
  referrer_points: bigint;
}

export function makeReferralRegisteredEvent(overrides: Partial<ReferralRegisteredEventData> = {}): DecodedEventFixture {
  return {
    name: "referral_registered",
    contractId: CONTRACT_IDS.REFERRAL,
    ledger: DEFAULT_LEDGER,
    txHash: DEFAULT_TX_HASH,
    eventIndex: 8,
    topics: ["referral", "registered"],
    data: {
      user: overrides.user ?? TEST_ADDRESSES.REFEREE,
      display_name: overrides.display_name ?? "StellarAce",
      referrer: overrides.referrer ?? TEST_ADDRESSES.REFERRER,
      welcome_points: overrides.welcome_points ?? 5n,
      referrer_points: overrides.referrer_points ?? 5n,
    },
  };
}

/** Collection of common event fixtures */
export const EVENT_FIXTURES = {
  marketCreated: makeMarketCreatedEvent,
  marketResolved: makeMarketResolvedEvent,
  marketCancelled: makeMarketCancelledEvent,
  betPlaced: makeBetPlacedEvent,
  oracleSubmission: makeOracleSubmissionEvent,
  oracleChallenged: makeOracleChallengedEvent,
  oracleFinalized: makeOracleFinalizedEvent,
  referralRegistered: makeReferralRegisteredEvent,
} as const;
