import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..');

interface ArtifactUri {
  namespace: string;
  bucket: string;
  project: string;
  slot: string;
  sourceSha: string;
  url: string;
}

interface PackagerModule {
  ARTIFACT_PROJECT: string;
  buildManifest(input: {
    project: string;
    slot: string;
    sourceSha: string;
    sha256: string;
    bytes: number;
    createdAt: string;
  }): unknown;
  copyConfigExamples(sourceRoot: string, stagingRoot: string): Promise<string[]>;
  manifestUri(
    namespace: string,
    bucket: string,
    project: string,
    slot: string,
    sourceSha: string,
  ): string;
}

interface BootstrapModule {
  assertTarListingSafe(listing: string): void;
  parseManifestUri(uri: string): ArtifactUri;
  validateManifest(
    raw: unknown,
    options: { uri: ArtifactUri; expectedSourceRef: string; maxBytes: number },
  ): { sourceRef: string; sha256: string; bytes: number; url: string };
}

async function loadModule<T>(path: string): Promise<T> {
  return await import(pathToFileURL(resolve(root, path)).href) as T;
}

test('artifact producer URI and manifest are accepted by the runtime consumer', async () => {
  const [packager, bootstrap] = await Promise.all([
    loadModule<PackagerModule>('scripts/package-artifact.mjs'),
    loadModule<BootstrapModule>('hfs/docker/artifact-bootstrap.mjs'),
  ]);
  const sourceSha = 'a'.repeat(40);
  const uriValue = packager.manifestUri(
    'BlueSkyXN',
    'hfs-dist',
    packager.ARTIFACT_PROJECT,
    'edge',
    sourceSha,
  );

  const uri = bootstrap.parseManifestUri(uriValue);
  assert.deepEqual(uri, {
    namespace: 'BlueSkyXN',
    bucket: 'hfs-dist',
    project: 'feishu-agent-platform',
    slot: 'edge',
    sourceSha,
    url: `https://huggingface.co/buckets/BlueSkyXN/hfs-dist/resolve/feishu-agent-platform/edge/${sourceSha}/manifest.json`,
  });

  const sha256 = 'a'.repeat(64);
  const manifest = packager.buildManifest({
    project: packager.ARTIFACT_PROJECT,
    slot: 'edge',
    sourceSha,
    sha256,
    bytes: 1234,
    createdAt: '2026-07-30T00:00:00Z',
  });
  assert.deepEqual(
    bootstrap.validateManifest(manifest, { uri, expectedSourceRef: sourceSha, maxBytes: 2000 }),
    {
      sourceRef: sourceSha,
      sha256,
      bytes: 1234,
      url: `https://huggingface.co/buckets/BlueSkyXN/hfs-dist/resolve/feishu-agent-platform/edge/${sourceSha}/payload.tar.gz`,
    },
  );
});

test('artifact bootstrap accepts in-root npm bin symlinks and rejects escaping links', async () => {
  const bootstrap = await loadModule<BootstrapModule>('hfs/docker/artifact-bootstrap.mjs');
  const listing = [
    'drwxr-xr-x user/group 0 2026-07-30 00:00 ./',
    'drwxr-xr-x user/group 0 2026-07-30 00:00 ./node_modules/',
    'drwxr-xr-x user/group 0 2026-07-30 00:00 ./node_modules/.bin/',
    'drwxr-xr-x user/group 0 2026-07-30 00:00 ./node_modules/openai/',
    'drwxr-xr-x user/group 0 2026-07-30 00:00 ./node_modules/openai/bin/',
    '-rwxr-xr-x user/group 123 2026-07-30 00:00 ./node_modules/openai/bin/cli',
    'lrwxr-xr-x user/group 0 2026-07-30 00:00 ./node_modules/.bin/openai -> ../openai/bin/cli',
  ].join('\n');

  assert.doesNotThrow(() => bootstrap.assertTarListingSafe(listing));
  assert.throws(
    () => bootstrap.assertTarListingSafe(
      `${listing}\nlrwxr-xr-x user/group 0 2026-07-30 00:00 ./node_modules/.bin/escape -> ../../../etc/passwd`,
    ),
    /unsafe payload symlink target/u,
  );
});

test('artifact packager copies *.yaml.example files and rejects active YAML', async () => {
  const packager = await loadModule<PackagerModule>('scripts/package-artifact.mjs');
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), 'fap-config-contract-'));
  const sourceRoot = resolve(fixtureRoot, 'source');
  const configRoot = resolve(sourceRoot, 'config', 'apps');
  const stagingRoot = resolve(fixtureRoot, 'staging');

  try {
    await mkdir(configRoot, { recursive: true });
    await writeFile(resolve(configRoot, 'primary.yaml.example'), 'app_id: example\n', 'utf8');
    await writeFile(resolve(configRoot, 'notes.txt'), 'ignored\n', 'utf8');

    assert.deepEqual(await packager.copyConfigExamples(sourceRoot, stagingRoot), [
      'apps/primary.yaml.example',
    ]);
    assert.equal(
      await readFile(resolve(stagingRoot, 'config', 'apps', 'primary.yaml.example'), 'utf8'),
      'app_id: example\n',
    );

    await writeFile(resolve(configRoot, 'active.yaml'), 'app_id: forbidden\n', 'utf8');
    await assert.rejects(
      packager.copyConfigExamples(sourceRoot, resolve(fixtureRoot, 'rejected-staging')),
      /active YAML manifests are forbidden.*apps\/active\.yaml/u,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
