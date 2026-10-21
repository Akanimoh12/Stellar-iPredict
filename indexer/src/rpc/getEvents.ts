import { rpc } from "@stellar/stellar-sdk";
import type { RpcClient, RpcEvent } from "../poll-loop.js";
import { metrics } from "../metrics.js";
import { makeContractFilter } from "../contract-filter.js";
import { PermanentError, unwrapError } from "@ipredict/shared";
import type { Logger } from "../log.js";

export interface UnavailableLedgerRange {
  fromLedger: number;
  toLedger: number;
}

/**
 * A gap in the node's event history.
 *
 * Extends {@link PermanentError} so the shared retry utility classifies it as
 * permanent by *type* — retrying a gap would only waste time and hammer the
 * node, and a message-sniffing check would break the moment the SDK rewords
 * its error.
 */
export class LedgerGapError extends PermanentError {
  public readonly oldestLedger?: number | null;
  public readonly unavailableRange?: UnavailableLedgerRange | null;

  constructor(
    public readonly startLedger: number,
    message: string,
    oldestLedger?: number | null,
    unavailableRange?: UnavailableLedgerRange | null,
  ) {
    super(message);
    this.name = "LedgerGapError";
    this.oldestLedger = oldestLedger ?? null;
    this.unavailableRange = unavailableRange ?? null;
  }
}

export class RetentionExceededError extends LedgerGapError {
  constructor(
    startLedger: number,
    oldestLedger: number | null,
    message: string,
    unavailableRange: UnavailableLedgerRange | null = null,
  ) {
    super(startLedger, message, oldestLedger, unavailableRange);
    this.name = "RetentionExceededError";
  }
}

export const DEFAULT_RETENTION_ALERT_THRESHOLD = 17280; // ~24 hours of ledgers at 5s cadence

export function isRetentionExceededError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof RetentionExceededError) return true;
  // The error may arrive wrapped by the retry utility, so look through the
  // cause chain before reading the message.
  const target = unwrapError(err);
  if (target instanceof RetentionExceededError) return true;
  const msg = target instanceof Error ? target.message : String(target);
  return (
    (/startLedger/i.test(msg) &&
      (/oldest/i.test(msg) ||
        /less than/i.test(msg) ||
        /too old/i.test(msg) ||
        /retention/i.test(msg) ||
        /boundary/i.test(msg) ||
        /history/i.test(msg))) ||
    /retention window/i.test(msg) ||
    /ledger retention/i.test(msg)
  );
}

export function extractOldestLedger(message: string): number | null {
  const match = message.match(/oldest(?:[^\d]+)?(\d+)/i) ?? message.match(/retention[^\d]+(\d+)/i);
  if (match && match[1]) {
    const val = parseInt(match[1], 10);
    return isNaN(val) ? null : val;
  }
  return null;
}

export function formatRetentionExceededMessage(
  startLedger: number,
  oldestLedger: number | null,
): { message: string; unavailableRange: UnavailableLedgerRange | null } {
  let unavailableRange: UnavailableLedgerRange | null = null;
  let rangeDesc = "unknown";

  if (oldestLedger !== null && oldestLedger > startLedger) {
    unavailableRange = { fromLedger: startLedger, toLedger: oldestLedger - 1 };
    rangeDesc = `[${unavailableRange.fromLedger}..${unavailableRange.toLedger}] (${oldestLedger - startLedger} ledgers unavailable: ${unavailableRange.fromLedger} to ${unavailableRange.toLedger})`;
  } else if (oldestLedger !== null) {
    rangeDesc = `[${startLedger}..${oldestLedger}]`;
  }

  const message =
    `CRITICAL: startLedger (${startLedger}) is older than the oldest ledger (${oldestLedger ?? "unknown"}) stored on the RPC node. ` +
    `Unavailable ledger range: ${rangeDesc}. ` +
    `A ledger retention gap has occurred. Recovery path: Please re-backfill from a snapshot or run ` +
    `a leaderboard rebuild using 'npm run rebuild:leaderboard --since-ledger <ledger>'.`;

  return { message, unavailableRange };
}

