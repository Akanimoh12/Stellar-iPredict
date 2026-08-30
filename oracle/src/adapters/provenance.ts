import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ResolutionResult, SourceResult } from "./resolve.js";

const SENSITIVE_KEY = /(?:api[-_]?key|authorization|cookie|credential|password|secret|token)/i;

export interface ProvenanceRecord {
  marketId: string;
  recordedAt: string;
  sources: SourceResult[];
  decision: Pick<ResolutionResult, "status" | "outcome" | "confidence">;
}

export interface ProvenanceStore {
  save(record: ProvenanceRecord): Promise<void>;
  get(marketId: string): Promise<ProvenanceRecord | undefined>;
}

/** Remove credentials recursively before provider responses reach storage. */
export function sanitizeProvenanceValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/([?&](?:api[-_]?key|secret|token)=)[^&\s]+/gi, "$1[REDACTED]")
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeProvenanceValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeProvenanceValue(entry),
      ]),
    );
  }
  return value;
}

export function createProvenanceRecord(
  marketId: string,
  result: ResolutionResult,
  recordedAt = new Date().toISOString(),
): ProvenanceRecord {
  return {
    marketId,
    recordedAt,
    sources: sanitizeProvenanceValue(result.sources) as SourceResult[],
    decision: {
      status: result.status,
      outcome: result.outcome,
      confidence: result.confidence,
    },
  };
}

export class InMemoryProvenanceStore implements ProvenanceStore {
  private readonly records = new Map<string, ProvenanceRecord>();

  async save(record: ProvenanceRecord): Promise<void> {
    this.records.set(
      record.marketId,
      sanitizeProvenanceValue(structuredClone(record)) as ProvenanceRecord,
    );
  }

  async get(marketId: string): Promise<ProvenanceRecord | undefined> {
    const record = this.records.get(marketId);
    return record ? structuredClone(record) : undefined;
  }
}

/** Durable one-record-per-market JSON store for the single-process oracle. */
export class FileProvenanceStore implements ProvenanceStore {
  constructor(private readonly directory: string) {}

  async save(record: ProvenanceRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const destination = this.pathFor(record.marketId);
    const temporary = `${destination}.${process.pid}.tmp`;
    const sanitized = sanitizeProvenanceValue(record) as ProvenanceRecord;
    await writeFile(temporary, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
  }

  async get(marketId: string): Promise<ProvenanceRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.pathFor(marketId), "utf8")) as ProvenanceRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private pathFor(marketId: string): string {
    const safeId = encodeURIComponent(marketId).replaceAll("%", "_");
    return path.join(this.directory, `${safeId}.json`);
  }
}
