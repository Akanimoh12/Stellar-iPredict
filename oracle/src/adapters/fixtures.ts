import type { AdapterOutcome, DataAdapter, Market } from "./index.js";

export interface AdapterFixture {
  version: 1;
  adapterId: string;
  market: Market;
  outcome: AdapterOutcome;
  recordedAt: string;
}

export interface FixtureSink {
  write(fixture: AdapterFixture): Promise<void>;
}

/** Records successful, already-redacted adapter results through an injected persistence sink. */
export class RecordingAdapter implements DataAdapter {
  readonly id: string;
  constructor(private readonly adapter: DataAdapter, private readonly sink: FixtureSink) {
    this.id = adapter.id;
  }
  supports(market: Market): boolean { return this.adapter.supports(market); }
  checkHealth() { return this.adapter.checkHealth?.() ?? Promise.reject(new Error("health check not implemented")); }
  async fetchOutcome(market: Market): Promise<AdapterOutcome> {
    const outcome = await this.adapter.fetchOutcome(market);
    await this.sink.write({ version: 1, adapterId: this.id, market, outcome, recordedAt: new Date().toISOString() });
    return outcome;
  }
}

/** Replays captured provider output without network access or quota usage. */
export class FixtureReplayAdapter implements DataAdapter {
  readonly id: string;
  constructor(private readonly fixture: AdapterFixture) { this.id = fixture.adapterId; }
  supports(market: Market): boolean {
    return market.category === this.fixture.market.category && market.id === this.fixture.market.id;
  }
  async fetchOutcome(market: Market): Promise<AdapterOutcome> {
    if (!this.supports(market)) throw new Error(`Fixture ${this.id} does not match market ${market.id}`);
    return structuredClone(this.fixture.outcome);
  }
}
