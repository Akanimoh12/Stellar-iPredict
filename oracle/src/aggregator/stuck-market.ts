export interface StuckMarketAlert {
  marketId: string;
  endTime: number;
  hoursPastExpiry: number;
  stuck: boolean;
}

/**
 * Flags markets that have been expired for more than `maxHours` without
 * reaching quorum (i.e. still unresolved and not cancelled).
 *
 * `endTime` is the market's expiry as a Unix timestamp in seconds.
 * `nowSeconds` is the current Unix timestamp in seconds.
 */
export function detectStuckMarket(
  marketId: string,
  endTime: number,
  nowSeconds: number,
  maxHours: number,
): StuckMarketAlert {
  if (maxHours <= 0) {
    throw new RangeError("maxHours must be a positive number");
  }

  const elapsedSeconds = nowSeconds - endTime;
  const hoursPastExpiry = elapsedSeconds > 0 ? elapsedSeconds / 3_600 : 0;
  const stuck = hoursPastExpiry >= maxHours;

  return { marketId, endTime, hoursPastExpiry, stuck };
}

export interface StuckMarketInput {
  id: string;
  endTime: number;
  cancelled: boolean;
}

/**
 * Scans a list of expired, unresolved markets and returns alerts for any that
 * have exceeded the staleness window. Cancelled markets are excluded.
 */
export function detectStuckMarkets(
  markets: readonly StuckMarketInput[],
  nowSeconds: number,
  maxHours: number,
): StuckMarketAlert[] {
  const alerts: StuckMarketAlert[] = [];
  for (const market of markets) {
    if (market.cancelled) continue;
    const alert = detectStuckMarket(market.id, market.endTime, nowSeconds, maxHours);
    if (alert.stuck) alerts.push(alert);
  }
  return alerts;
}
