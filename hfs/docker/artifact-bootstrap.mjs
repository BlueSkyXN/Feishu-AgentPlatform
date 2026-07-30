#!/usr/bin/env node
/**
 * Manifest-first artifact installer for the Hugging Face Space runtime.
 *
 * Downloads an immutable payload tarball from the private hfs-dist bucket,
 * verifies source ref, sha256 and size limits, checks the tar listing for
 * unsafe entries, and installs it into the image-owned app root.
 * Runs with no third-party dependencies inside node:24-bookworm-slim.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const PROJECT = 'feishu-agent-platform';
export const BUCKET = 'hfs-dist';
export const SCHEMA_VERSION = 2;
export const SLOTS = new Set(['edge', 'release']);
const GIT_SHA_RE = /^[0-9a-f]{40}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const NAMESPACE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_TAR_MEMBERS = 100000;
const MAX_EXTRACTED_BYTES = 8 * 1024 * 1024 * 1024;
const HF_HOST_SUFFIX = '.huggingface.co';

export class ContractError extends Error {}

export function parseManifestUri(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new ContractError('FAP_ARTIFACT_MANIFEST_HF_URI is not a valid URL.');
  }
  if (parsed.protocol !== 'hf:' || parsed.hostname !== 'buckets' || parsed.search || parsed.hash) {
    throw new ContractError('FAP_ARTIFACT_MANIFEST_HF_URI must be an hf://buckets URI without query or fragment.');
  }
  const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length !== 6 || parts.some((part) => part === '.' || part === '..' || part.includes('\\'))) {
    throw new ContractError('artifact manifest URI must contain six safe path segments.');
  }
  const [namespace, bucket, project, slot, sourceSha, filename] = parts;
  if (!NAMESPACE_RE.test(namespace)) throw new ContractError('artifact manifest URI namespace is invalid.');
  if (bucket !== BUCKET || project !== PROJECT || !SLOTS.has(slot)) {
    throw new ContractError(`artifact manifest URI must select ${BUCKET}/${PROJECT}/<edge|release>.`);
  }
  if (filename !== 'manifest.json') {
    throw new ContractError('artifact manifest URI must end with manifest.json.');
  }
  if (!GIT_SHA_RE.test(sourceSha)) {
    throw new ContractError('artifact manifest URI must pin a full lowercase source commit SHA.');
  }
  const key = parts.slice(2).map(encodeURIComponent).join('/');
  return {
    namespace,
    bucket,
    project,
    slot,
    sourceSha,
    url: `https://huggingface.co/buckets/${encodeURIComponent(namespace)}/${bucket}/resolve/${key}`,
  };
}

export function validateManifest(raw, { uri, expectedSourceRef, maxBytes }) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ContractError('artifact manifest must be a JSON object.');
  }
  if (raw.schema_version !== SCHEMA_VERSION) {
    throw new ContractError(`artifact manifest schema_version must be ${SCHEMA_VERSION}.`);
  }
  if (raw.project !== PROJECT || raw.slot !== uri.slot) {
    throw new ContractError('artifact manifest project or slot does not match the manifest URI.');
  }
  const source = raw.source;
  if (typeof source !== 'object' || source === null || source.kind !== 'commit' || !GIT_SHA_RE.test(source.ref ?? '')) {
    throw new ContractError('artifact manifest source must be a commit ref.');
  }
  if (source.ref !== uri.sourceSha) {
    throw new ContractError('artifact manifest source ref does not match the manifest URI.');
  }
  if (expectedSourceRef && source.ref !== expectedSourceRef) {
    throw new ContractError('artifact manifest source ref does not match FAP_ARTIFACT_EXPECTED_SOURCE_REF.');
  }
  const artifact = raw.artifact;
  if (typeof artifact !== 'object' || artifact === null) {
    throw new ContractError('artifact manifest requires an artifact object.');
  }
  if (artifact.filename !== 'payload.tar.gz') {
    throw new ContractError('artifact filename must be payload.tar.gz.');
  }
  const expectedKey = `${PROJECT}/${uri.slot}/${source.ref}/payload.tar.gz`;
  if (artifact.key !== expectedKey) {
    throw new ContractError(`artifact key must be ${expectedKey}.`);
  }
  if (!SHA256_RE.test(artifact.sha256 ?? '')) {
    throw new ContractError('artifact sha256 must be a lowercase hex digest.');
  }
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || artifact.bytes > maxBytes) {
    throw new ContractError('artifact bytes must be positive and within FAP_ARTIFACT_MAX_BYTES.');
  }
  return {
    sourceRef: source.ref,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    url: `https://huggingface.co/buckets/${encodeURIComponent(uri.namespace)}/${uri.bucket}/resolve/${artifact.key.split('/').map(encodeURIComponent).join('/')}`,
  };
}

export function assertTarListingSafe(listing) {
  const lines = listing.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new ContractError('payload archive is empty.');
  if (lines.length > MAX_TAR_MEMBERS) {
    throw new ContractError(`payload archive exceeds ${MAX_TAR_MEMBERS} members.`);
  }
  let totalBytes = 0;
  for (const line of lines) {
    const match = /^(\S+)\s+\S+\/\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/u.exec(line);
    if (!match) throw new ContractError(`unparseable tar listing entry: ${line.slice(0, 120)}`);
    const [, mode, sizeText, name] = match;
    totalBytes += Number.parseInt(sizeText, 10);
    if (totalBytes > MAX_EXTRACTED_BYTES) {
      throw new ContractError('payload archive exceeds the extracted size limit.');
    }
    if (name.startsWith('/') || name.includes('..') || name.includes('\\') || name.includes(':')) {
      throw new ContractError(`unsafe payload member path: ${name.slice(0, 120)}`);
    }
    if (!mode.startsWith('-') && !mode.startsWith('d')) {
      throw new ContractError(`payload member must be a regular file or directory: ${name.slice(0, 120)}`);
    }
  }
}

async function download(url, token, destination, maxBytes) {
  let current = url;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const headers = {};
    const host = new URL(current).hostname;
    if (host === 'huggingface.co' || host.endsWith(HF_HOST_SUFFIX)) {
      headers.authorization = `Bearer ${token}`;
    }
    const response = await fetch(current, { headers, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new ContractError('redirect without Location header.');
      current = new URL(location, current).toString();
      if (!current.startsWith('https://')) throw new ContractError('redirect to non-HTTPS URL refused.');
      continue;
    }
    if (!response.ok || !response.body) {
      throw new ContractError(`download failed with HTTP ${response.status}.`);
    }
    let received = 0;
    const counting = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > maxBytes) {
          callback(new ContractError('download exceeded the size limit.'));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(response.body, counting, createWriteStream(destination, { mode: 0o600 }));
    return received;
  }
  throw new ContractError('too many redirects.');
}

async function sha256File(path) {
  const buffer = await readFile(path);
  return createHash('sha256').update(buffer).digest('hex');
}

function log(message) {
  process.stderr.write(`[fap-artifact-bootstrap] ${message}\n`);
}

async function main() {
  const manifestUriValue = process.env.FAP_ARTIFACT_MANIFEST_HF_URI;
  const bearerToken = process.env.FAP_ARTIFACT_BEARER_TOKEN;
  const expectedSourceRef = process.env.FAP_ARTIFACT_EXPECTED_SOURCE_REF ?? '';
  const installRoot = process.env.FAP_ARTIFACT_INSTALL_ROOT ?? '/opt/app';
  const maxBytes = Number.parseInt(process.env.FAP_ARTIFACT_MAX_BYTES ?? '2147483648', 10);
  if (!manifestUriValue) throw new ContractError('FAP_ARTIFACT_MANIFEST_HF_URI is required.');
  if (!bearerToken || /\s/u.test(bearerToken)) {
    throw new ContractError('FAP_ARTIFACT_BEARER_TOKEN is required and must not contain whitespace.');
  }
  if (!GIT_SHA_RE.test(expectedSourceRef)) {
    throw new ContractError('FAP_ARTIFACT_EXPECTED_SOURCE_REF must be a full lowercase commit SHA.');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new ContractError('FAP_ARTIFACT_MAX_BYTES must be a positive integer.');
  }

  const uri = parseManifestUri(manifestUriValue);
  const tempRoot = await mkdtemp(join(tmpdir(), 'fap-artifact-download-'));
  try {
    const manifestPath = join(tempRoot, 'manifest.json');
    await download(uri.url, bearerToken, manifestPath, MAX_MANIFEST_BYTES);
    const manifest = validateManifest(JSON.parse(await readFile(manifestPath, 'utf8')), {
      uri,
      expectedSourceRef,
      maxBytes,
    });

    const payloadPath = join(tempRoot, 'payload.tar.gz');
    const received = await download(manifest.url, bearerToken, payloadPath, maxBytes);
    if (received !== manifest.bytes) {
      throw new ContractError(`payload size mismatch: expected ${manifest.bytes}, got ${received}.`);
    }
    const digest = await sha256File(payloadPath);
    if (digest !== manifest.sha256) {
      throw new ContractError('payload sha256 mismatch.');
    }

    const listing = spawnSync('tar', ['-tvzf', payloadPath], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (listing.status !== 0) throw new ContractError('payload archive listing failed.');
    assertTarListingSafe(listing.stdout);

    const extractRoot = join(tempRoot, 'extract');
    await mkdir(extractRoot, { recursive: true });
    const extract = spawnSync('tar', ['-xzf', payloadPath, '-C', extractRoot], { encoding: 'utf8' });
    if (extract.status !== 0) throw new ContractError('payload archive extraction failed.');
    await stat(resolve(extractRoot, 'dist', 'index.js')).catch(() => {
      throw new ContractError('payload is missing dist/index.js.');
    });

    const installParent = resolve(installRoot, '..');
    const staged = join(installParent, `.app-next-${manifest.sourceRef}`);
    await mkdir(installParent, { recursive: true });
    await rm(staged, { recursive: true, force: true });
    await cp(extractRoot, staged, { recursive: true });
    await writeFile(join(staged, '.artifact-source-ref'), `${manifest.sourceRef}\n`, { mode: 0o600 });
    await rm(installRoot, { recursive: true, force: true });
    await rename(staged, installRoot);
    log(`installed artifact for ${manifest.sourceRef} into ${installRoot}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    log(error instanceof ContractError ? error.message : `bootstrap failed: ${error?.message ?? error}`);
    process.exit(65);
  });
}
