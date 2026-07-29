import assert from 'node:assert/strict';
import test from 'node:test';

import { decryptJson, encryptJson, secureEqual } from '../src/core/crypto-store.js';

test('encryptJson round-trips structured data without plaintext leakage', () => {
  const value = { token: 'sensitive-token', nested: [1, true, null] };
  const encrypted = encryptJson(value, '0123456789abcdef0123456789abcdef');
  assert.equal(encrypted.algorithm, 'aes-256-gcm');
  assert.doesNotMatch(JSON.stringify(encrypted), /sensitive-token/);
  assert.deepEqual(
    decryptJson<typeof value>(encrypted, '0123456789abcdef0123456789abcdef'),
    value,
  );
});

test('decryptJson rejects the wrong encryption key', () => {
  const encrypted = encryptJson({ value: 1 }, '0123456789abcdef');
  assert.throws(() => decryptJson(encrypted, 'fedcba9876543210'));
});

test('encryption rejects undersized secrets', () => {
  assert.throws(() => encryptJson({}, 'too-short'), /at least 16/);
});

test('secureEqual compares equal-length strings safely', () => {
  assert.equal(secureEqual('same', 'same'), true);
  assert.equal(secureEqual('same', 'diff'), false);
  assert.equal(secureEqual('same', 'longer'), false);
});
