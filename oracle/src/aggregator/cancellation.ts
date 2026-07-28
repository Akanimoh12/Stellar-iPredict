import type { Logger } from "../log.js";

export interface MarketResolutionState {
  cancelled: boolean;
  resolved: boolean;
}

export type FinalizationResult =
  | "finalized"
  | "cancelled"
  | "already-resolved"
  | "below-threshold"
  | "already-processing";

/**
 * Coordinates cancellation-safe finalization. State is read both before vote
 * aggregation and immediately before submission so a cancellation racing with
 * aggregation cannot be finalized.
 */
export class CancellationAwareFinalizer {
  private readonly claimed = new Set<string>();
  private readonly finalized = new Set<string>();

  constructor(private readonly logger?: Logger) {}

  async finalize(
    marketId: string,
    getState: (marketId: string) => Promise<MarketResolutionState>,
    getAgreedOutcome: (marketId: string) => Promise<boolean | null>,
    submit: (marketId: string, outcome: boolean) => Promise<void>,
  ): Promise<FinalizationResult> {
    const decide = (result: FinalizationResult, extra?: Record<string, unknown>): FinalizationResult => {
      this.logger?.info("finalization decision", { marketId, decision: result, ...extra });
      return result;
    };

    if (this.finalized.has(marketId)) return decide("already-resolved");
    if (this.claimed.has(marketId)) return decide("already-processing");

    this.claimed.add(marketId);
    try {
      const initial = await getState(marketId);
      if (initial.cancelled) return decide("cancelled");
      if (initial.resolved) {
        this.finalized.add(marketId);
        return decide("already-resolved");
      }

      const outcome = await getAgreedOutcome(marketId);
      if (outcome === null) return decide("below-threshold");

      const current = await getState(marketId);
      if (current.cancelled) return decide("cancelled");
      if (current.resolved) {
        this.finalized.add(marketId);
        return decide("already-resolved");
      }

      await submit(marketId, outcome);
      this.finalized.add(marketId);
      return decide("finalized", { outcome });
    } finally {
      this.claimed.delete(marketId);
    }
  }
}
