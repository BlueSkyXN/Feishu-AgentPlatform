#!/usr/bin/env node
import { access, lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  gitVisibleFiles,
  isSensitiveReleasePath,
} from './release-utils.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const bundleRoot = resolve(root, 'hfs');
const failures = [];
const warnings = [];

const readme = await readFile(resolve(bundleRoot, 'README.md'), 'utf8');
const dockerfile = await readFile(resolve(bundleRoot, 'Dockerfile'), 'utf8');
const manifest = await readFile(resolve(bundleRoot, 'hfs-dev.toml'), 'utf8');
const entrypoint = await readFile(resolve(bundleRoot, 'docker/entrypoint.sh'), 'utf8');
const bootstrap = await readFile(resolve(bundleRoot, 'docker/artifact-bootstrap.mjs'), 'utf8');

// The artifact lane ships a thin bundle only: the Space repository must never
// contain product source, tests, docs, workflows, or runtime-local files.
const EXPECTED_BUNDLE_FILES = new Set([
  'Dockerfile',
  'README.md',
  'docker/artifact-bootstrap.mjs',
  'docker/entrypoint.sh',
  'hfs-dev.toml',
]);

const bundleFiles = (await gitVisibleFiles(root))
  .filter((rel) => rel.startsWith('hfs/'))
  .map((rel) => rel.slice('hfs/'.length));

for (const rel of bundleFiles) {
  if (!EXPECTED_BUNDLE_FILES.has(rel)) {
    failures.push(`Unexpected file in the Space bundle: hfs/${rel}`);
  }
  if (isSensitiveReleasePath(`hfs/${rel}`)) {
    failures.push(`Secret-bearing file must not be uploaded to Space: hfs/${rel}`);
  }
  const file = resolve(bundleRoot, rel);
  const info = await lstat(file);
  if (info.isSymbolicLink()) failures.push(`Space bundle must not contain symlinks: hfs/${rel}`);
  if (info.size > 1024 * 1024) warnings.push(`hfs/${rel} is larger than 1 MiB.`);
}
for (const expected of EXPECTED_BUNDLE_FILES) {
  if (!bundleFiles.includes(expected)) {
    failures.push(`Space bundle file is missing or not Git-visible: hfs/${expected}`);
  }
}

for (const path of [
  'config/apps/primary.yaml.example',
  'config/agents/general.yaml.example',
  'config/bindings/primary-general.yaml.example',
]) {
  try {
    await access(resolve(root, path));
  } catch {
    failures.push(`Required payload configuration example is missing: ${path}`);
  }
}

for (const [value, pattern, message] of [
  [readme, /^---\n[\s\S]*?sdk:\s*docker\b[\s\S]*?---/u, 'hfs/README.md must contain Hugging Face Docker Space metadata.'],
  [readme, /app_port:\s*7860\b/u, 'hfs/README.md must declare app_port: 7860.'],
  [dockerfile, /EXPOSE\s+7860\b/u, 'hfs/Dockerfile must expose port 7860.'],
  [dockerfile, /USER\s+node\b/u, 'hfs/Dockerfile runtime must remain non-root.'],
  [dockerfile, /docker\/artifact-bootstrap\.mjs/u, 'hfs/Dockerfile must copy the artifact bootstrap.'],
  [entrypoint, /fap-artifact-bootstrap\.mjs/u, 'hfs/docker/entrypoint.sh must invoke the artifact bootstrap.'],
  [bootstrap, /FAP_ARTIFACT_MANIFEST_HF_URI/u, 'artifact bootstrap must resolve the manifest pointer.'],
  [bootstrap, /FAP_ARTIFACT_EXPECTED_SOURCE_REF/u, 'artifact bootstrap must pin the expected source ref.'],
  [bootstrap, /FAP_ARTIFACT_BEARER_TOKEN/u, 'artifact bootstrap must require the bucket bearer token.'],
  [manifest, /lane = "artifact"/u, 'hfs/hfs-dev.toml must declare the artifact lane.'],
  [manifest, /dist_bucket = "hfs-dist"/u, 'hfs/hfs-dev.toml must pin the hfs-dist bucket.'],
]) if (!pattern.test(value)) failures.push(message);

if (/MODEL_BROKER_ENABLED=true/u.test(dockerfile)) {
  failures.push(
    'hfs/Dockerfile must not force MODEL_BROKER_ENABLED=true; setup mode must start before model credentials exist.',
  );
}

if (failures.length) {
  for (const failure of failures) console.error(`HF-PREFLIGHT: ${failure}`);
  process.exitCode = 1;
} else {
  for (const warning of warnings) console.warn(`HF-PREFLIGHT-WARN: ${warning}`);
  console.log(`Hugging Face Space bundle preflight passed: ${bundleFiles.length} Git-visible bundle file(s).`);
}
