import { rpc } from "@stellar/stellar-sdk";
import type { RpcClient, RpcEvent } from "../poll-loop.js";
import { EndpointPool, type Logger as PoolLogger } from "./endpoint-pool.js";
import { metrics } from "../metrics.js";

export class LedgerGapError extends Error {
  constructor(public readonly startLedger: number, message: string) {
    super(message);
    this.name = "LedgerGapError";
  }
}

/**
 * Soroban RPC client with automatic endpoint failover and ledger monotonicity
 * enforcement.
 *
 * The monotonicity rule ensures the indexer never processes events out of order
 * or regresses to an earlier ledger. Before using an endpoint, this client
 * verifies that endpoint's latest ledger is at least as far along as the
 * requested startLedger.
 */
export class SorobanRpcClient implements RpcClient {
  private readonly pool: EndpointPool;
  private readonly singleEndpointUrl?: string;

  constructor(rpcUrls: string[], logger?: PoolLogger) {
    if (rpcUrls.length === 1) {
      // Single endpoint — no pool needed, use direct connection
      this.singleEndpointUrl = rpcUrls[0];
      this.pool = null as any; // Won't be used
      // Set metric to -1 to indicate single endpoint mode
      metrics.activeRpcEndpointIndex.set(-1);
    } else {
      // Multiple endpoints — use failover pool
      this.pool = new EndpointPool({
        endpoints: rpcUrls,
        logger,
        onActiveEndpointChanged: (index) => {
          // Update metric when active endpoint changes
          metrics.activeRpcEndpointIndex.set(index);
        },
      });
    }
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

    if (this.singleEndpointUrl) {
      // Single endpoint path — no failover logic
      return this.fetchEventsFromEndpoint(this.singleEndpointUrl, startLedger, filters, limit);
    }

    // Multi-endpoint path with failover and monotonicity enforcement
    return this.pool.withFailover(async (server, url) => {
      // Enforce monotonicity: only use this endpoint if its latest ledger >= startLedger
      const { sequence: latestLedger } = await server.getLatestLedger();
      
      if (latestLedger < startLedger) {
        throw new Error(
          `Endpoint ${url} is behind (latest=${latestLedger}, need=${startLedger}). ` +
          `Will try next endpoint to enforce monotonicity.`
        );
      }

      return this.fetchEventsFromEndpoint(url, startLedger, filters, limit);
    });
  }

  private async fetchEventsFromEndpoint(
    url: string,
    startLedger: number,
    filters: any[],
    limit: number
  ): Promise<{ events: RpcEvent[]; latestLedger: number }> {
    const server = new rpc.Server(url);

    try {
      const allEvents: RpcEvent[] = [];
      let latestLedger = 0;
      let cursor: string | undefined;

      do {
        const request = cursor
          ? { filters, cursor, limit }
          : { filters, startLedger, limit };

        const response = await server.getEvents(request as any);

        latestLedger = response.latestLedger;

        const mappedEvents: RpcEvent[] = (response.events as any[]).map((ev) => ({
          contractId: ev.contractId?.toString() ?? "",
          ledger: Number(ev.ledger),
          type: ev.type,
          body: ev,
        }));

        allEvents.push(...mappedEvents);
        cursor = response.cursor;
      } while (cursor);

      return {
        events: allEvents,
        latestLedger,
      };
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);

      const isStartLedgerTooOld =
        /startLedger/i.test(message) &&
        (/oldest/i.test(message) || /less than/i.test(message) || /too old/i.test(message));

      if (isStartLedgerTooOld) {
        const remediationMessage =
          `CRITICAL: startLedger (${startLedger}) is older than the oldest ledger stored on the RPC node. ` +
          `A ledger reorg or gap has occurred. Recovery path: Please re-backfill from a snapshot or run ` +
          `a leaderboard rebuild using 'npm run rebuild:leaderboard --since-ledger <ledger>'.`;

        console.error(remediationMessage);
        throw new LedgerGapError(startLedger, remediationMessage);
      }

      throw error;
    }
  }

  /**
   * Stops the background primary probe timer (if using endpoint pool).
   */
  stop(): void {
    if (this.pool) {
      this.pool.stop();
    }
  }
}
