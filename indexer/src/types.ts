export interface DbClient {
  query<T = unknown>(text: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

export interface RedisClient {
  del(...keys: string[]): Promise<number> | number;
}

export interface DecodedContractEvent {
  topics: readonly unknown[];
  data: unknown;
  ledger: number;
  txHash: string;
}
