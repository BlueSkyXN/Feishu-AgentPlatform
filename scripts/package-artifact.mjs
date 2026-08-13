#!/usr/bin/env node
/**
 * Build the Hugging Face artifact-lane payload for an immutable source commit.
 *
 * The payload tarball is the product runtime only. It never contains the
 * TypeScript source tree, tests, docs, workflows, or any non-example YAML.
 * Output: <out-dir>/payload.tar.gz and <out-dir>/manifest.json, ready for
 * upload to the hfs-dist bucket under feishu-agent-platform/<slot>/<sha>/.
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const ARTIFACT_PROJECT = 'feishu-agent-platform';
export const ARTIFACT_MANIFEST_SCHEMA_VERSION = 2;
export const PAYLOAD_FILENAME = 'payload.tar.gz';
export const MANIFEST_FILENAME = 'manifest.json';

const SOURCE_REPOSITORY = 'https://github.com/BlueSkyXN/Feishu-AgentPlatform.git';
const PAYLOAD_STATIC_FILES = ['package.json', 'package-lock.json'];
const PAYLOAD_STATIC_DIRS = ['dist', 'web', 'prompts', 'skills', 'vendor'];

export function artifactKey(project, slot, sourceSha, filename) {
  return `${project}/${slot}/${sourceSha}/${filename}`;
}

export function manifestUri(namespace, bucket, project, slot, sourceSha) {
  return `hf://buckets/${namespace}/${bucket}/${artifactKey(project, slot, sourceSha, MANIFEST_FILENAME)}`;
}

export function buildManifest({ project, slot, sourceSha, sha256, bytes, createdAt }) {
  return {
    schema_version: ARTIFACT_MANIFEST_SCHEMA_VERSION,
    project,
    slot,
    source: {
      kind: 'commit',
      repository: SOURCE_REPOSITORY,
      ref: sourceSha,
    },
    artifact: {
      filename: PAYLOAD_FILENAME,
      key: artifactKey(project, slot, sourceSha, PAYLOAD_FILENAME),
      sha256,
      bytes,
    },
    created_at: createdAt,
  };
}

export function assertValidSourceSha(sourceSha) {
  if (!/^[0-9a-f]{40}$/u.test(sourceSha ?? '')) {
    throw new Error('source SHA must be a full lowercase 40-character commit id.');
  }
}

export function assertValidSlot(slot) {
  if (!/^(edge|release)$/u.test(slot ?? '')) {
    throw new Error(`artifact slot must be edge or release, got: ${slot}`);
  }
}

async function assertNoSymlinks(directory, label) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`${label} must not contain symlinks: ${full}`);
    }
    if (entry.isDirectory()) await assertNoSymlinks(full, label);
  }
}

export async function copyConfigExamples(sourceRoot, stagingRoot) {
  const configRoot = resolve(sourceRoot, 'config');
  const failures = [];
  const copied = [];
  async function walk(relative) {
    const absolute = resolve(configRoot, relative);
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (/\.ya?ml$/u.test(entry.name)) {
        failures.push(rel);
        continue;
      }
      if (!/\.ya?ml\.example$/u.test(entry.name)) continue;
      const target = resolve(stagingRoot, 'config', rel);
      await mkdir(resolve(target, '..'), { recursive: true });
      await cp(resolve(configRoot, rel), target);
      copied.push(rel);
    }
  }
  await walk('');
  if (failures.length > 0) {
    throw new Error(
      `active YAML manifests are forbidden in the artifact payload: ${failures.join(', ')}`,
    );
  }
  if (copied.length === 0) {
    throw new Error('artifact payload requires at least one config/*.example file.');
  }
  return copied;
}

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`);
  }
}

async function sha256File(path) {
  const buffer = await readFile(path);
  return createHash('sha256').update(buffer).digest('hex');
}

async function main() {
  const args = process.argv.slice(2);
  const valueOf = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const sourceSha = valueOf('--source-sha');
  const slot = valueOf('--slot') ?? 'edge';
  const outDir = resolve(valueOf('--out') ?? 'artifacts');
  assertValidSourceSha(sourceSha);
  assertValidSlot(slot);

  const sourceRoot = resolve(new URL('..', import.meta.url).pathname);
  for (const required of [...PAYLOAD_STATIC_FILES, ...PAYLOAD_STATIC_DIRS]) {
    await stat(resolve(sourceRoot, required)).catch(() => {
      throw new Error(`payload input is missing: ${required} (run npm run build first)`);
    });
  }

  const staging = await mkdtemp(join(tmpdir(), 'fap-artifact-'));
  try {
    for (const directory of PAYLOAD_STATIC_DIRS) {
      await cp(resolve(sourceRoot, directory), join(staging, directory), { recursive: true });
    }
    for (const file of PAYLOAD_STATIC_FILES) {
      await cp(resolve(sourceRoot, file), join(staging, file));
    }
    const examples = await copyConfigExamples(sourceRoot, staging);
    await assertNoSymlinks(staging, 'artifact payload');

    run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: staging });

    await mkdir(outDir, { recursive: true });
    const payloadPath = join(outDir, PAYLOAD_FILENAME);
    await rm(payloadPath, { force: true });
    run('tar', ['-czf', payloadPath, '-C', staging, '.'], { cwd: staging });

    const sha256 = await sha256File(payloadPath);
    const bytes = (await stat(payloadPath)).size;
    const manifest = buildManifest({
      project: ARTIFACT_PROJECT,
      slot,
      sourceSha,
      sha256,
      bytes,
      createdAt: new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z'),
    });
    const manifestPath = join(outDir, MANIFEST_FILENAME);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    console.log(
      [
        `payload=${payloadPath}`,
        `sha256=${sha256}`,
        `bytes=${bytes}`,
        `config_examples=${examples.length}`,
        `manifest=${manifestPath}`,
        `manifest_uri=${manifestUri('BlueSkyXN', 'hfs-dist', ARTIFACT_PROJECT, slot, sourceSha)}`,
      ].join('\n'),
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  await main();
}