export interface RetentionBoundaryStatus {
  latestLedger: number;
  oldestLedger: number;
  retentionWindow: number;
  distanceToRetention: number;
  isApproachingRetention: boolean;
  thresholdLedgers: number;
}

export async function checkRetentionBoundary(
  server: rpc.Server | { getHealth?: () => Promise<any> },
  currentLedger: number,
  thresholdLedgers = DEFAULT_RETENTION_ALERT_THRESHOLD,
  logger?: Logger,
): Promise<RetentionBoundaryStatus | null> {
  if (typeof (server as any).getHealth !== "function") {
    return null;
  }

  try {
    const health = await (server as any).getHealth();
    const oldestLedger = Number(health.oldestLedger);
    const latestLedger = Number(health.latestLedger);
    const retentionWindow = Number(health.ledgerRetentionWindow);

    if (isNaN(oldestLedger)) return null;

    const distanceToRetention = currentLedger - oldestLedger;
    const isApproaching = distanceToRetention >= 0 && distanceToRetention <= thresholdLedgers;

    if (isApproaching) {
      const alertMsg =
        `ALERT: Approaching Soroban RPC retention boundary! ` +
        `Current ledger: ${currentLedger}, oldest retained ledger: ${oldestLedger}. ` +
        `Margin: ${distanceToRetention} ledgers remaining until data loss. ` +
        `Act immediately to ensure indexing catches up before events are purged.`;
      logger?.warn?.(alertMsg, { currentLedger, oldestLedger, distanceToRetention, thresholdLedgers });
      console.warn(alertMsg);
    }

    return {
      latestLedger,
      oldestLedger,
      retentionWindow,
      distanceToRetention,
      isApproachingRetention: isApproaching,
      thresholdLedgers,
    };
  } catch (err) {
    logger?.debug?.("Failed to check RPC health for retention boundary", { err });
    return null;
  }
}

export const DEFAULT_RPC_FAILOVER_COOLDOWN_MS = 30_000;

export interface RpcEndpointStatus {
  url: string;
  healthy: boolean;
  consecutiveFailures: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
}

export interface SorobanRpcClientOptions {
  cooldownMs?: number;
}

interface EndpointInternal extends RpcEndpointStatus {
  server: rpc.Server;
}

export class SorobanRpcClient implements RpcClient {
  public server: rpc.Server;
  private readonly endpoints: EndpointInternal[];
  private readonly contractFilter: (contractId: string) => boolean;
  private readonly logger?: Logger;
  private readonly cooldownMs: number;
  private activeEndpointIndex = 0;

  constructor(
    rpcUrls: string | string[],
    allowedContractIds: string[] = [],
    logger?: Logger,
    options?: SorobanRpcClientOptions,
  ) {
    const rawList = Array.isArray(rpcUrls) ? rpcUrls : [rpcUrls];
    const parsed = rawList
      .flatMap((u) => (typeof u === "string" ? u.split(",") : []))
      .map((u) => u.trim())
      .filter((u) => u.length > 0);

    const urls = parsed.length > 0 ? parsed : ["http://localhost:8000"];

    this.cooldownMs =
      options?.cooldownMs ?? Number(process.env.RPC_FAILOVER_COOLDOWN_MS ?? DEFAULT_RPC_FAILOVER_COOLDOWN_MS);
    this.endpoints = urls.map((url) => ({
      url,
      server: new rpc.Server(url, { allowHttp: true }),
      healthy: true,
      consecutiveFailures: 0,
      lastFailureTime: null,
      lastSuccessTime: null,
    }));
    this.server = this.endpoints[0].server;
    this.contractFilter = makeContractFilter(allowedContractIds, logger);
    this.logger = logger;
  }

  getEndpoints(): string[] {
    return this.endpoints.map((ep) => ep.url);
  }

  getActiveEndpoint(): string {
    return this.endpoints[this.activeEndpointIndex]?.url ?? this.endpoints[0]?.url ?? "";
  }

  getEndpointHealth(): RpcEndpointStatus[] {
    return this.endpoints.map(({ url, healthy, consecutiveFailures, lastFailureTime, lastSuccessTime }) => ({
      url,
      healthy,
      consecutiveFailures,
      lastFailureTime,
      lastSuccessTime,
    }));
  }

