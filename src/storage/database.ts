import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  DatabaseSync,
  backup,
  type SQLInputValue,
  type SQLOutputValue,
} from 'node:sqlite';

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

const MIGRATIONS = [
  {
    version: 1,
    name: 'revisioned-config-and-audit',
    sql: `
      CREATE TABLE config_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_json TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        note TEXT,
        source_revision_id INTEGER REFERENCES config_revisions(id) ON DELETE RESTRICT,
        published_at TEXT,
        published_by TEXT
      ) STRICT;

      CREATE TABLE config_slots (
        slot TEXT PRIMARY KEY CHECK (slot IN ('active', 'draft')),
        revision_id INTEGER NOT NULL REFERENCES config_revisions(id) ON DELETE RESTRICT,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      ) STRICT;

      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        details_json TEXT NOT NULL DEFAULT '{}'
      ) STRICT;

      CREATE INDEX audit_events_occurred_at_idx
        ON audit_events(occurred_at DESC, id DESC);
      CREATE INDEX config_revisions_created_at_idx
        ON config_revisions(created_at DESC, id DESC);
    `,
  },
  {
    version: 2,
    name: 'credential-vault',
    sql: `
      CREATE TABLE credentials (
        name TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      ) STRICT;

      CREATE INDEX credentials_kind_idx ON credentials(kind, name);
    `,
  },
  {
    version: 3,
    name: 'sessions-and-tool-approvals',
    sql: `
      CREATE TABLE conversation_sessions (
        storage_id TEXT PRIMARY KEY,
        conversation_key TEXT NOT NULL UNIQUE,
        app_key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        session_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX conversation_sessions_last_used_idx
        ON conversation_sessions(last_used_at DESC, storage_id);
      CREATE INDEX conversation_sessions_scope_idx
        ON conversation_sessions(app_key, agent_id, binding_id, last_used_at DESC);

      CREATE TABLE tool_approvals (
        id TEXT PRIMARY KEY,
        app_key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        requester_open_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        effect TEXT NOT NULL CHECK (effect IN ('write', 'high-risk-write')),
        approval TEXT NOT NULL CHECK (approval IN ('requester', 'admin')),
        arguments_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'expired', 'aborted')),
        approver_open_id TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        resolved_at INTEGER
      ) STRICT;

      CREATE INDEX tool_approvals_state_expiry_idx
        ON tool_approvals(state, expires_at, created_at DESC);
      CREATE INDEX tool_approvals_scope_idx
        ON tool_approvals(app_key, agent_id, binding_id, created_at DESC);
    `,
  },
  {
    version: 4,
    name: 'app-runtime-leases',
    sql: `
      CREATE TABLE app_runtime_leases (
        lease_key TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        token TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX app_runtime_leases_expiry_idx
        ON app_runtime_leases(expires_at, lease_key);
    `,
  },
] as const;

export interface SqlitePragmaStatus {
  journalMode: string;
  foreignKeys: boolean;
  busyTimeoutMs: number;
  schemaVersion: number;
}

export interface AuditEvent {
  id: number;
  occurredAt: string;
  actor: string;
  action: string;
  entityType: string;
  entityId?: string;
  details: Record<string, unknown>;
}

export interface AuditQuery {
  limit?: number;
  beforeId?: number;
  action?: string;
}

