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
  const [workflow, settings] = await Promise.all([
    source('.github/workflows/hf-space.yml'),
    source('scripts/hf-space-settings.py'),
  ]);
  assert.doesNotMatch(workflow, /cp\s+"\$example"/);
  assert.match(workflow, /package-artifact\.mjs --source-sha/);
  assert.match(workflow, /hf buckets cp/);
  assert.match(workflow, /hfs-dist/);
  assert.match(workflow, /git archive --format=tar "\$SOURCE_SHA" hfs/);
  assert.match(workflow, /DEPLOYMENT_SOURCE\.json/);
  assert.match(workflow, /python3 scripts\/hf-space-settings\.py/);
  assert.doesNotMatch(workflow, /hf spaces variables add/);
  assert.match(workflow, /FAP_ARTIFACT_MANIFEST_HF_URI/);
  assert.match(workflow, /FAP_ARTIFACT_EXPECTED_SOURCE_REF/);
  assert.match(workflow, /FAP_ARTIFACT_MAX_BYTES/);
  assert.doesNotMatch(workflow, /hf spaces restart/);
  assert.match(settings, /api\.restart_space\(space_id\)/);
  assert.match(workflow, /python3 scripts\/hf-space-info\.py/);
  assert.match(workflow, /Hugging Face SDK readback contract/);
  assert.doesNotMatch(workflow, /hf spaces info|--json/);
  assert.match(workflow, /runtime_sha/);
  assert.match(workflow, /hf-space-runtime-state\.mjs/);
  assert.match(workflow, /runtime-state-latest\.json/);
  assert.match(workflow, /GET \/healthz|healthz\.json/);
  assert.match(workflow, /readyz\.json/);
  assert.match(workflow, /admin\.html/);
  assert.match(workflow, /hf-deployment-/);
  assert.match(workflow, /group: hf-space-\$\{\{ vars\.HF_SPACE_ID \}\}/);
  assert.match(workflow, /paused_since/);
  assert.match(workflow, /status: 'pending'/);
  assert.match(workflow, /status: 'failed'/);
  assert.match(workflow, /expectedHfRepositorySha/);
  assert.match(workflow, /pushed-sha\.txt/);
});

test('HFS artifact lane deployment is bound to immutable commits', async () => {
  const manifest = await source('hfs/hfs-dev.toml');
  assert.match(manifest, /^standard = "2\.0"$/mu);
  assert.match(manifest, /version_source = "commit"/);
  assert.match(manifest, /lane = "artifact"/);
  assert.match(manifest, /dist_bucket = "hfs-dist"/);
  assert.doesNotMatch(manifest, /uncommitted preview/);
});

test('HFS Space bundle is thin and bootstraps the artifact at startup', async () => {
  const [dockerfile, entrypoint, bootstrap, readme] = await Promise.all([
    source('hfs/Dockerfile'),
    source('hfs/docker/entrypoint.sh'),
    source('hfs/docker/artifact-bootstrap.mjs'),
    source('hfs/README.md'),
  ]);
  assert.match(readme, /sdk:\s*docker/u);
  assert.match(readme, /app_port:\s*7860/u);
  assert.match(dockerfile, /EXPOSE\s+7860/u);
  assert.match(dockerfile, /USER\s+node/u);
  assert.match(
    dockerfile,
    /FAP_ARTIFACT_INSTALL_ROOT=\/opt\/feishu-agent-platform\/app/u,
  );
  assert.match(
    dockerfile,
    /PATH=\/opt\/feishu-agent-platform\/app\/node_modules\/\.bin:\$PATH/u,
  );
  assert.match(
    dockerfile,
    /PLATFORM_CONFIG_ROOT=\/opt\/feishu-agent-platform\/app\/config/u,
  );
  assert.match(
    dockerfile,
    /install -d -o node -g node -m 0755 \/opt\/feishu-agent-platform \/opt\/feishu-agent-platform\/app/u,
  );
  assert.doesNotMatch(dockerfile, /MODEL_BROKER_ENABLED=true/);
  assert.doesNotMatch(dockerfile, /COPY\s+.*dist|COPY\s+.*src/u);
  assert.match(entrypoint, /FAP_ARTIFACT_MANIFEST_HF_URI/u);
  assert.match(entrypoint, /FAP_ARTIFACT_BEARER_TOKEN/u);
  assert.match(entrypoint, /FAP_ARTIFACT_EXPECTED_SOURCE_REF/u);
  assert.match(entrypoint, /cd "\$install_root"/u);
  assert.match(entrypoint, /fap-artifact-bootstrap\.mjs/u);
  assert.match(entrypoint, /exec node dist\/index\.js/u);
  assert.match(bootstrap, /sha256/u);
  assert.match(bootstrap, /payload\.tar\.gz/u);
  assert.match(bootstrap, /hfs-dist/u);
  assert.match(
    bootstrap,
    /FAP_ARTIFACT_INSTALL_ROOT \?\? '\/opt\/feishu-agent-platform\/app'/u,
  );
});

test('artifact packager ships the production runtime with config examples only', async () => {
  const packager = await source('scripts/package-artifact.mjs');
  assert.match(packager, /--omit=dev/u);
  assert.match(packager, /payload\.tar\.gz/u);
  assert.match(packager, /manifest\.json/u);
  assert.match(packager, /active YAML manifests are forbidden/u);
  assert.match(packager, /patch-pi-brace-expansion\.mjs/u);
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
