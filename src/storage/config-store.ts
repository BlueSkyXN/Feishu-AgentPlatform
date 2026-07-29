import { createHash } from 'node:crypto';

import {
  PlatformDatabase,
  nullableStringColumn,
  numberColumn,
  stringColumn,
} from './database.js';

export type ConfigSlot = 'active' | 'draft';

export interface ConfigRevisionSummary {
  id: number;
  contentSha256: string;
  createdAt: string;
  createdBy: string;
  note?: string;
  sourceRevisionId?: number;
  publishedAt?: string;
  publishedBy?: string;
  slots: ConfigSlot[];
}

export interface ConfigRevision<TDocument extends object> extends ConfigRevisionSummary {
  document: TDocument;
}

export interface ConfigState<TDocument extends object> {
  active?: ConfigRevision<TDocument>;
  draft?: ConfigRevision<TDocument>;
}

export type ConfigDocumentValidator<TDocument extends object> = (
  document: unknown,
) => TDocument;

export interface RevisionMutationOptions {
  actor: string;
  note?: string;
}

export interface SaveDraftOptions extends RevisionMutationOptions {
  expectedDraftRevisionId?: number | null;
  sourceRevisionId?: number;
}

export class ConfigConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigConflictError';
  }
}

export class ConfigDocumentStore<TDocument extends object> {
  constructor(
    private readonly database: PlatformDatabase,
    private readonly validateDocument: ConfigDocumentValidator<TDocument>,
  ) {}

  importSeed(document: unknown, options: RevisionMutationOptions): ConfigRevision<TDocument> {
    const validated = this.validate(document);
    return this.database.transaction(() => {
      const count = this.database.get('SELECT COUNT(*) AS count FROM config_revisions');
      if (numberColumn(count, 'count') !== 0) {
        throw new ConfigConflictError('Seed import is only allowed when the configuration database is empty.');
      }
      const now = new Date().toISOString();
      const revisionId = this.insertRevision(validated, {
        ...options,
        publishedAt: now,
        publishedBy: options.actor,
      });
      this.setSlot('active', revisionId, options.actor, now);
      this.database.recordAudit({
        actor: options.actor,
        action: 'config.seed_imported',
        entityType: 'config_revision',
        entityId: String(revisionId),
        details: { note: options.note ?? null },
        occurredAt: now,
      });
      return this.requireRevision(revisionId);
    });
  }

  saveDraft(document: unknown, options: SaveDraftOptions): ConfigRevision<TDocument> {
    const validated = this.validate(document);
    return this.database.transaction(() => {
      const currentDraftId = this.slotRevisionId('draft');
      if (
        options.expectedDraftRevisionId !== undefined &&
        options.expectedDraftRevisionId !== (currentDraftId ?? null)
      ) {
        throw new ConfigConflictError(
          `Draft revision changed: expected ${String(options.expectedDraftRevisionId)}, current ${String(currentDraftId ?? null)}.`,
        );
      }
      if (options.sourceRevisionId !== undefined) this.requireRevision(options.sourceRevisionId);
      const now = new Date().toISOString();
      const revisionId = this.insertRevision(validated, options);
      this.setSlot('draft', revisionId, options.actor, now);
      this.database.recordAudit({
        actor: options.actor,
        action: 'config.draft_saved',
        entityType: 'config_revision',
        entityId: String(revisionId),
        details: {
          previousDraftRevisionId: currentDraftId ?? null,
          sourceRevisionId: options.sourceRevisionId ?? null,
          note: options.note ?? null,
        },
        occurredAt: now,
      });
      return this.requireRevision(revisionId);
    });
  }

  publishDraft(options: RevisionMutationOptions & {
    expectedDraftRevisionId?: number;
  }): ConfigRevision<TDocument> {
    return this.database.transaction(() => {
      const draftId = this.slotRevisionId('draft');
      if (draftId === undefined) throw new ConfigConflictError('No draft revision is available to publish.');
      if (
        options.expectedDraftRevisionId !== undefined &&
        options.expectedDraftRevisionId !== draftId
      ) {
        throw new ConfigConflictError(
          `Draft revision changed: expected ${options.expectedDraftRevisionId}, current ${draftId}.`,
        );
      }
      const draft = this.requireRevision(draftId);
      this.validate(draft.document);
      const previousActiveId = this.slotRevisionId('active');
      const now = new Date().toISOString();
      this.database.run(
        'UPDATE config_revisions SET published_at = ?, published_by = ? WHERE id = ?',
        now,
        actor(options.actor),
        draftId,
      );
      this.setSlot('active', draftId, options.actor, now);
      this.database.run("DELETE FROM config_slots WHERE slot = 'draft'");
      this.database.recordAudit({
        actor: options.actor,
        action: 'config.draft_published',
        entityType: 'config_revision',
        entityId: String(draftId),
        details: { previousActiveRevisionId: previousActiveId ?? null, note: options.note ?? null },
        occurredAt: now,
      });
      return this.requireRevision(draftId);
    });
  }

