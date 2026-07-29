import { randomUUID } from 'node:crypto';

import type { PlatformDatabase } from './database.js';

export interface AppRuntimeLeaseOptions {
  key: string;
  ownerId: string;
  ttlMs: number;
  heartbeatMs: number;
  now?: () => number;
}

/** SQLite-backed lease with an atomic stale-owner compare-and-swap. */
export class AppRuntimeLease {
  private readonly token = randomUUID();
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;
  private acquired = false;
  private lost = false;

  constructor(
    private readonly database: PlatformDatabase,
    private readonly options: AppRuntimeLeaseOptions,
  ) {
    if (!options.key.trim() || !options.ownerId.trim()) {
      throw new Error('Lease key and ownerId must not be empty.');
    }
    if (!Number.isFinite(options.ttlMs) || !Number.isFinite(options.heartbeatMs)) {
      throw new Error('Lease ttlMs and heartbeatMs must be finite numbers.');
    }
    if (options.heartbeatMs <= 0 || options.ttlMs <= options.heartbeatMs) {
      throw new Error('Lease ttlMs must be greater than a positive heartbeatMs.');
    }
    this.now = options.now ?? Date.now;
  }

  get isAcquired(): boolean {
    return this.acquired && !this.lost;
  }

  acquire(): Promise<boolean> {
    if (this.acquired) return Promise.resolve(this.isAcquired);
    const now = this.now();
    const result = this.database.run(
      `INSERT INTO app_runtime_leases
        (lease_key, owner_id, token, acquired_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(lease_key) DO UPDATE SET
         owner_id = excluded.owner_id,
         token = excluded.token,
         acquired_at = excluded.acquired_at,
         expires_at = excluded.expires_at
       WHERE app_runtime_leases.expires_at <= ?`,
      this.options.key,
      this.options.ownerId,
      this.token,
      now,
      now + this.options.ttlMs,
      now,
    );
    if (result.changes !== 1) return Promise.resolve(false);
    this.acquired = true;
    this.lost = false;
    this.startHeartbeat();
    return Promise.resolve(true);
  }

  heartbeat(): Promise<boolean> {
    if (!this.isAcquired) return Promise.resolve(false);
    const now = this.now();
    const result = this.database.run(
      `UPDATE app_runtime_leases
       SET expires_at = ?
       WHERE lease_key = ? AND owner_id = ? AND token = ? AND expires_at > ?`,
      now + this.options.ttlMs,
      this.options.key,
      this.options.ownerId,
      this.token,
      now,
    );
    if (result.changes === 1) return Promise.resolve(true);
    this.markLost();
    return Promise.resolve(false);
  }

  release(): Promise<void> {
    this.stopHeartbeat();
    if (this.acquired) {
      this.database.run(
        `DELETE FROM app_runtime_leases
         WHERE lease_key = ? AND owner_id = ? AND token = ?`,
        this.options.key,
        this.options.ownerId,
        this.token,
      );
    }
    this.acquired = false;
    this.lost = false;
    return Promise.resolve();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.timer = setInterval(() => {
      void this.heartbeat();
    }, this.options.heartbeatMs);
    this.timer.unref();
  }

  private stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private markLost(): void {
    this.lost = true;
    this.stopHeartbeat();
  }
}

export class AppLeaseStore {
  constructor(private readonly database: PlatformDatabase) {}

  create(options: AppRuntimeLeaseOptions): AppRuntimeLease {
    return new AppRuntimeLease(this.database, options);
  }
}
