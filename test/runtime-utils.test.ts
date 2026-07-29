import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readJsonFile, writeJsonFileAtomic } from '../src/core/atomic-file.js';
import { formatJson, parseJsonObject, parseJsonValue } from '../src/core/json.js';
import { assertSupportedNode } from '../src/runtime/node-version.js';

test('atomic JSON writes replace a complete document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-pi-atomic-'));
  const path = join(root, 'state.json');
  try {
    await writeJsonFileAtomic(path, { version: 1 });
    await writeJsonFileAtomic(path, { version: 2, ok: true });
    assert.deepEqual(await readJsonFile(path), { version: 2, ok: true });
    assert.match(await readFile(path, 'utf8'), /"version": 2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('JSON helpers enforce object shape and bounded output', () => {
  assert.deepEqual(parseJsonObject('{"a":1}', 'value'), { a: 1 });
  assert.equal(parseJsonValue('false', 'value'), false);
  assert.throws(() => parseJsonObject('[]', 'value'), /JSON object/);
  assert.throws(() => parseJsonValue('{', 'value'), /valid JSON/);
  assert.match(formatJson({ text: 'x'.repeat(100) }, 20), /truncated/);
});

test('Node version guard matches the pinned Pi runtime requirement', () => {
  assert.throws(() => assertSupportedNode('22.18.0'), />=22\.19\.0/);
  assert.doesNotThrow(() => assertSupportedNode('22.19.0'));
  assert.doesNotThrow(() => assertSupportedNode('24.0.0'));
});
