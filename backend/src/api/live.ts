/**
 * Real-time Server-Sent Events (SSE) feed for live market updates — issue #1014.
 *
 * Eliminates the need for aggressive client-side polling by pushing odds, pool,
 * and state updates over an HTTP event-stream connection.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import type { Queryable } from "../db/markets.js";
import { getMarketById, getMarkets } from "../db/markets.js";

export interface MarketLiveUpdate {
  marketId: number;
  totalYes: string | number;
  totalNo: string | number;
  totalPool: string | number;
  yesPercent: number;
  noPercent: number;
  betCount?: number;
  resolved?: boolean;
  outcome?: boolean | null;
  cancelled?: boolean;
  timestamp?: number;
}

interface Subscriber {
  id: string;
  marketId?: number; // undefined = subscribed to all markets
  reply: FastifyReply;
}

class LiveMarketHub {
  private subscribers = new Map<string, Subscriber>();
  private keepAliveTimer: NodeJS.Timeout | null = null;

  constructor() {
    // 15-second heartbeat to prevent idle gateway/proxy timeouts
    this.keepAliveTimer = setInterval(() => {
      this.sendHeartbeat();
    }, 15000);
    if (this.keepAliveTimer.unref) {
      this.keepAliveTimer.unref();
    }
  }

  public addSubscriber(id: string, reply: FastifyReply, marketId?: number): void {
    this.subscribers.set(id, { id, reply, marketId });
  }

  public removeSubscriber(id: string): void {
    this.subscribers.delete(id);
  }

  public getSubscriberCount(): number {
    return this.subscribers.size;
  }

  public broadcast(update: MarketLiveUpdate): void {
    const payload = JSON.stringify({
      ...update,
      timestamp: update.timestamp ?? Date.now(),
    });
    const message = `event: market_update\ndata: ${payload}\n\n`;

    for (const [id, sub] of this.subscribers.entries()) {
      if (sub.marketId === undefined || sub.marketId === update.marketId) {
        try {
          sub.reply.raw.write(message);
        } catch {
          this.subscribers.delete(id);
        }
      }
    }
  }

  private sendHeartbeat(): void {
    const ping = `: ping ${Date.now()}\n\n`;
    for (const [id, sub] of this.subscribers.entries()) {
      try {
        sub.reply.raw.write(ping);
      } catch {
        this.subscribers.delete(id);
      }
    }
  }

  public destroy(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    this.subscribers.clear();
  }
}

export const liveMarketHub = new LiveMarketHub();

export function broadcastMarketUpdate(update: MarketLiveUpdate): void {
  liveMarketHub.broadcast(update);
}

function calculateOdds(totalYes: number, totalNo: number): { yesPercent: number; noPercent: number } {
  const total = totalYes + totalNo;
  if (total <= 0) return { yesPercent: 50, noPercent: 50 };
  const yesPercent = Math.round((totalYes / total) * 100);
  return { yesPercent, noPercent: 100 - yesPercent };
}

export function registerLiveMarketRoutes(
  server: FastifyInstance,
  pool?: Pool | Queryable,
  _redis?: Redis
): void {
  // ── GET /api/markets/live (All Markets Feed) ──────────────────────────────
  server.get(
    "/api/markets/live",
    {
      schema: {
        summary: "Live Server-Sent Events stream for all market odds and pool updates",
        tags: ["markets"],
        response: {
          200: {
            type: "string",
            description: "Server-Sent Events event stream",
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const subId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      liveMarketHub.addSubscriber(subId, reply);

      // Send initial connection event
      reply.raw.write(`event: connected\ndata: ${JSON.stringify({ status: "connected", subId })}\n\n`);

      // Push initial active snapshot if database is available
      if (pool) {
        try {
          const res = await getMarkets({ filter: "active", limit: 20 }, pool);
          for (const m of res.rows) {
            const yes = parseFloat(m.total_yes) || 0;
            const no = parseFloat(m.total_no) || 0;
            const odds = calculateOdds(yes, no);
            const snapshot: MarketLiveUpdate = {
              marketId: m.id,
              totalYes: m.total_yes,
              totalNo: m.total_no,
              totalPool: (yes + no).toFixed(7),
              yesPercent: odds.yesPercent,
              noPercent: odds.noPercent,
              betCount: m.bet_count,
              resolved: m.resolved,
              outcome: m.outcome,
              cancelled: m.cancelled,
            };
            reply.raw.write(`event: market_snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
          }
        } catch {
          // If query fails, stream remains open for live pushes
        }
      }

      request.raw.on("close", () => {
        liveMarketHub.removeSubscriber(subId);
      });
    }
  );

  // ── GET /api/markets/:id/live (Single Market Feed) ────────────────────────
  server.get<{ Params: { id: string } }>(
    "/api/markets/:id/live",
    {
      schema: {
        summary: "Live Server-Sent Events stream for a specific market",
        tags: ["markets"],
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
        response: {
          200: {
            type: "string",
            description: "Server-Sent Events event stream",
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const marketId = parseInt(request.params.id, 10);
      if (isNaN(marketId) || marketId < 1) {
        return reply.status(400).send({ error: "Invalid market ID" });
      }

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const subId = `${marketId}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      liveMarketHub.addSubscriber(subId, reply, marketId);

      reply.raw.write(
        `event: connected\ndata: ${JSON.stringify({ status: "connected", marketId, subId })}\n\n`
      );

      // Send initial snapshot for this specific market
      if (pool) {
        try {
          const m = await getMarketById(marketId, pool);
          if (m) {
            const yes = parseFloat(m.total_yes) || 0;
            const no = parseFloat(m.total_no) || 0;
            const odds = calculateOdds(yes, no);
            const snapshot: MarketLiveUpdate = {
              marketId: m.id,
              totalYes: m.total_yes,
              totalNo: m.total_no,
              totalPool: (yes + no).toFixed(7),
              yesPercent: odds.yesPercent,
              noPercent: odds.noPercent,
              betCount: m.bet_count,
              resolved: m.resolved,
              outcome: m.outcome,
              cancelled: m.cancelled,
            };
            reply.raw.write(`event: market_snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
          }
        } catch {
          // If query fails, stream remains open for live pushes
        }
      }

      request.raw.on("close", () => {
        liveMarketHub.removeSubscriber(subId);
      });
    }
  );
}
