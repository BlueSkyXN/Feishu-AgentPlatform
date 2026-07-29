/** Bounded in-memory idempotency window for duplicate WS/HTTP delivery. */
export class DedupeWindow {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly maxEntries = 20_000,
  ) {
    if (ttlMs < 1 || maxEntries < 1) throw new Error('Invalid dedupe window.');
  }

  accept(key: string, now = Date.now()): boolean {
    if (!key) return true;
    const expiresAt = this.seen.get(key);
    if (expiresAt && expiresAt > now) return false;
    this.seen.set(key, now + this.ttlMs);
    if (this.seen.size > this.maxEntries) this.prune(now, true);
    return true;
  }

  forget(key: string): boolean {
    return key ? this.seen.delete(key) : false;
  }

  prune(now = Date.now(), forceSize = false): number {
    let removed = 0;
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now || (forceSize && this.seen.size > this.maxEntries)) {
        this.seen.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.seen.size;
  }
}