  rollback(targetRevisionId: number, options: RevisionMutationOptions): ConfigRevision<TDocument> {
    return this.database.transaction(() => {
      const target = this.requireRevision(targetRevisionId);
      const validated = this.validate(target.document);
      const previousActiveId = this.slotRevisionId('active');
      const now = new Date().toISOString();
      const rollbackRevisionId = this.insertRevision(validated, {
        actor: options.actor,
        note: options.note ?? `Rollback to revision ${targetRevisionId}`,
        sourceRevisionId: targetRevisionId,
        publishedAt: now,
        publishedBy: options.actor,
      });
      this.setSlot('active', rollbackRevisionId, options.actor, now);
      this.database.run("DELETE FROM config_slots WHERE slot = 'draft'");
      this.database.recordAudit({
        actor: options.actor,
        action: 'config.rollback_published',
        entityType: 'config_revision',
        entityId: String(rollbackRevisionId),
        details: {
          targetRevisionId,
          previousActiveRevisionId: previousActiveId ?? null,
          note: options.note ?? null,
        },
        occurredAt: now,
      });
      return this.requireRevision(rollbackRevisionId);
    });
  }

  getState(): ConfigState<TDocument> {
    const activeId = this.slotRevisionId('active');
    const draftId = this.slotRevisionId('draft');
    return {
      ...(activeId === undefined ? {} : { active: this.requireRevision(activeId) }),
      ...(draftId === undefined ? {} : { draft: this.requireRevision(draftId) }),
    };
  }

  getRevision(revisionId: number): ConfigRevision<TDocument> | undefined {
    const row = this.database.get(
      `SELECT id, document_json, content_sha256, created_at, created_by, note,
              source_revision_id, published_at, published_by
       FROM config_revisions WHERE id = ?`,
      revisionId,
    );
    return row ? this.revisionFromRow(row) : undefined;
  }

  listRevisions(limit = 100): ConfigRevisionSummary[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Revision limit must be an integer between 1 and 500.');
    }
    return this.database
      .all(
        `SELECT id, document_json, content_sha256, created_at, created_by, note,
                source_revision_id, published_at, published_by
         FROM config_revisions ORDER BY id DESC LIMIT ?`,
        limit,
      )
      .map((row) => {
        const { document: _document, ...summary } = this.revisionFromRow(row);
        return summary;
      });
  }

  private validate(document: unknown): TDocument {
    const candidate = this.validateDocument(structuredClone(document));
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Configuration validator must return a JSON object.');
    }
    return JSON.parse(serializeDocument(candidate)) as TDocument;
  }

  private insertRevision(
    document: TDocument,
    options: RevisionMutationOptions & {
      sourceRevisionId?: number;
      publishedAt?: string;
      publishedBy?: string;
    },
  ): number {
    const documentJson = serializeDocument(document);
    const result = this.database.run(
      `INSERT INTO config_revisions
        (document_json, content_sha256, created_at, created_by, note,
         source_revision_id, published_at, published_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      documentJson,
      createHash('sha256').update(documentJson).digest('hex'),
      new Date().toISOString(),
      actor(options.actor),
      options.note?.trim() || null,
      options.sourceRevisionId ?? null,
      options.publishedAt ?? null,
      options.publishedBy ? actor(options.publishedBy) : null,
    );
    return result.lastInsertRowid;
  }

  private setSlot(slot: ConfigSlot, revisionId: number, updatedBy: string, now: string): void {
    this.database.run(
      `INSERT INTO config_slots (slot, revision_id, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(slot) DO UPDATE SET
         revision_id = excluded.revision_id,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
      slot,
      revisionId,
      now,
      actor(updatedBy),
    );
  }

  private slotRevisionId(slot: ConfigSlot): number | undefined {
    const row = this.database.get('SELECT revision_id FROM config_slots WHERE slot = ?', slot);
    return row ? numberColumn(row, 'revision_id') : undefined;
  }

  private requireRevision(revisionId: number): ConfigRevision<TDocument> {
    const revision = this.getRevision(revisionId);
    if (!revision) throw new Error(`Configuration revision ${revisionId} does not exist.`);
    return revision;
  }

  private revisionFromRow(
    row: Record<string, import('node:sqlite').SQLOutputValue>,
  ): ConfigRevision<TDocument> {
    const revisionId = numberColumn(row, 'id');
    const note = nullableStringColumn(row, 'note');
    const sourceRevisionId = row.source_revision_id === null
      ? undefined
      : numberColumn(row, 'source_revision_id');
    const publishedAt = nullableStringColumn(row, 'published_at');
    const publishedBy = nullableStringColumn(row, 'published_by');
    const document = JSON.parse(stringColumn(row, 'document_json')) as unknown;
    const validated = this.validate(document);
    const slots = this.database
      .all('SELECT slot FROM config_slots WHERE revision_id = ? ORDER BY slot', revisionId)
      .map((slotRow) => stringColumn(slotRow, 'slot') as ConfigSlot);
    return {
      id: revisionId,
      document: validated,
      contentSha256: stringColumn(row, 'content_sha256'),
      createdAt: stringColumn(row, 'created_at'),
      createdBy: stringColumn(row, 'created_by'),
      ...(note ? { note } : {}),
      ...(sourceRevisionId === undefined ? {} : { sourceRevisionId }),
      ...(publishedAt ? { publishedAt } : {}),
      ...(publishedBy ? { publishedBy } : {}),
      slots,
    };
  }
}

function serializeDocument(document: object): string {
  const serialized = JSON.stringify(document);
  if (serialized === undefined) throw new Error('Configuration document is not JSON serializable.');
  return serialized;
}

function actor(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('Revision actor must be a non-empty string.');
  if (normalized.length > 256) throw new Error('Revision actor exceeds 256 characters.');
  return normalized;
}
