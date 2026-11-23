/**
 * In-memory fake Redis bootstrap for tests (issue #228).
 *
 * Implements the command surface the backend actually uses on the HTTP/cache
 * path — `get`, `set`, `setex`, `del`, `ping` — plus the small set of helpers
 * a test bootstrap needs (`exists`, `incr`, `expire`, `ttl`, `keys`,
 * `flushall`, `quit`). Everything is pure in-process state with the same async
 * signatures as ioredis, so it can be dropped into `buildServer({ redis })`
 * exactly where a real client would go.
 *
 * Deterministic by construction: no sockets, no retries, no reconnect storms.
 * Use the exported {@link MemRedis} class directly or grab a fresh instance via
 * {@link createTestRedis}; override any method on the instance to simulate an
 * outage (see `test/resilience.test.ts` for an example).
 */

export interface MemRedisEntry {
  value: string;
  expiresAt: number | null;
}

type Listener = (...args: unknown[]) => void;

/** Convert a Redis glob (only `*` and `?`) into a regex. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[|\\{}()[\]^$+*?.]/g, "\\$&")
    .replace(/\\\*/g, ".*")
    .replace(/\\\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/**
 * Minimal async in-memory Redis client, interface-compatible with the ioredis
 * methods used by this backend.
 */
export class MemRedis {
  private readonly store = new Map<string, MemRedisEntry>();
  private readonly listeners = new Map<string, Set<Listener>>();

  /** ioredis-compatible status field, e.g. `"ready"` | `"end"`. */
  status: "wait" | "connecting" | "ready" | "end" = "ready";

  /** Number of keys currently tracked (including expired-but-unpruned). */
  get size(): number {
    return this.store.size;
  }

  // ── Data commands ─────────────────────────────────────────────────────────

  get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (entry === undefined) {
      return Promise.resolve(null);
    }
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value);
  }

  /**
   * ioredis-compatible `set`. Supports the optional `'EX'`/`'PX'` TTL modes
   * used by the codebase (`cache.set(..., 'EX', ttl)`).
   */
  set(key: string, value: unknown, ...args: unknown[]): Promise<"OK"> {
    let expiresAt: number | null = null;
    for (let i = 0; i + 1 < args.length; i += 2) {
      const mode = args[i];
      const amount = args[i + 1];
      if (mode === "EX" && typeof amount === "number") {
        expiresAt = Date.now() + amount * 1000;
      } else if (mode === "PX" && typeof amount === "number") {
        expiresAt = Date.now() + amount;
      }
    }
    this.store.set(key, { value: String(value), expiresAt });
    this.emit("set", key, value);
    return Promise.resolve("OK");
  }

  /** Redis `SETEX key seconds value`. */
  setex(key: string, seconds: number, value: unknown): Promise<"OK"> {
    this.store.set(key, {
      value: String(value),
      expiresAt: Date.now() + seconds * 1000,
    });
    this.emit("set", key, value);
    return Promise.resolve("OK");
  }

  /** Redis `DEL key [key ...]` — resolves to the number of keys removed. */
  del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.store.delete(key)) {
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }

  /** Redis `EXISTS key [key ...]` — resolves to the number present. */
  exists(...keys: string[]): Promise<number> {
    let present = 0;
    for (const key of keys) {
      const entry = this.store.get(key);
      if (entry !== undefined && !this.isExpired(entry)) {
        present += 1;
      }
    }
    return Promise.resolve(present);
  }

  /** Redis `INCR key` — atomic increment of the numeric value at `key`. */
  incr(key: string): Promise<number> {
    const entry = this.store.get(key);
    const current = entry === undefined || entry === null ? 0 : Number(entry.value);
    const next = Number.isFinite(current) ? current + 1 : 1;
    this.store.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
    return Promise.resolve(next);
  }

  // ── Expiry ────────────────────────────────────────────────────────────────

  /** Redis `PEXPIREAT`-style marker; positive expiry for existing keys. */
  expire(key: string, seconds: number): Promise<number> {
    const entry = this.store.get(key);
    if (entry === undefined) {
      return Promise.resolve(0);
    }
    entry.expiresAt = Date.now() + seconds * 1000;
    return Promise.resolve(1);
  }

  /**
   * Redis `TTL key` — seconds remaining, `-1` for no expiry, `-2` for a
   * missing key.
   */
  ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (entry === undefined) {
      return Promise.resolve(-2);
    }
    if (entry.expiresAt === null) {
      return Promise.resolve(-1);
    }
    const remaining = Math.ceil((entry.expiresAt - Date.now()) / 1000);
    return Promise.resolve(Math.max(remaining, 0));
  }

  // ── Key scans / maintenance ───────────────────────────────────────────────

  /** Redis `KEYS pattern` with `*` / `?` glob support. */
  keys(pattern = "*"): Promise<string[]> {
    const matcher = globToRegExp(pattern);
    const matches: string[] = [];
    for (const [key, entry] of this.store) {
      if (!this.isExpired(entry) && matcher.test(key)) {
        matches.push(key);
      }
    }
    return Promise.resolve(matches.sort());
  }

  /** Wipe every key. */
  flushall(): Promise<"OK"> {
    return this.flushdb();
  }

  /** Wipe every key in the current (only) database. */
  flushdb(): Promise<"OK"> {
    this.store.clear();
    return Promise.resolve("OK");
  }

  // ── Connection / lifecycle ────────────────────────────────────────────────

  /** Redis `PING`, echoing `message` when provided. */
  ping(message?: string): Promise<string> {
    return Promise.resolve(message ?? "PONG");
  }

  /** Marks the client ready. */
  connect(): Promise<"OK"> {
    this.status = "ready";
    return Promise.resolve("OK");
  }

  /** Ends the connection and clears state. */
  quit(): Promise<"OK"> {
    this.status = "end";
    this.store.clear();
    this.emit("end");
    return Promise.resolve("OK");
  }

  /** Silently drop the connection (ioredis-compatible no-op for a fake). */
  disconnect(): void {
    this.status = "end";
  }

  // ── Minimal event emitter (ioredis compatibility) ─────────────────────────

  on(event: string, listener: Listener): this {
    return this.addListener(event, listener);
  }

  once(event: string, listener: Listener): this {
    const wrapper: Listener = (...args) => {
      this.removeListener(event, wrapper);
      listener(...args);
    };
    return this.addListener(event, wrapper);
  }

  addListener(event: string, listener: Listener): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return this;
  }

  removeListener(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  off(event: string, listener: Listener): this {
    return this.removeListener(event, listener);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private isExpired(entry: MemRedisEntry): boolean {
    return entry.expiresAt !== null && Date.now() >= entry.expiresAt;
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

/** Convenience factory — a fresh, ready-to-use fake client. */
export function createTestRedis(): MemRedis {
  return new MemRedis();
}