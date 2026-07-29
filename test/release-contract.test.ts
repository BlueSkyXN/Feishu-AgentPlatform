import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..');
const source = async (path: string): Promise<string> =>
  await readFile(resolve(root, path), 'utf8');

async function missing(path: string): Promise<boolean> {
  try {
    await access(resolve(root, path));
    return false;
  } catch {
    return true;
  }
}

test('release is TypeScript ESM version 0.1.0', async () => {
  const pkg = JSON.parse(await source('package.json')) as Record<string, unknown>;
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.type, 'module');
  assert.match(await source('src/config/types.ts'), /APP_VERSION = '0\.1\.0'/);
});

test('only WorkspaceGuard remains: no code runner, native sandbox, shell, or SSH dependency', async () => {
  for (const path of [
    'src/sandbox/code-runner',
    'native',
    'scripts/build-sandbox-rootfs.sh',
    'scripts/test-installed-code-runner.sh',
  ]) assert.equal(await missing(path), true, `${path} must not exist`);
  const combined = [
    await source('src/config/types.ts'),
    await source('src/tools/catalog.ts'),
    await source('package.json'),
    await source('Dockerfile'),
  ].join('\n');
  assert.doesNotMatch(combined, /code\.run|CODE_RUNNER_|setuid|chroot|seccomp/i);
  assert.doesNotMatch(combined, /"(?:ssh2|node-ssh|node-pty)"/i);
});

test('Pi tools are Host-brokered and lark-cli never invokes a shell', async () => {
  const processSession = await source('src/pi/process-session.ts');
  assert.match(processSession, /tool_request/);
  assert.match(processSession, /broker\.execute/);
  const cli = await source('src/tools/lark-cli.ts');
  assert.match(cli, /shell:\s*false/);
  assert.match(cli, /--app-secret-stdin/);
  assert.doesNotMatch(cli, /env\.(?:LARK|FEISHU)_APP_(?:ID|SECRET)\s*=/);
});

test('Docker dependency stages provide the pinned lark-cli installer without adding curl to runtime', async () => {
  const dockerfile = await source('Dockerfile');
  assert.match(
    dockerfile,
    /FROM node:24-bookworm-slim AS dependency-base[\s\S]*?install -y --no-install-recommends ca-certificates curl/,
  );
  const runtime = dockerfile.slice(dockerfile.indexOf('FROM node:24-bookworm-slim AS runtime'));
  assert.doesNotMatch(runtime, /install -y --no-install-recommends[^\n]*\bcurl\b/);
});

test('model gateway credential stays in Host model broker', async () => {
  const environment = await source('src/pi/model-env.ts');
  assert.doesNotMatch(environment, /copy\(['"]CLOUDFLARE/);
  const broker = await source('src/model/model-broker.ts');
  assert.match(broker, /cf-aig-authorization/);
  assert.match(broker, /capabilities/);
  const sessionCore = await source('src/pi/session-core.ts');
  assert.match(sessionCore, /InMemoryCredentialStore/);
  assert.match(sessionCore, /modelBroker\.capability/);
});

test('HF production image keeps first-run setup mode independent from model credentials', async () => {
  const [dockerfile, hostConfig] = await Promise.all([
    source('Dockerfile'),
    source('src/config/load-host.ts'),
  ]);
  assert.doesNotMatch(dockerfile, /MODEL_BROKER_ENABLED=true/);
  assert.match(hostConfig, /Boolean\(upstreamBaseUrl && upstreamApiKey\)/);
});

test('HF preflight evaluates the Git-visible upload set and rejects sensitive paths', async () => {
  const preflight = await source('scripts/hf-space-preflight.mjs');
  assert.match(preflight, /gitVisibleFiles/);
  assert.match(preflight, /isSensitiveReleasePath/);
  assert.doesNotMatch(preflight, /readdir\(directory/);
});

test('CI/CD verifies one immutable source before invoking HF and GHCR publishers', async () => {
  const [ci, gate, hf, container] = await Promise.all([
    source('.github/workflows/ci.yml'),
    source('.github/workflows/quality-gate.yml'),
    source('.github/workflows/hf-space.yml'),
    source('.github/workflows/container.yml'),
  ]);
  assert.match(ci, /name: CI\/CD/);
  assert.match(ci, /uses: \.\/\.github\/workflows\/quality-gate\.yml/);
  assert.equal((ci.match(/quality-gate\.yml/gu) ?? []).length, 1);
  assert.match(ci, /needs: \[resolve, quality\][\s\S]*?uses: \.\/\.github\/workflows\/hf-space\.yml/);
  assert.match(ci, /needs: \[resolve, quality\][\s\S]*?uses: \.\/\.github\/workflows\/container\.yml/);
  assert.match(gate, /workflow_call:/);
  assert.match(hf, /workflow_call:/);
  assert.match(container, /workflow_call:/);
  assert.match(container, /type=raw,value=sha-\$\{\{ inputs\.source_sha \}\}/);
  assert.doesNotMatch(container, /type=ref|type=sha,prefix/);
  assert.doesNotMatch(hf, /uses: \.\/\.github\/workflows\/quality-gate\.yml/);
  assert.doesNotMatch(container, /uses: \.\/\.github\/workflows\/quality-gate\.yml/);
});

test('HF deployment preserves setup mode and verifies the exact remote runtime', async () => {
  const workflow = await source('.github/workflows/hf-space.yml');
  assert.doesNotMatch(workflow, /cp\s+"\$example"/);
  assert.match(workflow, /active YAML manifests are forbidden/);
  assert.match(workflow, /DEPLOYMENT_SOURCE\.json/);
  assert.match(workflow, /hf spaces info/);
  assert.match(workflow, /runtime_sha/);
  assert.match(workflow, /runtime\.sha \?\? "pending"/);
  assert.match(workflow, /GET \/healthz|healthz\.json/);
  assert.match(workflow, /readyz\.json/);
  assert.match(workflow, /admin\.html/);
  assert.match(workflow, /hf-deployment-/);
});

test('HFS source deployment is bound to immutable commits', async () => {
  const manifest = await source('hfs-dev.toml');
  assert.match(manifest, /version_source = "commit"/);
  assert.doesNotMatch(manifest, /uncommitted preview/);
});

test('Pi nested brace-expansion is patched to the audited version', async () => {
  const manifest = JSON.parse(
    await source(
      'node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion/package.json',
    ),
  ) as { version?: string };
  assert.equal(manifest.version, '5.0.8');
  assert.match(await source('package.json'), /patch-pi-brace-expansion\.mjs/);
});

test('office Skills remain vendored and explicitly selectable', async () => {
  for (const path of [
    'vendor/skills/lark-im-readonly/SKILL.md',
    'vendor/skills/lark-doc-readonly/SKILL.md',
    'vendor/skills/lark-calendar-readonly/SKILL.md',
  ]) assert.equal(await missing(path), false, `${path} is missing`);
});
