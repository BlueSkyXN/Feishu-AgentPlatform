import { createHmac } from 'node:crypto';

import {
  decryptJson,
  deriveSecretKey,
  encryptJson,
  type EncryptedEnvelope,
} from '../core/crypto-store.js';
import {
  PlatformDatabase,
  nullableStringColumn,
  stringColumn,
} from './database.js';

export interface CredentialStatus {
  name: string;
  configured: boolean;
  kind?: string;
  fingerprint?: string;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
}

interface StoredCredential {
  version: 1;
  value: string;
}

export class CredentialVault {
  private readonly fingerprintKey: Buffer;

  constructor(
    private readonly database: PlatformDatabase,
    private readonly masterSecret: string,
  ) {
    if (masterSecret.length < 16) {
      throw new Error('Credential vault master secret must contain at least 16 characters.');
    }
    this.fingerprintKey = deriveSecretKey(masterSecret, 'credential-fingerprint');
  }

  setCredential(input: {
    name: string;
    kind: string;
    value: string;
    actor: string;
  }): CredentialStatus {
    const name = credentialName(input.name);
    const kind = credentialKind(input.kind);
    if (!input.value) throw new Error('Credential value must be non-empty.');
    const envelope = encryptJson({ version: 1, value: input.value } satisfies StoredCredential, this.masterSecret);
    const fingerprint = this.fingerprint(input.value);
    const now = new Date().toISOString();
    return this.database.transaction(() => {
      this.database.run(
        `INSERT INTO credentials
          (name, kind, envelope_json, fingerprint, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           kind = excluded.kind,
           envelope_json = excluded.envelope_json,
           fingerprint = excluded.fingerprint,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
        name,
        kind,
        JSON.stringify(envelope),
        fingerprint,
        now,
        now,
        actor(input.actor),
      );
      this.database.recordAudit({
        actor: input.actor,
        action: 'credential.configured',
        entityType: 'credential',
        entityId: name,
        details: { kind, fingerprint },
        occurredAt: now,
      });
      return this.requireStatus(name);
    });
  }

  deleteCredential(nameInput: string, actorInput: string): boolean {
    const name = credentialName(nameInput);
    const actorName = actor(actorInput);
    return this.database.transaction(() => {
      const current = this.getStatus(name);
      if (!current.configured) return false;
      this.database.run('DELETE FROM credentials WHERE name = ?', name);
      this.database.recordAudit({
        actor: actorName,
        action: 'credential.deleted',
        entityType: 'credential',
        entityId: name,
        details: { kind: current.kind, fingerprint: current.fingerprint },
      });
      return true;
    });
  }

  getStatus(nameInput: string): CredentialStatus {
    const name = credentialName(nameInput);
    const row = this.database.get(
      `SELECT name, kind, fingerprint, created_at, updated_at, updated_by
       FROM credentials WHERE name = ?`,
      name,
    );
    return row ? statusFromRow(row) : { name, configured: false };
  }

  listStatuses(): CredentialStatus[] {
    return this.database
      .all(
        `SELECT name, kind, fingerprint, created_at, updated_at, updated_by
         FROM credentials ORDER BY kind, name`,
      )
      .map(statusFromRow);
  }

  /** Trusted Host integration only. Never return this value through an API or log. */
  resolveForInternalUse(nameInput: string): string | undefined {
    const name = credentialName(nameInput);
    const row = this.database.get('SELECT envelope_json FROM credentials WHERE name = ?', name);
    if (!row) return undefined;
    const envelope = JSON.parse(stringColumn(row, 'envelope_json')) as EncryptedEnvelope;
    const credential = decryptJson<StoredCredential>(envelope, this.masterSecret);
    if (credential.version !== 1 || typeof credential.value !== 'string' || !credential.value) {
      throw new Error(`Credential ${name} has an invalid encrypted payload.`);
    }
    return credential.value;
  }

  private requireStatus(name: string): CredentialStatus {
    const status = this.getStatus(name);
    if (!status.configured) throw new Error(`Credential ${name} was not persisted.`);
    return status;
  }

  private fingerprint(value: string): string {
    return createHmac('sha256', this.fingerprintKey)
      .update(value, 'utf8')
      .digest('hex')
      .slice(0, 16);
  }
}

function statusFromRow(
  row: Record<string, import('node:sqlite').SQLOutputValue>,
): CredentialStatus {
  const kind = nullableStringColumn(row, 'kind');
  const fingerprint = nullableStringColumn(row, 'fingerprint');
  const createdAt = nullableStringColumn(row, 'created_at');
  const updatedAt = nullableStringColumn(row, 'updated_at');
  const updatedBy = nullableStringColumn(row, 'updated_by');
  return {
    name: stringColumn(row, 'name'),
    configured: true,
    ...(kind ? { kind } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(updatedBy ? { updatedBy } : {}),
  };
}

function credentialName(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(normalized)) {
    throw new Error('Credential name must be 1-128 safe identifier characters.');
  }
  return normalized;
}

function credentialKind(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(normalized)) {
    throw new Error('Credential kind must be 1-64 safe identifier characters.');
  }
  return normalized;
}

function actor(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('Credential actor must be a non-empty string.');
  if (normalized.length > 256) throw new Error('Credential actor exceeds 256 characters.');
  return normalized;
}
