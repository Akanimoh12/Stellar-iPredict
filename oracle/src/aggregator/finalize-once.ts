export type FinalizedLookup = (marketId: string) => Promise<boolean>;
export type FinalizeSubmission = (marketId: string) => Promise<void>;

/**
 * Serializes finalization per market and remembers successful submissions.
 *
 * `isAlreadyFinalized` must read the durable DB/on-chain state, which protects
 * across process restarts. The in-memory claim closes the race between
 * concurrent loop iterations inside this process.
 */
export class FinalizationGuard {
  private readonly claimed = new Set<string>();
  private readonly finalized = new Set<string>();

  async runOnce(
    marketId: string,
    isAlreadyFinalized: FinalizedLookup,
    submit: FinalizeSubmission,
  ): Promise<boolean> {
    if (!marketId.trim()) throw new Error("marketId is required");
    if (this.claimed.has(marketId) || this.finalized.has(marketId)) return false;

    this.claimed.add(marketId);
    try {
      if (await isAlreadyFinalized(marketId)) {
        this.finalized.add(marketId);
        return false;
      }

      await submit(marketId);
      this.finalized.add(marketId);
      return true;
    } finally {
      this.claimed.delete(marketId);
    }
  }

  hasFinalized(marketId: string): boolean {
    return this.finalized.has(marketId);
  }
}
