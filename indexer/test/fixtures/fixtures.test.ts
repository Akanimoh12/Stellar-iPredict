import { describe, expect, it } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import { decodeEvent } from "../../src/decode.js";
import type { DecodedEvent } from "../../src/decode.js";
import { decodeBetPlacedEvent } from "../../src/handlers/bet_placed.js";
import { decodeClaim } from "../../src/handlers/claim.js";
import { decodeFeeWithdrawn } from "../../src/handlers/fee_withdrawn.js";
import { decodeMarketCancelledEvent } from "../../src/handlers/market_cancelled.js";
import { decodeMarketCreatedEvent } from "../../src/handlers/market_created.js";
import { decodeMarketResolvedEvent } from "../../src/handlers/market_resolved.js";
import { decodeOracleChallengedEvent, decodeOracleEscalatedEvent } from "../../src/handlers/oracle_challenge.js";
import { decodeOracleFinalizedEvent } from "../../src/handlers/oracle_finalized.js";
import { decodeOracleSubmission } from "../../src/handlers/oracle_submission.js";
import { decodeReferralRegisteredEvent } from "../../src/handlers/referral_registered.js";
import { decodeReferralRewardEvent } from "../../src/handlers/referral_reward.js";
import { decodeRewardPoints } from "../../src/handlers/reward_points.js";
import { decodeTokenMint } from "../../src/handlers/token_mint.js";
import { decodedEvents, type DecodedEventFixture } from "./decoded-events.js";
import rawEvents from "./raw-events.json";

const CREATOR = "GDXTYTUAMJQMN7FS5UX2E7KR75VXLUQ36P3ZDJNIAQOSYAMMCIGUNIOA";
const BETTOR = "GAYBXPLPKV4IQVSBJMUMYHYVZHQW2ECQDSMFB7WEMWXP3JPH5SECHPXE";
const SUBMITTER = "GB72IPHJQ3ATBV7NQHUR26QS6LIMTGALB6CPNEF7ZALNUS5VG2GMXNO2";
const REFERRER = "GCCP3F4XDN7TNFF7S3EVHLUW6CM2CR2EDMU6UIB4DR3Z4BGCIBTUSHV6";
const REFEREE = "GAQ5DISJPXUYYT2ZWNPAUDPNJXTVZMDLX6VPQB6PPWTKZXDEB6OH5KLC";
const TOKEN_RECIPIENT = "GD6Y22EG4PGE3SVRO3BMK5PKAVHVZNEP2G6O3WPSQ3KI2TY3H2EDWNVT";

describe("recorded event fixtures", () => {
  it("raw fixtures and decoded fixtures cover the same event set", () => {
    const rawNames = rawEvents.map((raw) => raw.name).sort();
    expect(rawNames).toEqual(Object.keys(decodedEvents).sort());
  });

  for (const raw of rawEvents) {
    it(`decodes ${raw.name} deterministically to the recorded shape`, () => {
      const topics = raw.topics.map((topic) => xdr.ScVal.fromXDR(topic, "base64"));
      const value = xdr.ScVal.fromXDR(raw.value, "base64");

      const decoded = decodeEvent(topics, value);
      const expected = decodedEvents[raw.name];

      expect(decoded.type).toBe(expected.topics[0] ?? "");
      expect(decoded.subtype).toBe(expected.topics[1]);
      expect(decoded.data).toEqual(expected.data);

      // Decoding is stable: running the same XDR twice yields the same result.
      expect(decodeEvent(topics, value)).toEqual(decoded);
    });
  }
});

type HandlerDecoder = (event: Pick<DecodedEventFixture, "topics" | "data">) => unknown;

