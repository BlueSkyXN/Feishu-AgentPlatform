#!/usr/bin/env node
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const expectedVersion = '5.0.8';
const source = resolve(root, 'node_modules/brace-expansion');
const target = resolve(
  root,
  'node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion',
);
const lockPath = resolve(root, 'package-lock.json');
const rootLockKey = 'node_modules/brace-expansion';
const nestedLockKey =
  'node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion';

await assertVersion(source, expectedVersion, 'root security override');
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true, force: true, dereference: true });
await assertVersion(target, expectedVersion, 'patched Pi dependency');
await patchLockfile();
process.stdout.write(`Patched Pi brace-expansion to ${expectedVersion}.\n`);

async function assertVersion(directory, expected, label) {
  const manifest = JSON.parse(
    await readFile(resolve(directory, 'package.json'), 'utf8'),
  );
  if (manifest.version !== expected) {
    throw new Error(`${label} must be brace-expansion ${expected}.`);
  }
}

async function patchLockfile() {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const rootEntry = lock.packages?.[rootLockKey];
  const nestedEntry = lock.packages?.[nestedLockKey];
  if (rootEntry?.version !== expectedVersion || !nestedEntry) {
    throw new Error('package-lock.json is missing the Pi security override entries.');
  }
  lock.packages[nestedLockKey] = { ...rootEntry };
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}
