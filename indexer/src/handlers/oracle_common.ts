// Shared decode helpers for the optimistic-oracle event handlers
// (oracle_challenge.ts, oracle_finalized.ts). Field shapes come from
// docs/ORACLE_AND_BACKEND.md → "Oracle Event Topics" and the
// `OracleSubmittedEvent`/`OracleChallengedEvent`/`OracleEscalatedEvent`/
// `OracleFinalizedEvent` structs in contracts/prediction_market/src/lib.rs.

const STELLAR_ADDRESS = /^[GC][A-Z2-7]{55}$/;

export type RawData = Record<string, unknown>;

export function asRecord(data: unknown): RawData {
  return data && typeof data === "object" && !Array.isArray(data) ? (data as RawData) : {};
}

export function normalizeMarketId(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "bigint" && value >= 0n) return Number(value);
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  throw new Error("oracle event market_id must be a non-negative integer");
}

export function normalizeAddress(value: unknown, field: string): string {
  if (typeof value === "string" && STELLAR_ADDRESS.test(value)) return value;
  throw new Error(`oracle event ${field} must be a valid Stellar address`);
}

export function normalizeOptionalAddress(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return normalizeAddress(value, field);
}

export function normalizeOutcome(value: unknown): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "t", "yes", "y", "1"].includes(normalized)) return "yes";
    if (["false", "f", "no", "n", "0"].includes(normalized)) return "no";
  }
  throw new Error("oracle event outcome must be a boolean-like value");
}

export function normalizeBool(value: unknown, field: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "t", "1"].includes(normalized)) return true;
    if (["false", "f", "0"].includes(normalized)) return false;
  }
  throw new Error(`oracle event ${field} must be a boolean`);
}

export function normalizeAmount(value: unknown, field: string): string {
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  throw new Error(`oracle event ${field} must be a non-negative integer`);
}

export function normalizeTimestamp(value: unknown, field: string): Date {
  const seconds = normalizeAmount(value, field);
  return new Date(Number(seconds) * 1000);
}
