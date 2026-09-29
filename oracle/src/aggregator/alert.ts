/**
 * Oracle Alerting System (Issues #571, #569)
 * 
 * Centralized alerting for:
 * - Resolution lag (individual and aggregate)
 * - Stuck markets
 * - Circuit breaker state changes
 */

interface Alert {
  level: 'warning' | 'critical';
  type: 'resolution_lag' | 'stuck_market' | 'aggregate_lag' | 'circuit_breaker';
  message: string;
  context: Record<string, any>;
  timestamp: number;
}

// Issue #571: Alert thresholds
const THRESHOLDS = {
  RESOLUTION_LAG_WARNING_HOURS: 2,
  RESOLUTION_LAG_CRITICAL_HOURS: 6,
  AGGREGATE_LAG_WARNING_HOURS: 1,
  STUCK_MARKET_HOURS: 6,
};

/**
 * Alert when a market exceeds resolution lag threshold
 */
export function alertStuckMarket(marketId: string, lagHours: number): void {
  const alert: Alert = {
    level: lagHours >= THRESHOLDS.RESOLUTION_LAG_CRITICAL_HOURS ? 'critical' : 'warning',
    type: 'stuck_market',
    message: `Market ${marketId} stuck for ${lagHours.toFixed(1)} hours`,
    context: {
      marketId,
      lagHours,
      threshold: THRESHOLDS.STUCK_MARKET_HOURS,
    },
    timestamp: Date.now(),
  };
  
  sendAlert(alert);
}

/**
 * Alert when aggregate resolution lag degrades
 */
export function alertAggregateLag(avgLagHours: number, affectedMarkets: number): void {
  const alert: Alert = {
    level: avgLagHours >= THRESHOLDS.AGGREGATE_LAG_WARNING_HOURS ? 'warning' : 'critical',
    type: 'aggregate_lag',
    message: `Aggregate resolution lag: ${avgLagHours.toFixed(1)}h across ${affectedMarkets} markets`,
    context: {
      avgLagHours,
      affectedMarkets,
      threshold: THRESHOLDS.AGGREGATE_LAG_WARNING_HOURS,
    },
    timestamp: Date.now(),
  };
  
  sendAlert(alert);
}

/**
 * Alert when circuit breaker opens (Issue #569)
 */
export function alertCircuitBreakerOpen(adapterName: string, failureRate: number): void {
  const alert: Alert = {
    level: 'critical',
    type: 'circuit_breaker',
    message: `Circuit breaker OPEN for ${adapterName} (${(failureRate * 100).toFixed(1)}% failures)`,
    context: {
      adapter: adapterName,
      failureRate,
      impact: 'Multi-source guarantee weakened',
    },
    timestamp: Date.now(),
  };
  
  sendAlert(alert);
}

/**
 * Send alert to monitoring system
 */
function sendAlert(alert: Alert): void {
  // Log to console (replace with actual alerting system)
  console.error('[ALERT]', JSON.stringify(alert, null, 2));
  
  // TODO: Integrate with PagerDuty/Slack/etc
  // await fetch(ALERT_WEBHOOK_URL, { method: 'POST', body: JSON.stringify(alert) });
}

export { THRESHOLDS };
