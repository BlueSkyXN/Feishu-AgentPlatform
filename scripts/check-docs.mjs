#!/usr/bin/env node
import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const ignoredDirectories = new Set([
  '.git', 'node_modules', 'dist', '.test-dist', '.offline-dist', 'coverage',
  'release', 'data', 'local', '.visual-brainstorming',
]);
const failures = [];

const files = await walk(root);
const markdownFiles = files.filter((file) => extname(file).toLowerCase() === '.md');
const headingCache = new Map();

for (const file of markdownFiles) {
  const text = await readFile(file, 'utf8');
  checkCodeFences(file, text);
  const links = extractLinks(text);
  for (const link of links) await validateLink(file, link);
}

if (failures.length) {
  for (const failure of failures) console.error(`DOCS-CHECK: ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Documentation check passed: ${markdownFiles.length} Markdown file(s).`);
}

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const full = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(full));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

function checkCodeFences(file, text) {
  const fences = text.match(/^```/gm)?.length ?? 0;
  if (fences % 2 !== 0) failures.push(`${display(file)} has an unbalanced fenced code block.`);
}

function extractLinks(text) {
  const links = [];
  const inline = /!?(?:\[[^\]]*\])\(([^)]+)\)/g;
  for (const match of text.matchAll(inline)) {
    const raw = (match[1] ?? '').trim();
    if (!raw) continue;
    const target = raw.startsWith('<') && raw.endsWith('>')
      ? raw.slice(1, -1)
      : raw.split(/\s+["']/u, 1)[0];
    links.push(target);
  }
  return links;
}

async function validateLink(sourceFile, rawTarget) {
  if (/^(?:https?:|mailto:|tel:|data:|javascript:|sandbox:)/i.test(rawTarget)) return;
  if (rawTarget.startsWith('//')) return;

  let target;
  try {
    target = decodeURIComponent(rawTarget);
  } catch {
    failures.push(`${display(sourceFile)} contains an invalid URI: ${rawTarget}`);
    return;
  }

  const hashIndex = target.indexOf('#');
  const pathPart = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
  const fragment = hashIndex >= 0 ? target.slice(hashIndex + 1) : '';
  const queryless = pathPart.split('?', 1)[0];
  const resolved = queryless
    ? resolve(dirname(sourceFile), queryless)
    : sourceFile;

  if (queryless) {
    try {
      await access(resolved);
    } catch {
      failures.push(`${display(sourceFile)} links to missing path ${rawTarget}.`);
      return;
    }
  }

  if (fragment && extname(resolved).toLowerCase() === '.md') {
    const headings = await headingsFor(resolved);
    const normalized = normalizeFragment(fragment);
    if (!headings.has(normalized)) {
      failures.push(`${display(sourceFile)} links to missing heading #${fragment} in ${display(resolved)}.`);
    }
  }
}

async function headingsFor(file) {
  const cached = headingCache.get(file);
  if (cached) return cached;
  const text = await readFile(file, 'utf8');
  const headings = new Set();
  const counts = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (!match) continue;
    const base = githubSlug(match[2] ?? '');
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    headings.add(count === 0 ? base : `${base}-${count}`);
  }
  headingCache.set(file, headings);
  return headings;
}

function normalizeFragment(value) {
  return githubSlug(value.replace(/^#/, ''));
}

function githubSlug(value) {
  return stripHtmlTags(value)
    .trim()
    .toLowerCase()
    .replace(/[\u2000-\u206f\u2e00-\u2e7f'!"#$%&()*+,./:;<=>?@[\\\]^`{|}~]/gu, '')
    .replace(/\s+/gu, '-');
}

function stripHtmlTags(value) {
  let output = '';
  let insideTag = false;
  for (const character of value) {
    if (character === '<') {
      insideTag = true;
    } else if (character === '>') {
      insideTag = false;
    } else if (!insideTag) {
      output += character;
    }
  }
  return output;
}

function display(file) {
  return relative(root, file).split(sep).join('/');
}
