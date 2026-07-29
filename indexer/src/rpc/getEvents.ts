import { rpc } from "@stellar/stellar-sdk";
import type { RpcClient, RpcEvent } from "../poll-loop.js";

export class LedgerGapError extends Error {
  constructor(public readonly startLedger: number, message: string) {
    super(message);
    this.name = "LedgerGapError";
  }
}

export class SorobanRpcClient implements RpcClient {
  private readonly server: rpc.Server;

  constructor(rpcUrl: string) {
    this.server = new rpc.Server(rpcUrl);
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
}
