import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';

import type { LoadedBindingConfig } from '../src/config/types.js';
import { prepareTurnInput } from '../src/feishu/attachments.js';
import { LocalWorkspaceGuard } from '../src/sandbox/workspace-guard.js';

function config(workspaceRoot: string): LoadedBindingConfig {
  return {
    id: 'bot',
    appKey: 'app',
    agentId: 'agent',
    agent: { workspaceRoot },
    feishu: {
      attachments: {
        enabled: true,
        maxItems: 3,
        maxBytesPerItem: 1024,
        maxTotalBytes: 2048,
        passImagesToModel: true,
        persistFiles: true,
      },
    },
  } as LoadedBindingConfig;
}

function message(): NormalizedMessage {
  return {
    messageId: 'om_123',
    chatId: 'oc_123',
    chatType: 'group',
    content: '分析附件',
    senderId: 'ou_123',
    senderName: 'User',
    createTime: Date.now(),
    rawContentType: 'file',
    resources: [
      { fileKey: 'image', fileName: '../unsafe.png', type: 'image' },
      { fileKey: 'document', fileName: 'notes.txt', type: 'file' },
    ],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
  };
}

test('attachments are bounded, sanitized, persisted and images reach the model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-pi-attachment-'));
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  try {
    const guard = await workspaceGuard(root);
    const result = await prepareTurnInput(
      {
        downloadResource: async (key) => key === 'image' ? png : Buffer.from('hello'),
      },
      config(root),
      message(),
      guard,
      true,
    );
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0]?.mimeType, 'image/png');
    assert.equal(result.attachmentPaths.length, 2);
    assert.ok(result.attachmentPaths.every((path) => !path.startsWith(root)));
    assert.ok(result.attachmentPaths.every((path) => !path.startsWith('/')));
    assert.ok(result.attachmentPaths.every((path) => !path.includes('..')));
    assert.equal(result.prompt.includes(root), false);
    assert.equal(await guard.read(result.attachmentPaths[1] as string), 'hello');
    await assert.rejects(
      () => guard.read(join(root, result.attachmentPaths[1] as string)),
      /relative/,
    );
    assert.match(result.prompt, /"userMessage": "分析附件"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('oversized resources are skipped before persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-pi-attachment-limit-'));
  try {
    const guard = await workspaceGuard(root);
    const result = await prepareTurnInput(
      { downloadResource: async () => Buffer.alloc(2048) },
      config(root),
      message(),
      guard,
      true,
    );
    assert.equal(result.images.length, 0);
    assert.equal(result.attachmentPaths.length, 0);
    assert.equal(result.skipped.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real Channel download streams are aborted as soon as the byte limit is crossed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-pi-attachment-stream-limit-'));
  let chunksPulled = 0;
  async function* chunks() {
    for (let index = 0; index < 8; index += 1) {
      chunksPulled += 1;
      yield Buffer.alloc(600, index);
    }
  }
  try {
    const guard = await workspaceGuard(root);
    const input = message();
    input.resources = [input.resources[0] as NormalizedMessage['resources'][number]];
    const result = await prepareTurnInput(
      {
        downloadResource: async () => {
          throw new Error('fallback downloader must not be used');
        },
        rawClient: {
          im: { v1: { image: { get: async () => ({
            getReadableStream: () => Readable.from(chunks()),
            headers: {},
          }) } } },
        },
      },
      config(root),
      input,
      guard,
      true,
    );
    // Readable may prefetch one chunk, but destroying it must prevent the
    // remainder of an unbounded response from being consumed.
    assert.ok(chunksPulled >= 2 && chunksPulled < 8);
    assert.equal(result.totalBytes, 0);
    assert.equal(result.attachmentPaths.length, 0);
    assert.match(result.skipped[0] ?? '', /attachment response exceeded 1024 bytes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('attachment persistence rejects a symlinked workspace parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-pi-attachment-symlink-'));
  const outside = await mkdtemp(join(tmpdir(), 'feishu-pi-attachment-outside-'));
  try {
    await symlink(outside, join(root, 'attachments'), 'dir');
    const guard = await workspaceGuard(root);
    await assert.rejects(
      () => prepareTurnInput(
        { downloadResource: async () => Buffer.from('secret') },
        config(root),
        message(),
        guard,
        false,
      ),
      /parent path contains a symlink/,
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test('attachment persistence shares the conversation cumulative workspace quota', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-pi-attachment-quota-'));
  try {
    const guard = await workspaceGuard(root, { maxTotalBytes: 7, maxFiles: 2 });
    const first = message();
    first.resources = [{ fileKey: 'first', fileName: 'first.txt', type: 'file' }];
    const firstResult = await prepareTurnInput(
      { downloadResource: async () => Buffer.from('12345') },
      config(root),
      first,
      guard,
      false,
    );
    const second = message();
    second.messageId = 'om_124';
    second.resources = [{ fileKey: 'second', fileName: 'second.txt', type: 'file' }];
    const secondResult = await prepareTurnInput(
      { downloadResource: async () => Buffer.from('12345') },
      config(root),
      second,
      guard,
      false,
    );
    assert.equal(firstResult.attachmentPaths.length, 1);
    assert.equal(secondResult.attachmentPaths.length, 0);
    assert.equal(secondResult.skipped.some((value) => value.includes('workspace quota exceeded')), true);
    assert.equal(await guard.read(firstResult.attachmentPaths[0] as string), '12345');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function workspaceGuard(
  root: string,
  limits: { maxTotalBytes?: number; maxFiles?: number } = {},
): Promise<LocalWorkspaceGuard> {
  const guard = new LocalWorkspaceGuard({
    root,
    mode: 'read-only',
    maxReadBytes: 4096,
    maxWriteBytes: 4096,
    maxTotalBytes: limits.maxTotalBytes ?? 8192,
    maxFiles: limits.maxFiles ?? 32,
  });
  await guard.initialize();
  return guard;
}
