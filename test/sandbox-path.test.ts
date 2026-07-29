import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LocalWorkspaceGuard } from '../src/sandbox/workspace-guard.js';
import { assertInsideRoot, assertRelativeWorkspacePath } from '../src/sandbox/path-policy.js';

async function fixture(mode: 'read-only' | 'read-write') {
  const parent = await mkdtemp(join(tmpdir(), 'feishu-pi-sandbox-'));
  const root = join(parent, 'workspace');
  const outside = join(parent, 'outside');
  await Promise.all([mkdir(root), mkdir(outside)]);
  const sandbox = new LocalWorkspaceGuard({
    root,
    mode,
    maxReadBytes: 4096,
    maxWriteBytes: 4096,
    maxTotalBytes: 8192,
    maxFiles: 16,
  });
  await sandbox.initialize();
  return { parent, root, outside, sandbox };
}

test('workspace paths reject absolute paths, parent traversal and NUL', () => {
  for (const value of ['/etc/passwd', '../secret', 'a/../../secret', 'a\0b']) {
    assert.throws(() => assertRelativeWorkspacePath(value));
  }
  assert.equal(assertRelativeWorkspacePath('./a/b.txt'), 'a/b.txt');
  assert.doesNotThrow(() => assertInsideRoot('/tmp/root', '/tmp/root/a'));
  assert.throws(() => assertInsideRoot('/tmp/root', '/tmp/root-other/a'));
});

test('read and list never follow symlinks outside the workspace', async () => {
  const { parent, root, outside, sandbox } = await fixture('read-only');
  try {
    await writeFile(join(root, 'inside.txt'), 'inside');
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    assert.equal(await sandbox.read('inside.txt'), 'inside');
    await assert.rejects(() => sandbox.read('link.txt'), /escapes the workspace/);
    const listing = await sandbox.list('.');
    assert.equal(listing.some((entry) => entry.path === 'link.txt'), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('read-only workspace rejects writes and exposes no command execution method', async () => {
  const { parent, sandbox } = await fixture('read-only');
  try {
    await assert.rejects(() => sandbox.write('a.txt', 'x'), /read-only/);
    assert.equal('exec' in sandbox, false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('read-write mode writes atomically inside the root and rejects symlink targets', async () => {
  const { parent, root, outside, sandbox } = await fixture('read-write');
  try {
    assert.deepEqual(await sandbox.write('nested/a.txt', 'hello'), {
      path: 'nested/a.txt',
      bytes: 5,
    });
    assert.equal(await readFile(join(root, 'nested/a.txt'), 'utf8'), 'hello');
    await writeFile(join(outside, 'secret.txt'), 'unchanged');
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
    await assert.rejects(() => sandbox.write('escape.txt', 'changed'), /symlink/);
    assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'unchanged');

    await symlink(outside, join(root, 'outside-link'));
    await assert.rejects(
      () => sandbox.write('outside-link/new.txt', 'changed'),
      /parent path contains a symlink/,
    );
    await assert.rejects(() => readFile(join(outside, 'new.txt'), 'utf8'));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('workspace enforces read and write byte limits', async () => {
  const { parent, root, sandbox } = await fixture('read-write');
  try {
    await writeFile(join(root, 'large.txt'), 'x'.repeat(5000));
    await assert.rejects(() => sandbox.read('large.txt'), /read limit/);
    await assert.rejects(() => sandbox.write('too-large.txt', 'x'.repeat(5000)), /write exceeds/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('workspace cumulative quota accounts for overwrites and serializes concurrent writes', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'feishu-pi-sandbox-quota-'));
  const root = join(parent, 'workspace');
  await mkdir(root);
  const sandbox = new LocalWorkspaceGuard({
    root,
    mode: 'read-write',
    maxReadBytes: 4096,
    maxWriteBytes: 4096,
    maxTotalBytes: 12,
    maxFiles: 2,
  });
  try {
    await sandbox.initialize();
    await sandbox.write('a.txt', '123456');
    await sandbox.write('b.txt', '1234');
    await assert.rejects(() => sandbox.write('c.txt', 'x'), /file cumulative limit/);
    await assert.rejects(() => sandbox.write('b.txt', '1234567'), /byte cumulative limit/);
    await sandbox.write('a.txt', '1');
    await sandbox.write('b.txt', '12345678901');
    assert.equal(await sandbox.read('a.txt'), '1');
    assert.equal(await sandbox.read('b.txt'), '12345678901');

    await sandbox.write('a.txt', '');
    await sandbox.write('b.txt', '');
    await assert.rejects(
      () => sandbox.write('rejected/child.txt', '1234567890123'),
      /byte cumulative limit/,
    );
    assert.equal((await readdir(root)).includes('rejected'), false);
    const concurrent = await Promise.allSettled([
      sandbox.write('a.txt', '1234567'),
      sandbox.write('b.txt', '1234567'),
    ]);
    assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(concurrent.filter((result) => result.status === 'rejected').length, 1);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('workspace quota is shared across Guard instances and permits only non-growing recovery when already exceeded', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'feishu-pi-sandbox-shared-quota-'));
  const root = join(parent, 'workspace');
  await mkdir(root);
  const options = {
    root,
    mode: 'read-write' as const,
    maxReadBytes: 4096,
    maxWriteBytes: 4096,
    maxTotalBytes: 10,
    maxFiles: 4,
  };
  try {
    const first = new LocalWorkspaceGuard(options);
    const second = new LocalWorkspaceGuard(options);
    await Promise.all([first.initialize(), second.initialize()]);
    const concurrent = await Promise.allSettled([
      first.write('a.txt', '123456'),
      second.write('b.txt', '123456'),
    ]);
    assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(concurrent.filter((result) => result.status === 'rejected').length, 1);

    await writeFile(join(root, 'external.txt'), '123456789012');
    await assert.rejects(() => first.write('new.txt', 'x'), /already exceeds/);
    await assert.rejects(() => first.write('external.txt', '1234567890123'), /already exceeds/);
    await first.write('external.txt', '1');
    const reloaded = new LocalWorkspaceGuard(options);
    await reloaded.initialize();
    await reloaded.write('new.txt', '1');
    assert.equal(await reloaded.read('external.txt'), '1');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