export class PlatformDatabase {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(
    readonly path: string,
    options: { busyTimeoutMs?: number } = {},
  ) {
    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) {
      throw new Error('SQLite busyTimeoutMs must be an integer between 0 and 60000.');
    }
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path, { allowExtension: false });
    if (path !== ':memory:') chmodSync(resolve(path), 0o600);
    this.database.exec('PRAGMA foreign_keys = ON');
    this.database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec('PRAGMA synchronous = NORMAL');
    this.database.exec('PRAGMA trusted_schema = OFF');
    this.applyMigrations();
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  async backupTo(path: string): Promise<number> {
    this.assertOpen();
    if (!path.trim()) throw new Error('SQLite backup path must not be empty.');
    return await backup(this.database, resolve(path));
  }

  transaction<T>(operation: () => T): T {
    this.assertOpen();
    if (this.database.isTransaction) return operation();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  run(sql: string, ...parameters: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
    this.assertOpen();
    const result = this.database.prepare(sql).run(...parameters);
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  get(sql: string, ...parameters: SQLInputValue[]): Record<string, SQLOutputValue> | undefined {
    this.assertOpen();
    return this.database.prepare(sql).get(...parameters);
  }

  all(sql: string, ...parameters: SQLInputValue[]): Record<string, SQLOutputValue>[] {
    this.assertOpen();
    return this.database.prepare(sql).all(...parameters);
  }

  recordAudit(input: {
    actor: string;
    action: string;
    entityType: string;
    entityId?: string;
    details?: Record<string, unknown>;
    occurredAt?: string;
  }): AuditEvent {
    const actor = requiredText(input.actor, 'audit actor');
    const action = requiredText(input.action, 'audit action');
    const entityType = requiredText(input.entityType, 'audit entityType');
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const details = input.details ?? {};
    const result = this.run(
      `INSERT INTO audit_events
        (occurred_at, actor, action, entity_type, entity_id, details_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      occurredAt,
      actor,
      action,
      entityType,
      input.entityId ?? null,
      JSON.stringify(details),
    );
    return {
      id: result.lastInsertRowid,
      occurredAt,
      actor,
      action,
      entityType,
      ...(input.entityId ? { entityId: input.entityId } : {}),
      details: structuredClone(details),
    };
  }

  listAudit(query: AuditQuery = {}): AuditEvent[] {
    const limit = boundedInteger(query.limit ?? 100, 1, 500, 'audit limit');
    const conditions: string[] = [];
    const parameters: SQLInputValue[] = [];
    if (query.beforeId !== undefined) {
      conditions.push('id < ?');
      parameters.push(boundedInteger(query.beforeId, 1, Number.MAX_SAFE_INTEGER, 'beforeId'));
    }
    if (query.action !== undefined) {
      conditions.push('action = ?');
      parameters.push(requiredText(query.action, 'audit action'));
    }
    parameters.push(limit);
    const rows = this.all(
      `SELECT id, occurred_at, actor, action, entity_type, entity_id, details_json
       FROM audit_events
       ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY id DESC
       LIMIT ?`,
      ...parameters,
    );
    return rows.map(auditRow);
  }

  pragmaStatus(): SqlitePragmaStatus {
    const journal = this.get('PRAGMA journal_mode');
    const foreignKeys = this.get('PRAGMA foreign_keys');
    const busyTimeout = this.get('PRAGMA busy_timeout');
    const migration = this.get('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations');
    return {
      journalMode: stringColumn(journal, 'journal_mode'),
      foreignKeys: numberColumn(foreignKeys, 'foreign_keys') === 1,
      busyTimeoutMs: numberColumn(busyTimeout, 'timeout'),
      schemaVersion: numberColumn(migration, 'version'),
    };
  }

  private applyMigrations(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const appliedRows = this.database
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
      .all();
    const knownByVersion = new Map<number, string>(
      MIGRATIONS.map((migration) => [migration.version, migration.name]),
    );
    for (const row of appliedRows) {
      const version = Number(row.version);
      const expectedName = knownByVersion.get(version);
      if (!expectedName || row.name !== expectedName) {
        throw new Error(`SQLite schema migration ${version} is newer than or incompatible with this binary.`);
      }
    }
    const applied = new Set(appliedRows.map((row) => Number(row.version)));
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.database.exec(migration.sql);
        this.database
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, new Date().toISOString());
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw new Error(`SQLite migration ${migration.version} (${migration.name}) failed.`, {
          cause: error,
        });
      }
    }
  }

  private assertOpen(): void {
    if (this.closed || !this.database.isOpen) throw new Error('SQLite database is closed.');
  }
}

function auditRow(row: Record<string, SQLOutputValue>): AuditEvent {
  const entityId = nullableStringColumn(row, 'entity_id');
  return {
    id: numberColumn(row, 'id'),
    occurredAt: stringColumn(row, 'occurred_at'),
    actor: stringColumn(row, 'actor'),
    action: stringColumn(row, 'action'),
    entityType: stringColumn(row, 'entity_type'),
    ...(entityId ? { entityId } : {}),
    details: jsonObjectColumn(row, 'details_json'),
  };
}

export function stringColumn(
  row: Record<string, SQLOutputValue> | undefined,
  name: string,
): string {
  const value = row?.[name];
  if (typeof value !== 'string') throw new Error(`SQLite column ${name} must be text.`);
  return value;
}

export function nullableStringColumn(
  row: Record<string, SQLOutputValue> | undefined,
  name: string,
): string | undefined {
  const value = row?.[name];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`SQLite column ${name} must be text or null.`);
  return value;
}

export function numberColumn(
  row: Record<string, SQLOutputValue> | undefined,
  name: string,
): number {
  const value = row?.[name];
  if (typeof value !== 'number' && typeof value !== 'bigint') {
    throw new Error(`SQLite column ${name} must be an integer.`);
  }
  return Number(value);
}

export function jsonObjectColumn(
  row: Record<string, SQLOutputValue> | undefined,
  name: string,
): Record<string, unknown> {
  const parsed = JSON.parse(stringColumn(row, name)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`SQLite column ${name} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string.`);
  if (normalized.length > 256) throw new Error(`${label} exceeds 256 characters.`);
  return normalized;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}
