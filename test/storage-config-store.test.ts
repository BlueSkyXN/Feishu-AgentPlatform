import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ConfigConflictError,
  ConfigDocumentStore,
  PlatformDatabase,
} from '../src/storage/index.js';

interface TestDocument {
  version: number;
  apps: Array<{ id: string }>;
  agents: Array<{ id: string }>;
  bindings: Array<{ id: string }>;
}

test('SQLite migrations, pragmas and revision lifecycle are durable and audited', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fap-storage-config-'));
  const databasePath = join(root, 'platform.sqlite');
  let database: PlatformDatabase | undefined;
  try {
    database = new PlatformDatabase(databasePath, { busyTimeoutMs: 2_500 });
    assert.deepEqual(database.pragmaStatus(), {
      journalMode: 'wal',
      foreignKeys: true,
      busyTimeoutMs: 2_500,
      schemaVersion: 4,
    });

    const store = new ConfigDocumentStore(database, validateDocument);
    assert.deepEqual(store.getState(), {});
    const seed = store.importSeed(document(1), { actor: 'seed-loader', note: 'initial import' });
    assert.equal(seed.id, 1);
    assert.deepEqual(seed.slots, ['active']);
    assert.equal(seed.document.version, 1);
    assert.throws(
      () => store.importSeed(document(2), { actor: 'seed-loader' }),
      ConfigConflictError,
    );

    const draft = store.saveDraft(document(2), {
      actor: 'admin-token',
      expectedDraftRevisionId: null,
      sourceRevisionId: seed.id,
      note: 'add second version',
    });
    assert.deepEqual(draft.slots, ['draft']);
    assert.throws(
      () => store.saveDraft(document(3), {
        actor: 'stale-admin',
        expectedDraftRevisionId: null,
      }),
      ConfigConflictError,
    );

    const published = store.publishDraft({
      actor: 'publisher',
      expectedDraftRevisionId: draft.id,
      note: 'approved',
    });
    assert.equal(published.id, draft.id);
    assert.deepEqual(published.slots, ['active']);
    assert.equal(store.getState().draft, undefined);
    assert.equal(store.getState().active?.document.version, 2);

    const pending = store.saveDraft(document(3), {
      actor: 'editor',
      expectedDraftRevisionId: null,
      sourceRevisionId: published.id,
    });
    assert.equal(pending.document.version, 3);
    const rollback = store.rollback(seed.id, { actor: 'operator', note: 'incident rollback' });
    assert.equal(rollback.document.version, 1);
    assert.equal(rollback.sourceRevisionId, seed.id);
    assert.deepEqual(rollback.slots, ['active']);
    assert.equal(store.getState().draft, undefined);
    assert.equal(store.listRevisions().length, 4);

    const audit = database.listAudit();
    assert.deepEqual(
      audit.map((entry) => entry.action),
      [
        'config.rollback_published',
        'config.draft_saved',
        'config.draft_published',
        'config.draft_saved',
        'config.seed_imported',
      ],
    );

    database.close();
    database = new PlatformDatabase(databasePath);
    const reopened = new ConfigDocumentStore(database, validateDocument);
    assert.equal(reopened.getState().active?.id, rollback.id);
    assert.equal(reopened.getState().active?.document.version, 1);
    assert.equal(database.pragmaStatus().schemaVersion, 4);
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('configuration validation runs before seed, draft, publish and rollback writes', () => {
  const database = new PlatformDatabase(':memory:');
  let validations = 0;
  const store = new ConfigDocumentStore<TestDocument>(database, (value) => {
    validations += 1;
    return validateDocument(value);
  });
  try {
    assert.throws(
      () => store.importSeed({ version: 1 }, { actor: 'seed-loader' }),
      /apps must be an array/,
    );
    assert.deepEqual(store.getState(), {});
    const seed = store.importSeed(document(1), { actor: 'seed-loader' });
    const draft = store.saveDraft(document(2), { actor: 'editor', expectedDraftRevisionId: null });
    store.publishDraft({ actor: 'publisher', expectedDraftRevisionId: draft.id });
    store.rollback(seed.id, { actor: 'operator' });
    assert.ok(validations >= 8, `expected repeated read/publish validation, got ${validations}`);
  } finally {
    database.close();
  }
});

function document(version: number): TestDocument {
  return {
    version,
    apps: [{ id: `app-${version}` }],
    agents: [{ id: `agent-${version}` }],
    bindings: [{ id: `binding-${version}` }],
  };
}

function validateDocument(value: unknown): TestDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('document must be an object');
  }
  const record = value as Record<string, unknown>;
  if (!Number.isInteger(record.version) || Number(record.version) < 1) {
    throw new Error('version must be a positive integer');
  }
  for (const key of ['apps', 'agents', 'bindings'] as const) {
    if (!Array.isArray(record[key])) throw new Error(`${key} must be an array`);
  }
  return structuredClone(value) as TestDocument;
}
