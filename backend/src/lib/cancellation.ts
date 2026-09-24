import type { FastifyInstance } from "fastify";

/**
 * Client-disconnect detection — issue #475.
 *
 * When a client goes away mid-request, the handler and its in-flight DB
 * query would otherwise run to completion for nobody. This hook exposes an
 * `AbortSignal` on every request (`request.abortSignal`) that fires the
 * moment the underlying socket closes before the response was sent, so a
 * route handler can pass it into `queryWithCancel` (db/pool.ts) and have the
 * query actually cancelled at the Postgres level rather than merely
 * ignored.
 *
 * Node's `http.ServerResponse` emits `close` both when the client
 * disconnects early *and* after a normal response finishes writing. The
 * `writableEnded` check is what tells those two cases apart — only the
 * former is a disconnect worth abandoning work for.
 */

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Aborts once the client disconnects before the response finished.
     * Pass this into `queryWithCancel` for read-only queries whose result
     * would otherwise be thrown away. Never wire this into a
     * `withTransaction` write path (see db/tx.ts) — see the comment there.
     */
    abortSignal: AbortSignal;
  }
}

export function registerCancellationHook(app: FastifyInstance): void {
  app.decorateRequest("abortSignal", null);

  app.addHook("onRequest", async (request, reply) => {
    const controller = new AbortController();
    request.abortSignal = controller.signal;

    const onClose = () => {
      if (!reply.raw.writableEnded) {
        controller.abort();
      }
    };

    reply.raw.once("close", onClose);
    // The response finished normally — 'close' will still fire afterwards,
    // but by then writableEnded is true and onClose is a no-op anyway; drop
    // the listener regardless so it isn't kept alive for no reason.
    reply.raw.once("finish", () => {
      reply.raw.removeListener("close", onClose);
    });
  });
}
