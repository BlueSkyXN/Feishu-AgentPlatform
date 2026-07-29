#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

import {
  gitVisibleFiles,
  isSensitiveReleasePath,
} from './release-utils.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function runRepositoryCheck({ root = defaultRoot } = {}) {
  const normalizedRoot = resolve(root);
  const visibleFiles = new Set(await gitVisibleFiles(normalizedRoot));
  const failures = [];

  await checkYamlTree('.github/workflows');
  for (const directory of ['config/apps', 'config/agents', 'config/bindings']) {
    await checkYamlTree(directory);
    checkExamplesOnly(directory);
  }
  await checkYamlFile('docker-compose.yml');
  await checkYamlFile('deploy/kubernetes.yaml');
  await checkWorkflowPolicy();
  await checkNoCommittedSecrets();

  return { failures, visibleFiles: [...visibleFiles].sort() };

  async function checkYamlTree(directory) {
    for (const path of visibleFiles) {
      if (!path.startsWith(`${directory}/`)) continue;
      const name = path.slice(directory.length + 1);
      if (name.includes('/') || !/\.ya?ml(?:\.example)?$/u.test(name)) continue;
      await checkYamlFile(path);
    }
  }

  async function checkYamlFile(path) {
    if (!visibleFiles.has(path)) return;
    const value = await readFile(resolve(normalizedRoot, path), 'utf8');
    const docs = path === 'deploy/kubernetes.yaml'
      ? value.split(/^---\s*$/mu)
      : [value];
    for (const [index, part] of docs.entries()) {
      if (!part.trim()) continue;
      const document = parseDocument(part, { prettyErrors: true });
      if (document.errors.length) {
        failures.push(
          `${path}${docs.length > 1 ? ` document ${index + 1}` : ''}: ${document.errors[0].message}`,
        );
      }
    }
  }

  async function checkWorkflowPolicy() {
    const workflowPaths = [...visibleFiles].filter((path) =>
      /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path),
    );
    for (const name of workflowPaths) {
      const value = await readFile(resolve(normalizedRoot, name), 'utf8');
      if (/\bpull_request_target\s*:/u.test(value)) {
        failures.push(`${name} must not use pull_request_target.`);
      }
      if (!/^permissions:\s*$/mu.test(value)) {
        failures.push(`${name} must declare top-level permissions.`);
      }
      for (const match of value.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+).*$/gmu)) {
        const reference = match[1];
        if (!reference || reference.startsWith('./') || reference.startsWith('docker://')) {
          continue;
        }
        if (!/^[^@\s]+@[0-9a-f]{40}$/u.test(reference)) {
          failures.push(`${name} Action reference must use an immutable commit SHA: ${reference}`);
        }
      }
      if (/\b(?:ssh|sshd|scp|sftp|ssh-key|ssh_key|rsync\s+-e\s+ssh)\b/iu.test(value)) {
        failures.push(`${name} must not use SSH deployment.`);
      }
      const checkoutBlocks = value
        .split(/(?=\n\s*-\s+name:|\n\s*-\s+uses:)/u)
        .filter((block) => /actions\/checkout@/u.test(block));
      for (const block of checkoutBlocks) {
        if (!/persist-credentials:\s*false/u.test(block)) {
          failures.push(`${name} checkout must set persist-credentials: false.`);
        }
      }
      if (checkoutBlocks.length > 0 && !/git rev-parse (?:--verify )?["']?HEAD/u.test(value)) {
        failures.push(`${name} must verify the exact checked-out HEAD SHA.`);
      }
      if (
        checkoutBlocks.length > 0 &&
        !/test\s+"\$[A-Z_]*SHA"\s*=\s*"\$[A-Z_]*SHA"/u.test(value)
      ) {
        failures.push(`${name} must compare checked-out HEAD with an expected SHA.`);
      }
    }
  }

  function checkExamplesOnly(directory) {
    for (const path of visibleFiles) {
      if (new RegExp(`^${escapeRegExp(directory)}/[^/]+\\.ya?ml$`, 'u').test(path)) {
        failures.push(`${path} is an active manifest; source releases ship *.yaml.example only.`);
      }
    }
  }

  async function checkNoCommittedSecrets() {
    for (const path of visibleFiles) {
      if (isSensitiveReleasePath(path)) {
        failures.push(`${path} is secret-bearing or runtime-local and must not be committed or packaged.`);
      }
    }
    if (!visibleFiles.has('.env.example')) return;
    const example = await readFile(resolve(normalizedRoot, '.env.example'), 'utf8');
    if (/(?:sk-|hf_)[A-Za-z0-9]{20,}/u.test(example)) {
      failures.push('.env.example appears to contain a real key.');
    }
  }
}

if (isMainModule()) {
  const { failures } = await runRepositoryCheck();
  if (failures.length) {
    for (const failure of failures) console.error(`REPOSITORY-CHECK: ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('Repository structure and workflow policy check passed.');
  }
}

function isMainModule() {
  return Boolean(
    process.argv[1] &&
      resolve(process.argv[1]) === fileURLToPath(import.meta.url),
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