  resetEndpointHealth(): void {
    for (const ep of this.endpoints) {
      ep.healthy = true;
      ep.consecutiveFailures = 0;
      ep.lastFailureTime = null;
    }
    this.activeEndpointIndex = 0;
  }

  async getEvents(opts: {
    startLedger: number;
    contractIds: string[];
    limit?: number;
  }): Promise<{ events: RpcEvent[]; latestLedger: number }> {
    const { startLedger, contractIds, limit = 100 } = opts;

    const filters = [
      {
        type: "contract" as const,
        contractIds,
      },
    ];

    // Priority order:
    // 1. Healthy endpoints in list order
    // 2. Unhealthy endpoints whose cooldown has elapsed
    // 3. Fallback to all endpoints in list order
    const now = Date.now();
    let eligible = this.endpoints.filter(
      (ep) => ep.healthy || (ep.lastFailureTime !== null && now - ep.lastFailureTime >= this.cooldownMs),
    );
    if (eligible.length === 0) {
      eligible = [...this.endpoints];
    }

    let lastError: unknown;
    let lastRetentionError: RetentionExceededError | null = null;

    for (let i = 0; i < eligible.length; i++) {
      const endpoint = eligible[i];
      const activeServer =
        this.server && this.server !== this.endpoints[0]?.server && i === 0 ? this.server : endpoint.server;

      try {
        const allEvents: RpcEvent[] = [];
        let latestLedger = 0;
        let cursor: string | undefined;

        do {
          const request = cursor
            ? { filters, cursor, limit }
            : { filters, startLedger, limit };

          const response = await activeServer.getEvents(request as any);

          latestLedger = response.latestLedger;

          // Filter events BEFORE decoding to prevent processing unknown contracts
          for (const ev of response.events as any[]) {
            const contractId = ev.contractId?.toString() ?? "";

            // Reject events from unknown contracts
            if (!this.contractFilter(contractId)) {
              this.logger?.warn("rejected event from unconfigured contract", {
                contractId,
                ledger: Number(ev.ledger),
                type: ev.type,
              });
              continue;
            }

            allEvents.push({
              contractId,
              ledger: Number(ev.ledger),
              type: ev.type,
              body: ev,
            });
          }

          cursor = response.cursor;
        } while (cursor);

        // Success: mark endpoint healthy
        endpoint.healthy = true;
        endpoint.consecutiveFailures = 0;
        endpoint.lastSuccessTime = Date.now();
        this.activeEndpointIndex = this.endpoints.indexOf(endpoint);

        return {
          events: allEvents,
          latestLedger,
        };
      } catch (error: any) {
        metrics.rpcErrors.inc({ service: "indexer", operation: "getEvents" });
        endpoint.consecutiveFailures++;
        endpoint.lastFailureTime = Date.now();
        endpoint.healthy = false;
        lastError = error;

        const message = error instanceof Error ? error.message : String(error);

        if (isRetentionExceededError(error)) {
          const oldestLedger = extractOldestLedger(message);
          const { message: remediationMessage, unavailableRange } = formatRetentionExceededMessage(
            startLedger,
            oldestLedger,
          );
          lastRetentionError = new RetentionExceededError(
            startLedger,
            oldestLedger,
            remediationMessage,
            unavailableRange,
          );
        }

        const nextEndpoint = eligible[i + 1];
        if (nextEndpoint) {
          this.logger?.warn("RPC endpoint failed, failing over to next endpoint", {
            failedUrl: endpoint.url,
            nextUrl: nextEndpoint.url,
            error: message,
          });
        }
      }
    }

    // All eligible endpoints failed
    if (lastRetentionError) {
      this.logger?.error(lastRetentionError.message, {
        startLedger,
        oldestLedger: lastRetentionError.oldestLedger,
        unavailableRange: lastRetentionError.unavailableRange,
      });
      console.error(lastRetentionError.message);
      throw lastRetentionError;
    }

    throw lastError;
  }
}
