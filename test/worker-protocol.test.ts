import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deserializeError,
  serializeError,
} from '../src/pi/worker-protocol.js';

test('worker error serialization omits stack traces and incidental fields', () => {
  const error = new Error('tool failed');
  error.name = 'ToolError';
  error.stack = 'ToolError: tool failed\n    at /app/secret/path.ts:1:1';
  Object.assign(error, { token: 'should-not-cross-ipc' });

  const serialized = serializeError(error);
  assert.deepEqual(serialized, {
    name: 'ToolError',
    message: 'tool failed',
  });
  assert.equal('stack' in serialized, false);
  assert.equal('token' in serialized, false);
});

test('worker error deserialization preserves only name and message', () => {
  const error = deserializeError({ name: 'AbortError', message: 'aborted' });
  assert.equal(error.name, 'AbortError');
  assert.equal(error.message, 'aborted');
});
