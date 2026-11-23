/**
 * Feature Flags for Progressive Rollout of Oracle Changes (#640)
 */

export interface FlagFilter {
  enabled: boolean;
  allowedProviders?: string[];
  allowedMarkets?: string[];
  percentageRollout?: number; // 0 to 100
}

export interface EvaluationContext {
  providerId?: string;
  marketId?: string;
}

export class FeatureFlagManager {
  private flags: Map<string, FlagFilter> = new Map();

  constructor(initialFlags: Record<string, FlagFilter> = {}) {
    for (const [name, filter] of Object.entries(initialFlags)) {
      this.flags.set(name, filter);
    }
  }

  setFlag(name: string, filter: FlagFilter): void {
    this.flags.set(name, filter);
  }

  isFlagEnabled(name: string, context?: EvaluationContext): boolean {
    const flag = this.flags.get(name);
    if (!flag || !flag.enabled) {
      return false; // Default safe behavior
    }

    // Provider-specific targeting
    if (flag.allowedProviders && flag.allowedProviders.length > 0) {
      if (!context?.providerId || !flag.allowedProviders.includes(context.providerId)) {
        return false;
      }
    }

    // Market-specific targeting
    if (flag.allowedMarkets && flag.allowedMarkets.length > 0) {
      if (!context?.marketId || !flag.allowedMarkets.includes(context.marketId)) {
        return false;
      }
    }

    return true;
  }

  getActiveFlagsForDecision(context?: EvaluationContext): string[] {
    const active: string[] = [];
    for (const [name] of this.flags.entries()) {
      if (this.isFlagEnabled(name, context)) {
        active.push(name);
      }
    }
    return active;
  }
}

export const oracleFeatureFlags = new FeatureFlagManager();
