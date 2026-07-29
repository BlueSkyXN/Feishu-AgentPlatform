#!/usr/bin/env node
import { access, lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  gitVisibleFiles,
  isSensitiveReleasePath,
} from './release-utils.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const failures = [];
const warnings = [];

const readme = await readFile(resolve(root, 'README.md'), 'utf8');
const dockerfile = await readFile(resolve(root, 'Dockerfile'), 'utf8');

for (const path of [
  'config/apps/primary.yaml.example',
  'config/agents/general.yaml.example',
  'config/bindings/primary-general.yaml.example',
]) {
  try {
    await access(resolve(root, path));
  } catch {
    failures.push(`Required Space configuration example is missing: ${path}`);
  }
}

for (const [value, pattern, message] of [
  [readme, /^---\n[\s\S]*?sdk:\s*docker\b[\s\S]*?---/u, 'README.md must contain Hugging Face Docker Space metadata.'],
  [readme, /app_port:\s*7860\b/u, 'README.md must declare app_port: 7860.'],
  [dockerfile, /EXPOSE\s+7860\b/u, 'Dockerfile must expose port 7860.'],
  [dockerfile, /USER\s+node\b/u, 'Dockerfile runtime must remain non-root.'],
]) if (!pattern.test(value)) failures.push(message);

if (/MODEL_BROKER_ENABLED=true/u.test(dockerfile)) {
  failures.push(
    'Dockerfile must not force MODEL_BROKER_ENABLED=true; setup mode must start before model credentials exist.',
  );
}

const releasePaths = await gitVisibleFiles(root);
for (const rel of releasePaths) {
  if (isSensitiveReleasePath(rel)) {
    failures.push(`Secret-bearing file must not be uploaded to Space: ${rel}`);
  }
  const file = resolve(root, rel);
  const info = await lstat(file);
  if (info.isSymbolicLink()) failures.push(`Space source must not contain symlinks: ${rel}`);
  if (info.size > 10 * 1024 * 1024) warnings.push(`${rel} is larger than 10 MiB.`);
}

if (failures.length) {
  for (const failure of failures) console.error(`HF-PREFLIGHT: ${failure}`);
  process.exitCode = 1;
} else {
  for (const warning of warnings) console.warn(`HF-PREFLIGHT-WARN: ${warning}`);
  console.log(`Hugging Face Space preflight passed: ${releasePaths.length} Git-visible file(s).`);
}
