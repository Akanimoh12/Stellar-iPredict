/**
 * @ipredict/test-fixtures
 * 
 * Shared test fixtures for cross-service testing.
 * Provides consistent, type-safe builders for markets, bets, events, and other domain objects.
 * 
 * ## Usage
 * 
 * ### Simple fixtures with defaults:
 * ```ts
 * import { makeMarket, makeBet } from '@ipredict/test-fixtures';
 * 
 * const market = makeMarket({ id: 42, category: 'Sports' });
 * const bet = makeBet({ market_id: '42', is_yes: true });
 * ```
 * 
 * ### Builder pattern for complex objects:
 * ```ts
 * import { marketBuilder, betBuilder } from '@ipredict/test-fixtures';
 * 
 * const market = marketBuilder()
 *   .withId(42)
 *   .withCategory('Crypto')
 *   .active()
 *   .withVolume('1000', '500')
 *   .build();
 * 
 * const bet = betBuilder()
 *   .onMarket(42)
 *   .forYes()
 *   .by(TEST_ADDRESSES.BETTOR)
 *   .withAmount('100000000')
 *   .build();
 * ```
 * 
 * ### Common presets:
 * ```ts
 * import { MARKET_PRESETS, BET_PRESETS } from '@ipredict/test-fixtures';
 * 
 * const market = MARKET_PRESETS.activeCrypto();
 * const bet = BET_PRESETS.standardYes(market.id);
 * ```
 * 
 * ### Event fixtures for indexer tests:
 * ```ts
 * import { makeMarketCreatedEvent, makeBetPlacedEvent } from '@ipredict/test-fixtures';
 * 
 * const event = makeMarketCreatedEvent({ market_id: 7n, category: 'Sports' });
 * ```
 */

// Markets
export {
  makeMarket,
  type MarketFixtureOptions,
  marketBuilder,
  MarketBuilder,
  MARKET_PRESETS,
} from "./markets.js";

// Bets
export {
  makeBet,
  type BetFixtureOptions,
  betBuilder,
  BetBuilder,
  BET_PRESETS,
} from "./bets.js";

// Events
export {
  type DecodedEventFixture,
  CONTRACT_IDS,
  makeMarketCreatedEvent,
  type MarketCreatedEventData,
  makeMarketResolvedEvent,
  type MarketResolvedEventData,
  makeMarketCancelledEvent,
  type MarketCancelledEventData,
  makeBetPlacedEvent,
  type BetPlacedEventData,
  makeOracleSubmissionEvent,
  type OracleSubmissionEventData,
  makeOracleChallengedEvent,
  type OracleChallengedEventData,
  makeOracleFinalizedEvent,
  type OracleFinalizedEventData,
  makeReferralRegisteredEvent,
  type ReferralRegisteredEventData,
  EVENT_FIXTURES,
} from "./events.js";

// Addresses
export { TEST_ADDRESSES, generateAddress } from "./addresses.js";
