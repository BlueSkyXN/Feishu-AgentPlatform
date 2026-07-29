import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CredentialVault,
  PlatformDatabase,
  stringColumn,
} from '../src/storage/index.js';

test('credential vault encrypts values and only exposes configured fingerprints', () => {
  const database = new PlatformDatabase(':memory:');
  const vault = new CredentialVault(database, 'vault-master-key-with-enough-entropy');
  const secret = 'cli_super-secret-value-never-returned';
  try {
    const created = vault.setCredential({
      name: 'apps/primary/app-secret',
      kind: 'feishu-app-secret',
      value: secret,
      actor: 'admin-token',
    });
    assert.equal(created.configured, true);
    assert.equal(created.fingerprint?.length, 16);
    assert.equal(JSON.stringify(created).includes(secret), false);
    assert.equal(JSON.stringify(vault.listStatuses()).includes(secret), false);

    const raw = database.get(
      'SELECT envelope_json FROM credentials WHERE name = ?',
      'apps/primary/app-secret',
    );
    const encrypted = stringColumn(raw, 'envelope_json');
    assert.equal(encrypted.includes(secret), false);
    assert.equal(vault.resolveForInternalUse('apps/primary/app-secret'), secret);

    const rotated = vault.setCredential({
      name: 'apps/primary/app-secret',
      kind: 'feishu-app-secret',
      value: 'rotated-secret-value',
      actor: 'feishu:tenant:user',
    });
    assert.notEqual(rotated.fingerprint, created.fingerprint);
    assert.equal(vault.resolveForInternalUse('apps/primary/app-secret'), 'rotated-secret-value');

    const auditJson = JSON.stringify(database.listAudit());
    assert.equal(auditJson.includes(secret), false);
    assert.equal(auditJson.includes('rotated-secret-value'), false);
    assert.equal(vault.deleteCredential('apps/primary/app-secret', 'admin-token'), true);
    assert.equal(vault.resolveForInternalUse('apps/primary/app-secret'), undefined);
    assert.deepEqual(vault.getStatus('apps/primary/app-secret'), {
      name: 'apps/primary/app-secret',
      configured: false,
    });
  } finally {
    database.close();
  }
});
test('credential names, kinds and encryption key strength are validated', () => {
  const database = new PlatformDatabase(':memory:');
  try {
    assert.throws(() => new CredentialVault(database, 'short'), /at least 16/);
    const vault = new CredentialVault(database, 'long-enough-master-key');
    assert.throws(
      () => vault.setCredential({ name: '../escape', kind: 'secret', value: 'x', actor: 'admin' }),
      /Credential name/,
    );
    assert.throws(
      () => vault.setCredential({ name: 'safe', kind: 'not allowed', value: 'x', actor: 'admin' }),
      /Credential kind/,
    );
  } finally {
    database.close();
  }
});
