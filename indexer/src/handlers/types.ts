export interface DecodedEvent {
  ledger: number | bigint;
  txHash: string;
  eventIndex?: number | bigint;
  topics: unknown[];
  data: unknown;
}

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface CacheClient {
  del(...keys: string[]): Promise<unknown>;
}

export interface Logger {
  warn(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface HandlerContext {
  db: Queryable;
  redis?: CacheClient;
  logger: Logger;
}

export type EventHandler = (event: DecodedEvent, context: HandlerContext) => Promise<void>;
