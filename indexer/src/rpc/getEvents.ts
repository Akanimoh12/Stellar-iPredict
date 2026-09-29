import { rpc } from "@stellar/stellar-sdk";
import type { RpcClient, RpcEvent } from "../poll-loop.js";
import { metrics } from "../metrics.js";
import { makeContractFilter } from "../contract-filter.js";
import type { Logger } from "../log.js";

export interface UnavailableLedgerRange {
  fromLedger: number;
  toLedger: number;
}

export class LedgerGapError extends Error {
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
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /startLedger/i.test(msg) &&
    (/oldest/i.test(msg) ||
      /less than/i.test(msg) ||
      /too old/i.test(msg) ||
      /retention/i.test(msg) ||
      /boundary/i.test(msg) ||
      /history/i.test(msg))
  ) || /retention window/i.test(msg) || /ledger retention/i.test(msg);
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

export class SorobanRpcClient implements RpcClient {
  private readonly server: rpc.Server;
  private readonly contractFilter: (contractId: string) => boolean;
  private readonly logger?: Logger;

  constructor(rpcUrl: string, allowedContractIds: string[] = [], logger?: Logger) {
    this.server = new rpc.Server(rpcUrl, { allowHttp: true });
    this.contractFilter = makeContractFilter(allowedContractIds);
    this.logger = logger;
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

    try {
      const allEvents: RpcEvent[] = [];
      let latestLedger = 0;
      let cursor: string | undefined;

      do {
        const request = cursor
          ? { filters, cursor, limit }
          : { filters, startLedger, limit };

        const response = await this.server.getEvents(request as any);

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

      return {
        events: allEvents,
        latestLedger,
      };
    } catch (error: any) {
      metrics.rpcErrors.inc({ service: "indexer", operation: "getEvents" });
      const message = error instanceof Error ? error.message : String(error);

      if (isRetentionExceededError(error)) {
        const oldestLedger = extractOldestLedger(message);
        const { message: remediationMessage, unavailableRange } = formatRetentionExceededMessage(
          startLedger,
          oldestLedger,
        );

        this.logger?.error(remediationMessage, { startLedger, oldestLedger, unavailableRange });
        console.error(remediationMessage);
        throw new RetentionExceededError(startLedger, oldestLedger, remediationMessage, unavailableRange);
      }

      throw error;
    }
  }
}
