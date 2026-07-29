#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { gitHead, gitStatus } from './release-utils.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version;
const options = parseArguments(process.argv.slice(2));
const expectedTag = options.tag?.replace(/^v/u, '') || version;
const files = {
  types: await readFile(resolve(root, 'src/config/types.ts'), 'utf8'),
  readme: await readFile(resolve(root, 'README.md'), 'utf8'),
  changelog: await readFile(resolve(root, 'CHANGELOG.md'), 'utf8'),
  compose: await readFile(resolve(root, 'docker-compose.yml'), 'utf8'),
};
const failures = [];

if (version !== expectedTag) failures.push(`package.json version ${version} does not match ${expectedTag}.`);
if (!new RegExp(`APP_VERSION = '${escapeRegExp(version)}'`).test(files.types)) failures.push('src/config/types.ts APP_VERSION does not match package.json.');
if (!new RegExp(`Feishu Agent Platform ${escapeRegExp(version)}`).test(files.readme)) failures.push('README title does not match package.json.');
if (!new RegExp(`^##\\s+(?:\\[)?${escapeRegExp(version)}(?:\\])?(?:\\s|$)`, 'm').test(files.changelog)) failures.push('CHANGELOG is missing the current version heading.');
if (!new RegExp(`image:\\s*feishu-agent-platform:${escapeRegExp(version)}`).test(files.compose)) failures.push('docker-compose image tag does not match package.json.');
if (options.exactHead) {
  const head = await gitHead(root);
  if (head !== options.exactHead) {
    failures.push(`Git HEAD ${head} does not match required source ${options.exactHead}.`);
  }
}
if (options.requireClean && (await gitStatus(root)).length > 0) {
  failures.push('Official release verification requires a clean exact Git tree.');
}

if (failures.length) {
  for (const failure of failures) console.error(`RELEASE-VERIFY: ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Release version verified: ${version}.`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseArguments(args) {
  let tag;
  let exactHead;
  let requireClean = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--exact-head') {
      const candidate = args[index + 1];
      if (!candidate || !/^[0-9a-f]{40}$/u.test(candidate)) {
        throw new Error('--exact-head requires a lowercase 40-character commit SHA.');
      }
      exactHead = candidate;
      index += 1;
    } else if (value === '--require-clean') {
      requireClean = true;
    } else if (value?.startsWith('--')) {
      throw new Error(`Unknown release verification option: ${value}`);
    } else if (!tag) {
      tag = value;
    } else {
      throw new Error('Release verification accepts at most one tag.');
    }
  }
  return { tag, exactHead, requireClean };
}
