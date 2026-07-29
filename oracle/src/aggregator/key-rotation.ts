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
