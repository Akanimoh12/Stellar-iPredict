import type { Market } from "./index.js";
import type { ResolutionResult, SourceResult } from "./resolve.js";

export type ReviewReason = "low_confidence" | "conflicting_outcomes";

export interface ManualReviewItem {
  id: string;
  market: Market;
  reason: ReviewReason;
  confidence: number;
  sources: SourceResult[];
  createdAt: string;
}

export interface ManualReviewQueue {
  enqueue(item: ManualReviewItem): Promise<void>;
}

/** Small default queue suitable for a single process; production can inject a durable implementation. */
export class InMemoryReviewQueue implements ManualReviewQueue {
  private readonly items = new Map<string, ManualReviewItem>();

  async enqueue(item: ManualReviewItem): Promise<void> {
    this.items.set(item.id, structuredClone(item));
  }

  list(): readonly ManualReviewItem[] {
    return [...this.items.values()].map((item) => structuredClone(item));
  }

  get(id: string): ManualReviewItem | undefined {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }
}

export function reviewItem(
  market: Market,
  reason: ReviewReason,
  result: ResolutionResult,
): ManualReviewItem {
  return {
    id: `${market.id}:${reason}`,
    market,
    reason,
    confidence: result.confidence,
    sources: result.sources,
    createdAt: new Date().toISOString(),
  };
}
