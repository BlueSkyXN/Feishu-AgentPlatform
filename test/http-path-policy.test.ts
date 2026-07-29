import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertAssignableHttpPath,
  normalizeHttpPath,
} from '../src/http/path-policy.js';

test('normalizes a safe callback path', () => {
  assert.equal(normalizeHttpPath('/callbacks/feishu/'), '/callbacks/feishu');
  assert.equal(normalizeHttpPath('/oauth/callback'), '/oauth/callback');
});

test('rejects ambiguous and traversal callback paths', () => {
  for (const path of [
    '//evil.example/path',
    '/a//b',
    '/a/../b',
    '/a/%2e%2e/b',
    '/a/%2F/b',
    '/a\\b',
    '/a/%5cb',
    '/a?x=1',
    '/a#x',
    '/a/%00',
    '/a/%zz',
  ]) {
    assert.throws(() => normalizeHttpPath(path), { name: 'Error' }, path);
  }
});

test('keeps webhook paths away from control-plane routes', () => {
  for (const path of ['/api/x', '/admin/x', '/healthz', '/oauth/callback']) {
    assert.throws(() =>
      assertAssignableHttpPath(path, 'path', { allowOAuthPrefix: false }),
    );
  }
  assert.doesNotThrow(() =>
    assertAssignableHttpPath('/oauth/callback', 'path', {
      allowOAuthPrefix: true,
    }),
  );
});
