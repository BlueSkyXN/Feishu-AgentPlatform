#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  gitHead,
  gitHeadTimestamp,
  gitTrackedFiles,
  gitVisibleFiles,
  isCleanGitTree,
  isSensitiveReleasePath,
  normalizeGitPath,
  run,
  runCapture,
} from './release-utils.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function packageRelease({
  root = defaultRoot,
  outputDir = join(root, 'release'),
  mode = 'auto',
  sourceDateEpoch = process.env.SOURCE_DATE_EPOCH,
} = {}) {
  const sourceRoot = resolve(root);
  const destination = resolve(outputDir);
  const pkg = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  const version = requiredVersion(pkg.version);
  const sourceCommit = await gitHead(sourceRoot);
  const clean = await isCleanGitTree(sourceRoot);
  const releaseMode = resolveMode(mode, clean);
  const preview = releaseMode === 'preview';
  const releaseName =
    `feishu-agent-platform-${version}${preview ? '-uncommitted-preview' : ''}`;
  const temp = await mkdtemp(join(tmpdir(), 'feishu-agent-platform-release-'));
  const stage = join(temp, releaseName);
  const verifyRoot = join(temp, 'verify');

  try {
    if (releaseMode === 'official') {
      await exportOfficialTree(sourceRoot, temp, releaseName, sourceCommit);
    } else {
      await exportPreviewTree(sourceRoot, stage, destination);
      await writeFile(
        join(stage, 'RELEASE_PREVIEW.txt'),
        [
          'UNCOMMITTED PREVIEW — NOT AN OFFICIAL RELEASE',
          `Source commit: ${sourceCommit}`,
          'This archive contains the current Git-visible working tree, including uncommitted files.',
          'Ignored, runtime-local, data, local, and secret-bearing paths are excluded.',
          '',
        ].join('\n'),
        { encoding: 'utf8', mode: 0o644 },
      );
    }

    await normalizeModes(stage);
    const manifest = await buildManifest(stage, {
      version,
      releaseMode,
      sourceCommit,
    });
    await writeFile(join(stage, 'RELEASE_MANIFEST.txt'), manifest, {
      encoding: 'utf8',
      mode: 0o644,
    });

    const epochSeconds = sourceDateEpoch === undefined
      ? await gitHeadTimestamp(sourceRoot)
      : parseSourceDateEpoch(sourceDateEpoch);
    const sourceDate = new Date(epochSeconds * 1_000);
    await normalizeTimes(stage, sourceDate);

    await mkdir(destination, { recursive: true });
    const zipPath = join(destination, `${releaseName}.zip`);
    await rm(zipPath, { force: true });
    const archiveFiles = (await listFiles(stage)).map((file) =>
      relative(temp, file).split(sep).join('/'),
    );
    await writeDeterministicZip(zipPath, temp, archiveFiles, sourceDate);

    const digest = await sha256File(zipPath);
    const checksumPath = `${zipPath}.sha256`;
    await writeFile(checksumPath, `${digest}  ${basename(zipPath)}\n`, {
      encoding: 'utf8',
      mode: 0o644,
    });

    await verifyArchive({
      zipPath,
      destination: verifyRoot,
      releaseDirectory: releaseName,
      expectedEntries: archiveFiles,
      sourceDate,
    });
    return {
      mode: releaseMode,
      preview,
      sourceCommit,
      zipPath,
      checksumPath,
      sha256: digest,
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function exportOfficialTree(root, temp, releaseName, sourceCommit) {
  const tracked = await gitTrackedFiles(root, sourceCommit);
  const sensitive = tracked.filter(isSensitiveReleasePath);
  if (sensitive.length > 0) {
    throw new Error(
      `Official Git tree contains forbidden release paths: ${sensitive.join(', ')}`,
    );
  }
  const tarPath = join(temp, 'source.tar');
  await run(
    'git',
    [
      'archive',
      '--format=tar',
      `--prefix=${releaseName}/`,
      `--output=${tarPath}`,
      sourceCommit,
    ],
    root,
  );
  await run('tar', ['-xf', tarPath, '-C', temp], root, {
    env: { COPYFILE_DISABLE: '1' },
  });
  await rm(tarPath, { force: true });
}

async function exportPreviewTree(root, stage, outputDir) {
  await mkdir(stage, { recursive: true });
  const outputPrefix = pathInsideRoot(root, outputDir);
  const candidates = await gitVisibleFiles(root);
  for (const path of candidates) {
    if (isSensitiveReleasePath(path)) continue;
    if (outputPrefix && (path === outputPrefix || path.startsWith(`${outputPrefix}/`))) {
      continue;
    }
    const source = join(root, ...path.split('/'));
    const info = await lstat(source);
    if (info.isSymbolicLink()) {
      throw new Error(`Release tree must not contain symbolic links: ${path}`);
    }
    if (!info.isFile()) continue;
    const target = join(stage, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { preserveTimestamps: false });
  }
}

async function buildManifest(directory, metadata) {
  const files = await listFiles(directory);
  const lines = [
    `# Release manifest — feishu-agent-platform ${metadata.version}`,
    `# mode: ${metadata.releaseMode}`,
    `# source-commit: ${metadata.sourceCommit}`,
    '# RELEASE_MANIFEST.txt is intentionally excluded from its own entry list.',
    '# sha256\tbytes\tmode\tpath',
  ];
  for (const file of files) {
    const info = await stat(file);
    const mode = (info.mode & 0o777).toString(8).padStart(3, '0');
    const path = relative(directory, file).split(sep).join('/');
    lines.push(`${await sha256File(file)}\t${info.size}\t${mode}\t${path}`);
  }
  return `${lines.join('\n')}\n`;
}

async function listFiles(directory) {
  const result = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Release tree must not contain symbolic links: ${full}`);
    }
    if (entry.isDirectory()) result.push(...await listFiles(full));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

async function normalizeModes(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(directory, entry.name);
    const info = await lstat(full);
    if (info.isSymbolicLink()) {
      throw new Error(`Release tree must not contain symbolic links: ${full}`);
    }
    if (info.isDirectory()) {
      await normalizeModes(full);
      await chmod(full, 0o755);
    } else if (info.isFile()) {
      await chmod(full, info.mode & 0o111 ? 0o755 : 0o644);
    }
  }
  await chmod(directory, 0o755);
}

async function normalizeTimes(directory, date) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) await normalizeTimes(full, date);
    await utimes(full, date, date);
  }
  await utimes(directory, date, date);
}

async function verifyArchive({
  zipPath,
  destination,
  releaseDirectory,
  expectedEntries,
  sourceDate,
}) {
  const actualEntries = (
    await runCapture('unzip', ['-Z', '-1', zipPath], dirname(zipPath))
  )
    .split(/\r?\n/u)
    .filter(Boolean);
  if (
    actualEntries.length !== expectedEntries.length ||
    actualEntries.some((entry, index) => entry !== expectedEntries[index])
  ) {
    throw new Error('ZIP entry ordering or inventory is not deterministic.');
  }
  for (const entry of actualEntries) {
    const relativePath = stripReleaseDirectory(entry, releaseDirectory);
    if (isSensitiveReleasePath(relativePath)) {
      throw new Error(`Archive contains forbidden path: ${relativePath}`);
    }
  }

  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await run('unzip', ['-q', zipPath, '-d', destination], dirname(zipPath), {
    env: { TZ: 'UTC' },
  });
  const extracted = join(destination, releaseDirectory);
  const manifestText = await readFile(join(extracted, 'RELEASE_MANIFEST.txt'), 'utf8');
  const entries = manifestText
    .split(/\r?\n/u)
    .filter((line) => line && !line.startsWith('#'));

  for (const line of entries) {
    const [expectedHash, expectedBytes, expectedMode, ...pathParts] = line.split('\t');
    const relativePath = pathParts.join('\t');
    if (!expectedHash || !expectedBytes || !expectedMode || !relativePath) {
      throw new Error(`Malformed release manifest line: ${line}`);
    }
    const file = join(extracted, ...normalizeGitPath(relativePath).split('/'));
    const info = await stat(file);
    const actualMode = (info.mode & 0o777).toString(8).padStart(3, '0');
    if (info.size !== Number(expectedBytes)) {
      throw new Error(`Size mismatch: ${relativePath}`);
    }
    if (actualMode !== expectedMode) {
      throw new Error(`Mode mismatch: ${relativePath}`);
    }
    if (await sha256File(file) !== expectedHash) {
      throw new Error(`SHA-256 mismatch: ${relativePath}`);
    }
    if (Math.abs(info.mtimeMs - sourceDate.getTime()) > 2_000) {
      throw new Error(`Timestamp mismatch: ${relativePath}`);
    }
  }

  const extractedFiles = await listFiles(extracted);
  if (extractedFiles.length !== entries.length + 1) {
    throw new Error(
      `Archive file count mismatch: manifest=${entries.length}, archive=${extractedFiles.length}`,
    );
  }
}

async function writeDeterministicZip(zipPath, root, entries, sourceDate) {
  if (entries.length > 0xffff) {
    throw new Error('ZIP64 is not supported; release contains too many files.');
  }
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  const { date, time } = dosDateTime(sourceDate);

  for (const entry of entries) {
    const normalized = normalizeGitPath(entry);
    const name = Buffer.from(normalized, 'utf8');
    if (name.byteLength > 0xffff) throw new Error(`ZIP entry name is too long: ${entry}`);
    const file = join(root, ...normalized.split('/'));
    const [content, info] = await Promise.all([readFile(file), stat(file)]);
    if (content.byteLength > 0xffffffff) {
      throw new Error(`ZIP64 is not supported; release file is too large: ${entry}`);
    }
    const crc = crc32(content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(content.byteLength, 18);
    localHeader.writeUInt32LE(content.byteLength, 22);
    localHeader.writeUInt16LE(name.byteLength, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(content.byteLength, 20);
    centralHeader.writeUInt32LE(content.byteLength, 24);
    centralHeader.writeUInt16LE(name.byteLength, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    const unixMode = 0o100000 | (info.mode & 0o777);
    centralHeader.writeUInt32LE((unixMode << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);
    localOffset += localHeader.byteLength + name.byteLength + content.byteLength;
    if (localOffset > 0xffffffff) {
      throw new Error('ZIP64 is not supported; release archive is too large.');
    }
  }

  const centralDirectory = Buffer.concat(centralParts);
  if (centralDirectory.byteLength > 0xffffffff) {
    throw new Error('ZIP64 is not supported; central directory is too large.');
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  await writeFile(zipPath, Buffer.concat([...localParts, centralDirectory, end]), {
    mode: 0o644,
  });
}

function dosDateTime(value) {
  const year = value.getUTCFullYear();
  if (year < 1980 || year > 2107) {
    throw new Error('ZIP timestamp must be between 1980 and 2107.');
  }
  return {
    date: ((year - 1980) << 9) | ((value.getUTCMonth() + 1) << 5) | value.getUTCDate(),
    time: (value.getUTCHours() << 11) | (value.getUTCMinutes() << 5) |
      Math.floor(value.getUTCSeconds() / 2),
  };
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(content) {
  let value = 0xffffffff;
  for (const byte of content) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

async function sha256File(file) {
  const content = await readFile(file);
  return createHash('sha256').update(content).digest('hex');
}

function resolveMode(mode, clean) {
  if (!['auto', 'official', 'preview'].includes(mode)) {
    throw new Error(`Unknown release mode: ${String(mode)}`);
  }
  if (mode === 'official' && !clean) {
    throw new Error('Official release packaging requires a clean exact Git tree.');
  }
  return mode === 'auto' ? (clean ? 'official' : 'preview') : mode;
}

function requiredVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value)) {
    throw new Error('package.json version is invalid.');
  }
  return value;
}

function parseSourceDateEpoch(value) {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 315_532_800) {
    throw new Error('SOURCE_DATE_EPOCH must be an integer at or after 1980-01-01.');
  }
  return seconds;
}

function pathInsideRoot(root, path) {
  const value = relative(resolve(root), resolve(path)).split(sep).join('/');
  if (!value || value === '.') return undefined;
  if (value === '..' || value.startsWith('../')) return undefined;
  return normalizeGitPath(value);
}

function stripReleaseDirectory(entry, releaseDirectory) {
  const prefix = `${releaseDirectory}/`;
  if (!entry.startsWith(prefix)) {
    throw new Error(`Archive entry escapes the release directory: ${entry}`);
  }
  return normalizeGitPath(entry.slice(prefix.length));
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  const mode = args.includes('--official')
    ? 'official'
    : args.includes('--preview')
      ? 'preview'
      : 'auto';
  const positionals = args.filter((arg) => !arg.startsWith('--'));
  if (positionals.length > 1) {
    throw new Error('Usage: package-release.mjs [--official|--preview] [output-dir]');
  }
  const result = await packageRelease({
    ...(positionals[0] ? { outputDir: positionals[0] } : {}),
    mode,
  });
  console.log(`Release mode: ${result.mode}`);
  console.log(`Source commit: ${result.sourceCommit}`);
  console.log(result.zipPath);
  console.log(result.checksumPath);
}

function isMainModule() {
  return Boolean(
    process.argv[1] &&
      resolve(process.argv[1]) === fileURLToPath(import.meta.url),
  );
}
