import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReadOnlyOpenApiRule } from '../src/config/types.js';
import { assertReadOnlyAllowed, normalizeOpenApiPath } from '../src/feishu/openapi-policy.js';

const rules: ReadOnlyOpenApiRule[] = [
  { pathPrefix: '/open-apis/docx/v1/documents' },
];

test('normalized OpenAPI paths pass unchanged', () => {
  assert.equal(
    normalizeOpenApiPath('/open-apis/docx/v1/documents/abc/raw_content'),
    '/open-apis/docx/v1/documents/abc/raw_content',
  );
});

test('OpenAPI traversal, URLs, query strings and encoded separators are rejected', () => {
  for (const value of [
    'https://open.feishu.cn/open-apis/x',
    '/open-apis/../auth/v3/tenant_access_token/internal',
    '/open-apis/%2e%2e/auth',
    '/open-apis/docx%2fsecret',
    '/open-apis//docx',
    '/open-apis/docx?x=1',
    '/open-apis/docx\\x',
  ]) {
    assert.throws(() => normalizeOpenApiPath(value), /normalized/);
  }
});

test('generic OpenAPI only permits GET and segment-boundary allowlist matches', () => {
  assert.doesNotThrow(() =>
    assertReadOnlyAllowed('GET', '/open-apis/docx/v1/documents/abc', rules),
  );
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    assert.throws(
      () => assertReadOnlyAllowed(method, '/open-apis/docx/v1/documents/abc', rules),
      /read-only/,
    );
  }
  assert.throws(() =>
    assertReadOnlyAllowed('GET', '/open-apis/docx/v1/documents-private', rules),
  );
});