const handlerDecoders: Record<string, { decode: HandlerDecoder; expected: (f: DecodedEventFixture) => unknown }> = {
  market_created: {
    decode: decodeMarketCreatedEvent,
    expected: () => ({
      market_id: 7,
      question: "Will ADA reach $5 by the end of 2026?",
      category: "Crypto",
      end_time: 1798675200,
      creator: CREATOR,
      image_url: "https://media.ipredict.dev/markets/7.png",
    }),
  },
  market_resolved: {
    decode: decodeMarketResolvedEvent,
    expected: () => ({ market_id: 3, outcome: true }),
  },
  market_cancelled: {
    decode: decodeMarketCancelledEvent,
    expected: () => ({ market_id: 5 }),
  },
  bet_placed: {
    decode: decodeBetPlacedEvent,
    expected: () => ({
      market_id: 7,
      bettor: BETTOR,
      is_yes: true,
      amount: "100000000",
      net_amount: "97000000",
      fee: "3000000",
      is_increase: false,
    }),
  },
  oracle_finalized: {
    decode: decodeOracleFinalizedEvent,
    expected: () => ({
      market_id: 3,
      outcome: "yes",
      challenged: false,
      submitter: SUBMITTER,
      challenger: null,
      submitter_payout: "500000001",
      challenger_payout: "0",
      council_fee: "100",
      protocol_credit: "100000",
      finalized_at: new Date(1798675200 * 1000),
    }),
  },
  oracle_submission: {
    decode: decodeOracleSubmission,
    expected: () => ({ market_id: 1, submitter: SUBMITTER, outcome: "yes", bond_amount: "1000" }),
  },
  oracle_challenged: {
    decode: decodeOracleChallengedEvent,
    expected: () => ({
      market_id: 3,
      challenger: BETTOR,
      outcome: "yes",
      bond: "2000",
      submitter: SUBMITTER,
      submitter_bond: "1000",
      challenged_at: new Date(1798675000 * 1000),
    }),
  },
  oracle_escalated: {
    decode: decodeOracleEscalatedEvent,
    expected: () => ({
      market_id: 3,
      submitter: SUBMITTER,
      challenger: BETTOR,
      outcome: "yes",
      total_bond: "3000",
      escalated_at: new Date(1798675001 * 1000),
      council_deadline: new Date(1798675201 * 1000),
    }),
  },
  referral_registered: {
    decode: decodeReferralRegisteredEvent,
    expected: () => ({
      user: REFEREE,
      display_name: "StellarAce",
      referrer: REFERRER,
      welcome_points: 5,
      referrer_points: 5,
    }),
  },
  referral_reward: {
    decode: decodeReferralRewardEvent,
    expected: () => ({ referrer: REFERRER, points: 3 }),
  },
  reward_claimed: {
    decode: decodeClaim,
    expected: () => ({ market_id: 3, user: BETTOR, payout_xlm: 2500000 }),
  },
  fees_withdrawn: {
    decode: decodeFeeWithdrawn,
    expected: () => ({ admin: CREATOR, amount: "12000000" }),
  },
  reward_points: {
    decode: decodeRewardPoints,
    expected: () => ({ user: BETTOR, points: 25, is_winner: true }),
  },
  token_mint: {
    decode: decodeTokenMint,
    expected: () => ({ to: TOKEN_RECIPIENT, amount: "1000000000" }),
  },
};

describe("decoded event fixtures feed the handler decoders", () => {
  for (const [name, { decode, expected }] of Object.entries(handlerDecoders)) {
    it(`normalises ${name} into the handler payload`, () => {
      const fixture = decodedEvents[name as keyof typeof decodedEvents];
      expect(fixture).toBeDefined();

      const fixtureEvent: Pick<DecodedEventFixture, "topics" | "data"> = {
        topics: fixture.topics,
        data: fixture.data,
      };

      expect(decode(fixtureEvent)).toEqual(expected(fixture));
    });
  }
});

describe("DecodedEvent type compatibility", () => {
  it("decoded fixtures satisfy the DecodedEvent contract used by dispatch", () => {
    const first: DecodedEvent = {
      type: decodedEvents.market_created.topics[0],
      subtype: decodedEvents.market_created.topics[1] ?? undefined,
      data: decodedEvents.market_created.data,
    };
    expect(first.type).toBe("mkt");
    expect(first.subtype).toBe("created");
  });
});