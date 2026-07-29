import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AppLeaseStore } from '../src/storage/app-lease-store.js';
import { PlatformDatabase } from '../src/storage/database.js';

test('SQLite lease has one winner during concurrent stale takeover', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-app-lease-'));
  const path = join(root, 'platform.db');
  const databases = Array.from({ length: 20 }, () => new PlatformDatabase(path));
  let now = Date.now();
  const options = { key: 'app:1', ttlMs: 10_000, heartbeatMs: 9_000, now: () => now };
  const initial = new AppLeaseStore(databases[0] as PlatformDatabase).create({
    ...options,
    ownerId: 'initial',
  });
  const contenders = databases.map((database, index) =>
    new AppLeaseStore(database).create({ ...options, ownerId: `contender-${index}` }),
  );
  try {
    assert.equal(await initial.acquire(), true);
    now += 11_000;
    const results = await Promise.all(contenders.map((lease) => lease.acquire()));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await initial.heartbeat(), false);
    assert.equal(initial.isAcquired, false);
  } finally {
    await Promise.all([initial.release(), ...contenders.map((lease) => lease.release())]);
    for (const database of databases) database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('SQLite lease release is fenced by owner token', async () => {
  const database = new PlatformDatabase(':memory:');
  let now = Date.now();
  const options = { key: 'app:2', ttlMs: 10_000, heartbeatMs: 9_000, now: () => now };
  const first = new AppLeaseStore(database).create({ ...options, ownerId: 'one' });
  const second = new AppLeaseStore(database).create({ ...options, ownerId: 'two' });
  try {
    assert.equal(await first.acquire(), true);
    now += 11_000;
    assert.equal(await second.acquire(), true);
    await first.release();
    assert.equal(await second.heartbeat(), true);
    assert.equal(second.isAcquired, true);
  } finally {
    await Promise.all([first.release(), second.release()]);
    database.close();
  }
});
