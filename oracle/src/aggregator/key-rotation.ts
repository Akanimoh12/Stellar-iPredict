import { readFile } from "node:fs/promises";

export interface ResolverKeyProvider {
  getKey(): Promise<string>;
  readonly source: string;
}

export class EnvironmentResolverKeyProvider implements ResolverKeyProvider {
  readonly source = "environment";

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly variable = "RESOLVER_KEY",
  ) {}

  async getKey(): Promise<string> {
    const key = this.env[this.variable]?.trim();
    if (!key) {
      throw new Error(`Resolver signing key is unavailable from ${this.source}`);
    }
    return key;
  }
}

/**
 * Reads a secret injected as a file by Vault Agent, Kubernetes Secrets,
 * Docker Secrets, or another external secret manager. The file contents are
 * never included in an error or log message.
 */
export class MountedSecretResolverKeyProvider implements ResolverKeyProvider {
  readonly source = "mounted-secret";

  constructor(private readonly path: string) {
    if (!path.trim()) throw new Error("Resolver key secret file path is required");
  }

  async getKey(): Promise<string> {
    try {
      const key = (await readFile(this.path, "utf8")).trim();
      if (!key) throw new Error("empty secret");
      return key;
    } catch {
      throw new Error(`Resolver signing key could not be loaded from ${this.source}`);
    }
  }
}

export function createResolverKeyProvider(
  env: NodeJS.ProcessEnv = process.env,
): ResolverKeyProvider {
  const file = env.RESOLVER_KEY_FILE?.trim();
  if (file) return new MountedSecretResolverKeyProvider(file);
  return new EnvironmentResolverKeyProvider(env);
}

/**
 * Manages resolver key rotation without downtime.
 *
 * A "resolver key" is the Stellar address used to sign `resolve_market`
 * transactions. Rotation replaces the active key while optionally keeping the
 * old key valid during a grace period so in-flight operations can complete.
 *
 * Design:
 * - `activeKey` is always the preferred signing key.
 * - `pendingKeys` holds recently rotated-out keys that the system still
 *   accepts during a transition window.
 * - Callers use `isAuthorized(key)` to verify whether a key may submit.
 * - `rotate(newKey)` swaps the active key atomically — the previous active key
 *   is moved to `pendingKeys` and the new key becomes active.
 * - `revokePending()` clears all grace-period keys when the operator confirms
 *   the transition is complete.
 */
export class ResolverKeyManager {
  private activeKey: string;
  private readonly pendingKeys: Set<string> = new Set();

  constructor(initialKey: string) {
    const key = initialKey.trim();
    if (!key) throw new Error("initialKey is required");
    this.activeKey = key;
  }

  /** The key currently used for new submissions. */
  getActiveKey(): string {
    return this.activeKey;
  }

  /** All keys still accepted (active + pending). */
  getAuthorizedKeys(): string[] {
    return [this.activeKey, ...this.pendingKeys];
  }

  /** Check whether a key is currently authorized (active or pending). */
  isAuthorized(key: string): boolean {
    const normalized = key.trim();
    return normalized === this.activeKey || this.pendingKeys.has(normalized);
  }

  /**
   * Rotate to a new key. The previous active key moves to `pendingKeys` so
   * in-flight transactions signed with it are still accepted.
   *
   * Rotating to the already-active key is a no-op.
   */
  rotate(newKey: string): void {
    const normalized = newKey.trim();
    if (!normalized) throw new Error("newKey is required");
    if (normalized === this.activeKey) return;

    // Move old active to pending, promote new key
    this.pendingKeys.add(this.activeKey);
    this.pendingKeys.delete(normalized); // remove from pending if it was there
    this.activeKey = normalized;
  }

  /**
   * Revoke all pending (rotated-out) keys. Call this once the operator
   * confirms no in-flight operations use the old key.
   */
  revokePending(): string[] {
    const revoked = [...this.pendingKeys];
    this.pendingKeys.clear();
    return revoked;
  }

  /**
   * Revoke a specific pending key without affecting other pending keys.
   * Returns `true` if the key was pending and has been revoked.
   */
  revokePendingKey(key: string): boolean {
    const normalized = key.trim();
    if (normalized === this.activeKey) {
      throw new Error("Cannot revoke the active key — rotate first");
    }
    return this.pendingKeys.delete(normalized);
  }
}

export interface ResolverRotationHooks {
  /** Register the incoming resolver on-chain before it is used. */
  registerIncomingKey(key: string): Promise<void>;
  /** Perform a real signed verification operation with the incoming key. */
  verifyIncomingKey(key: string): Promise<void>;
  /** Remove the outgoing resolver after the overlap window. */
  retireOutgoingKey(key: string): Promise<void>;
}

export interface ResolverRotationOptions {
  provider: ResolverKeyProvider;
  hooks: ResolverRotationHooks;
  overlapMs: number;
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  onError?: (error: unknown) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Coordinates safe resolver rotation. The incoming key is registered first,
 * then promoted while the outgoing key stays authorized. Verification must
 * succeed before the overlap timer starts. A verification failure restores the
 * previous active key and leaves it authorized.
 */
export class ResolverRotationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly manager: ResolverKeyManager,
    private readonly options: ResolverRotationOptions,
  ) {
    if (options.overlapMs < 0) throw new Error("overlapMs must be non-negative");
    if (options.intervalMs <= 0) throw new Error("intervalMs must be positive");
  }

  async runOnce(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const incoming = (await this.options.provider.getKey()).trim();
      const outgoing = this.manager.getActiveKey();
      if (incoming === outgoing) return false;

      await this.options.hooks.registerIncomingKey(incoming);
      this.manager.rotate(incoming);

      try {
        await this.options.hooks.verifyIncomingKey(incoming);
      } catch (error) {
        // Roll back without ever leaving the system with no working resolver.
        this.manager.rotate(outgoing);
        this.manager.revokePendingKey(incoming);
        throw new Error("Incoming resolver key failed verification; previous key restored", {
          cause: error,
        });
      }

      const sleep = this.options.sleep ?? defaultSleep;
      await sleep(this.options.overlapMs);
      await this.options.hooks.retireOutgoingKey(outgoing);
      this.manager.revokePendingKey(outgoing);
      return true;
    } finally {
      this.running = false;
    }
  }

  start(): () => void {
    if (this.timer) return () => this.stop();
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => this.options.onError?.(error));
    }, this.options.intervalMs);
    this.timer.unref?.();
    return () => this.stop();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}