export interface Queryable {
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface Closable {
  end(): Promise<void>;
}
