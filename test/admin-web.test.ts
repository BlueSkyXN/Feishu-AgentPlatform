import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import test from 'node:test';

const root = basename(dirname(import.meta.dirname)) === '.test-dist'
  ? resolve(import.meta.dirname, '..', '..')
  : resolve(import.meta.dirname, '..');
const source = async (path: string): Promise<string> =>
  await readFile(resolve(root, path), 'utf8');

test('Admin web exposes the complete Chinese operator workflow', async () => {
  const html = await source('web/index.html');
  for (const panel of [
    'overview',
    'apps',
    'agents',
    'bindings',
    'config',
    'revisions',
    'credentials',
    'sessions',
    'approvals',
    'diagnostics',
    'audit',
  ]) {
    assert.match(html, new RegExp(`data-view="${panel}"`), `${panel} navigation is missing`);
    assert.match(html, new RegExp(`data-panel="${panel}"`), `${panel} panel is missing`);
    assert.match(html, new RegExp(`data-panel-status="${panel}"`), `${panel} status is missing`);
  }
  assert.match(html, /id="sso-form"/);
  assert.match(html, /id="sso-app-key"/);
  assert.match(html, /id="validate-draft-button"/);
  assert.match(html, /录入或轮换凭据/);
  assert.match(html, /approval=admin/);
});

test('Admin web uses the exact schema-v1 empty configuration', async () => {
  const app = await source('web/app.js');
  assert.match(
    app,
    /const EMPTY_CONFIG = Object\.freeze\(\{\s*schemaVersion: 1,\s*apps: \[\],\s*agents: \[\],\s*bindings: \[\],\s*\}\);/,
  );
  assert.match(app, /JSON\.stringify\(source\?\.document \?\? EMPTY_CONFIG, null, 2\)/);
});

test('Admin web calls only implemented workflow routes and sends CSRF on writes', async () => {
  const app = await source('web/app.js');
  for (const route of [
    '/api/admin/v1/auth/login',
    '/api/admin/v1/auth/sso/start',
    '/api/admin/v1/auth/session',
    '/api/admin/v1/overview',
    '/api/admin/v1/draft/${kind}',
    '/api/admin/v1/config/draft',
    '/api/admin/v1/draft/validate',
    '/api/admin/v1/config/publish',
    '/api/admin/v1/config/rollback',
    '/api/admin/v1/revisions',
    '/api/admin/v1/credentials',
    '/api/admin/v1/sessions',
    '/api/admin/v1/approvals',
    '/api/admin/v1/diagnostics/lark-cli',
    '/api/admin/v1/audit',
  ]) assert.ok(app.includes(route), `${route} is missing`);
  assert.match(app, /headers\['x-csrf-token'\] = state\.csrfToken/);
  assert.match(app, /credentials: 'same-origin'/);
  assert.match(app, /approvals\/\$\{encodeURIComponent\(id\)\}\/\$\{decision\}/);
  assert.match(app, /approvalCallbackConfigured/);
  assert.match(app, /approvalCallbackReady/);

  for (const [name, start, end] of [
    ['publish', 'async function publishDraft', 'async function loadRevisions'],
    ['rollback', 'async function rollbackRevision', 'async function loadCredentials'],
  ] as const) {
    const implementation = app.slice(app.indexOf(start), app.indexOf(end));
    assert.match(implementation, /runtime_apply_failed/, `${name} must recognize runtime apply failure`);
    assert.match(implementation, /markPanelsStale\(\.\.\.Object\.keys\(PANEL_LOADERS\)\)/,
      `${name} must invalidate cached server state`);
    assert.match(implementation, /loadPanel\('config', true\)/,
      `${name} must read the active revision back from the server`);
  }
});

test('Admin web never persists or renders credential plaintext', async () => {
  const [html, app] = await Promise.all([
    source('web/index.html'),
    source('web/app.js'),
  ]);
  assert.doesNotMatch(app, /localStorage|sessionStorage|indexedDB|console\./);
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.match(html, /id="credential-value" type="password" autocomplete="new-password"/);

  const saveCredential = app.slice(
    app.indexOf('async function saveCredential'),
    app.indexOf('async function deleteCredential'),
  );
  assert.ok(
    saveCredential.indexOf("valueInput.value = ''") < saveCredential.indexOf('await withBusy'),
    'credential input must be cleared before awaiting the request',
  );
  assert.doesNotMatch(saveCredential, /showNotice\([^\n]*\bvalue\b/);
});

test('Admin destructive actions require explicit confirmation and mobile states exist', async () => {
  const [app, css] = await Promise.all([
    source('web/app.js'),
    source('web/styles.css'),
  ]);
  assert.match(app, /requiredText: id/);
  assert.match(app, /requiredText: storageId/);
  assert.match(app, /confirmation !== id/);
  assert.match(app, /confirmation !== storageId/);
  assert.match(app, /mode === 'loading'/);
  assert.match(app, /mode === 'error' \|\| mode === 'unsupported'/);
  assert.match(css, /@media \(max-width: 680px\)/);
  assert.match(css, /tbody td::before \{ content: attr\(data-label\)/);
  assert.match(css, /prefers-reduced-motion/);
});

test('Admin web follows the Calm Precision visual and accessibility contract', async () => {
  const [html, css, app] = await Promise.all([
    source('web/index.html'),
    source('web/styles.css'),
    source('web/app.js'),
  ]);
  assert.match(html, /name="color-scheme" content="light dark"/);
  for (const token of [
    '--canvas: #ffffff',
    '--surface: #f7f7f8',
    '--text: #1f1f1f',
    '--accent: #005fcc',
    '--focus: #0067c0',
  ]) assert.ok(css.includes(token), `${token} is missing`);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /@media \(pointer: coarse\)/);
  assert.match(css, /button:focus-visible/);
  assert.match(css, /\.button:active:not\(:disabled\)/);
  assert.doesNotMatch(css, /linear-gradient|radial-gradient|Georgia|transition:\s*all/);
  assert.match(app, /connectionDot\.classList\.add\('online'\)/);
  assert.match(app, /connectionDot\.classList\.remove\('online'\)/);
});
