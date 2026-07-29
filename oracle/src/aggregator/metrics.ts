/**
 * Tracks aggregator performance metrics — primarily the lag between a
 * market's expiry (`endTime`) and its actual resolution timestamp.
 *
 * All timestamps are Unix seconds.
 */

export interface ResolutionLagEntry {
  marketId: string;
  endTime: number;
  resolvedAt: number;
  /** Hours from expiry to resolution (negative if resolved before expiry). */
  lagHours: number;
}

export interface AggregatorMetricsSnapshot {
  /** Total markets that have been resolved through the aggregator. */
  totalResolved: number;
  /** Average resolution lag in hours across all resolved markets. */
  averageLagHours: number;
  /** Maximum resolution lag in hours (worst case). */
  maxLagHours: number;
  /** Minimum resolution lag in hours (best case). */
  minLagHours: number;
  /** Individual entries, most recent first. */
  entries: readonly ResolutionLagEntry[];
}

export class AggregatorMetrics {
  private readonly entries: ResolutionLagEntry[] = [];

  /**
   * Record a resolution event.
   *
   * @param marketId  - unique market identifier
   * @param endTime   - market expiry Unix timestamp (seconds)
   * @param resolvedAt - moment the resolution was submitted (seconds)
   */
  recordResolution(marketId: string, endTime: number, resolvedAt: number): ResolutionLagEntry {
    const lagSeconds = resolvedAt - endTime;
    const lagHours = lagSeconds / 3_600;
    const entry: ResolutionLagEntry = { marketId, endTime, resolvedAt, lagHours };
    this.entries.push(entry);
    return entry;
  }

  /** Build a snapshot of all collected metrics. */
  snapshot(): AggregatorMetricsSnapshot {
    if (this.entries.length === 0) {
      return {
        totalResolved: 0,
        averageLagHours: 0,
        maxLagHours: 0,
        minLagHours: 0,
        entries: [],
      };
    }

    let sum = 0;
    let max = -Infinity;
    let min = Infinity;

    for (const entry of this.entries) {
      sum += entry.lagHours;
      if (entry.lagHours > max) max = entry.lagHours;
      if (entry.lagHours < min) min = entry.lagHours;
    }

    return {
      totalResolved: this.entries.length,
      averageLagHours: sum / this.entries.length,
      maxLagHours: max,
      minLagHours: min,
      entries: [...this.entries].reverse(),
    };
  }

  /** Number of resolutions recorded. */
  get totalResolved(): number {
    return this.entries.length;
  }

  /** Reset all recorded metrics. */
  reset(): void {
    this.entries.length = 0;
  }
}
