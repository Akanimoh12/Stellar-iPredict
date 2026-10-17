import type { DecodedContractEvent } from "../../src/types.js";

/**
 * Sample decoded contract events for indexer handler tests.
 *
 * These mirror exactly what `decodeEvent` in `src/decode.ts` produces from the
 * recorded XDR `raw-events.json` fixtures, so tests can assert a deterministic
 * round-trip: raw Soroban event -> decoded topics + data. Integer amounts come
 * off the wire as `bigint`; the handler decoders normalise them to `number` /
 * decimal strings as part of validation.
 */
export interface DecodedEventFixture extends DecodedContractEvent {
  name: string;
  contractId: string;
}

export const MARKET_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABF4";
export const TOKEN_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB2D";
export const REFERRAL_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4M";
export const LEADERBOARD_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB5O";

const LEDGER = 4723100;
const TX_HASH = "c" + "a".repeat(63);

export const decodedEvents: Record<string, DecodedEventFixture> = {
  market_created: {
    name: "market_created",
    contractId: MARKET_CONTRACT_ID,
    ledger: LEDGER,
    txHash: TX_HASH,
    eventIndex: 0,
    topics: ["mkt", "created"],
    data: {
      category: "Crypto",
      creator: "GDXTYTUAMJQMN7FS5UX2E7KR75VXLUQ36P3ZDJNIAQOSYAMMCIGUNIOA",
      end_time: 1798675200n,
      image_url: "https://media.ipredict.dev/markets/7.png",
      market_id: 7n,
      question: "Will ADA reach $5 by the end of 2026?",
    },
  },

  market_resolved: {
    name: "market_resolved",
    contractId: MARKET_CONTRACT_ID,
    ledger: LEDGER,
    txHash: TX_HASH,
    eventIndex: 1,
    topics: ["mkt", "resolved"],
    data: {
      market_id: 3n,
      outcome: true,
    },
  },

  market_cancelled: {
    name: "market_cancelled",
    contractId: MARKET_CONTRACT_ID,
    ledger: LEDGER,
    txHash: TX_HASH,
    eventIndex: 2,
    topics: ["mkt", "cancelled"],
    data: {
      market_id: 5n,
    },
  },

  bet_placed: {
    name: "bet_placed",
    contractId: MARKET_CONTRACT_ID,
    ledger: LEDGER,
    txHash: TX_HASH,
    eventIndex: 3,
    topics: ["bet", "placed"],
    data: {
      amount: 100000000n,
      fee: 3000000n,
      is_increase: false,
      is_yes: true,
      market_id: 7n,
      net_amount: 97000000n,
      user: "GAYBXPLPKV4IQVSBJMUMYHYVZHQW2ECQDSMFB7WEMWXP3JPH5SECHPXE",
    },
  },

  oracle_finalized: {
    name: "oracle_finalized",
    contractId: MARKET_CONTRACT_ID,
    ledger: LEDGER,
    txHash: TX_HASH,
    eventIndex: 4,
    topics: ["oracle", "finalized"],
    data: {
      challenged: false,
      challenger: null,
      challenger_payout: 0n,
      council_fee: 100n,
      finalized_at: 1798675200n,
      market_id: 3n,
      outcome: "yes",
      protocol_credit: 100000n,
      submitter: "GB72IPHJQ3ATBV7NQHUR26QS6LIMTGALB6CPNEF7ZALNUS5VG2GMXNO2",
      submitter_payout: 500000001n,
    },
  },

  oracle_submission: {
    name: "oracle_submission",
    contractId: MARKET_CONTRACT_ID,
    ledger: LEDGER,
    txHash: TX_HASH,
    eventIndex: 5,
    topics: ["submit_outcome"],
    data: {
      bond_amount: 1000n,
      market_id: 1n,
      outcome: "yes",
      submitter: "GB72IPHJQ3ATBV7NQHUR26QS6LIMTGALB6CPNEF7ZALNUS5VG2GMXNO2",
    },
  },

  oracle_challenged: {
    name: "oracle_challenged",
    contractId: MARKET_CONTRACT_ID,
    ledger: LEDGER,
    txHash: TX_HASH,
    eventIndex: 6,
    topics: ["oracle", "challenged"],
    data: {
      bond: 2000n,
      challenged_at: 1798675000n,
      challenger: "GAYBXPLPKV4IQVSBJMUMYHYVZHQW2ECQDSMFB7WEMWXP3JPH5SECHPXE",
      market_id: 3n,
      outcome: "yes",
      submitter: "GB72IPHJQ3ATBV7NQHUR26QS6LIMTGALB6CPNEF7ZALNUS5VG2GMXNO2",
      submitter_bond: 1000n,
    },
  },

  oracle_escalated: {
    name: "oracle_escalated",
    contractId: MARKET_CONTRACT_ID,
    ledger: LEDGER,
    txHash: TX_HASH,
    eventIndex: 7,
    topics: ["oracle", "escalated"],
    data: {
      challenger: "GAYBXPLPKV4IQVSBJMUMYHYVZHQW2ECQDSMFB7WEMWXP3JPH5SECHPXE",
      council_deadline: 1798675201n,
      escalated_at: 1798675001n,
      market_id: 3n,
      outcome: "yes",
      submitter: "GB72IPHJQ3ATBV7NQHUR26QS6LIMTGALB6CPNEF7ZALNUS5VG2GMXNO2",
      total_bond: 3000n,
    },
  },

  referral_registered: {
    name: "referral_registered",
    contractId: REFERRAL_CONTRACT_ID,
    ledger: LEDGER,
    txHash: TX_HASH,
    eventIndex: 8,
    topics: ["referral", "registered"],
    data: {
      display_name: "StellarAce",
      referrer: "GCCP3F4XDN7TNFF7S3EVHLUW6CM2CR2EDMU6UIB4DR3Z4BGCIBTUSHV6",
      referrer_points: 5n,
      user: "GAQ5DISJPXUYYT2ZWNPAUDPNJXTVZMDLX6VPQB6PPWTKZXDEB6OH5KLC",
      welcome_points: 5n,
    },
  },

  referral_reward: {
    name: "referral_reward",
    contractId: REFERRAL_CONTRACT_ID,
    ledger: LEDGER,
    txHash: TX_HASH,
    eventIndex: 9,
    topics: ["referral", "reward"],
    data: {
      points: 3n,
      referrer: "GCCP3F4XDN7TNFF7S3EVHLUW6CM2CR2EDMU6UIB4DR3Z4BGCIBTUSHV6",
    },
  },

  reward_claimed: {
    name: "reward_claimed",
    contractId: MARKET_CONTRACT_ID,
    ledger: LEDGER,
    txHash: TX_HASH,
    eventIndex: 10,
    topics: ["reward_claimed"],
    data: {
      market_id: 3n,
      payout_xlm: 2500000n,
      user: "GAYBXPLPKV4IQVSBJMUMYHYVZHQW2ECQDSMFB7WEMWXP3JPH5SECHPXE",
    },
  },

  fees_withdrawn: {
    name: "fees_withdrawn",
    contractId: MARKET_CONTRACT_ID,
    ledger: LEDGER,
    txHash: TX_HASH,
    eventIndex: 11,
    topics: ["fees_withdrawn"],
    data: {
      admin: "GDXTYTUAMJQMN7FS5UX2E7KR75VXLUQ36P3ZDJNIAQOSYAMMCIGUNIOA",
      amount: 12000000n,
    },
  },

  reward_points: {
    name: "reward_points",
    contractId: LEADERBOARD_CONTRACT_ID,
    ledger: LEDGER,
    txHash: TX_HASH,
    eventIndex: 12,
    topics: ["reward_points"],
    data: {
      is_winner: true,
      points: 25n,
      user: "GAYBXPLPKV4IQVSBJMUMYHYVZHQW2ECQDSMFB7WEMWXP3JPH5SECHPXE",
    },
  },

  token_mint: {
    name: "token_mint",
    contractId: TOKEN_CONTRACT_ID,
    ledger: LEDGER,
    txHash: TX_HASH,
    eventIndex: 13,
    topics: ["token_mint"],
    data: {
      amount: 1000000000n,
      to: "GD6Y22EG4PGE3SVRO3BMK5PKAVHVZNEP2G6O3WPSQ3KI2TY3H2EDWNVT",
    },
  },
};