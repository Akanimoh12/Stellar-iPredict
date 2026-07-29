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

  async finalize(
    marketId: string,
    getState: (marketId: string) => Promise<MarketResolutionState>,
    getAgreedOutcome: (marketId: string) => Promise<boolean | null>,
    submit: (marketId: string, outcome: boolean) => Promise<void>,
  ): Promise<FinalizationResult> {
    if (this.finalized.has(marketId)) return "already-resolved";
    if (this.claimed.has(marketId)) return "already-processing";

    this.claimed.add(marketId);
    try {
      const initial = await getState(marketId);
      if (initial.cancelled) return "cancelled";
      if (initial.resolved) {
        this.finalized.add(marketId);
        return "already-resolved";
      }

      const outcome = await getAgreedOutcome(marketId);
      if (outcome === null) return "below-threshold";

      const current = await getState(marketId);
      if (current.cancelled) return "cancelled";
      if (current.resolved) {
        this.finalized.add(marketId);
        return "already-resolved";
      }

      await submit(marketId, outcome);
      this.finalized.add(marketId);
      return "finalized";
    } finally {
      this.claimed.delete(marketId);
    }
  }
}
