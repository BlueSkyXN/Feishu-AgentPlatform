import { spawn } from 'node:child_process';
import { sep } from 'node:path';

export async function gitVisibleFiles(root) {
  const output = await runCapture(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    root,
  );
  return nulPaths(output);
}

export async function gitTrackedFiles(root, revision = undefined) {
  const args = revision
    ? ['ls-tree', '-r', '--name-only', '-z', revision]
    : ['ls-files', '-z'];
  return nulPaths(await runCapture('git', args, root));
}

export async function gitStatus(root) {
  return await runCapture(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all', '-z'],
    root,
  );
}

export async function gitHead(root) {
  return (await runCapture('git', ['rev-parse', 'HEAD^{commit}'], root)).trim();
}

export async function gitHeadTimestamp(root) {
  const value = (
    await runCapture('git', ['show', '-s', '--format=%ct', 'HEAD'], root)
  ).trim();
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error('Git HEAD commit timestamp is invalid.');
  }
  return seconds;
}

export async function isCleanGitTree(root) {
  return (await gitStatus(root)).length === 0;
}

export function isSensitiveReleasePath(path) {
  const normalized = normalizeGitPath(path);
  const segments = normalized.split('/');
  const base = segments.at(-1)?.toLowerCase() ?? '';
  if (segments.some((segment) => ['local', 'data', 'secrets'].includes(segment.toLowerCase()))) {
    return true;
  }
  if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) {
    return true;
  }
  if (
    ['id_rsa', 'id_ed25519', 'credentials.json', 'service-account.json'].includes(base)
  ) {
    return true;
  }
  return /\.(?:key|pem|p12|pfx)$/iu.test(base);
}

export function normalizeGitPath(path) {
  const normalized = String(path).split(sep).join('/').replace(/^\.\//u, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    throw new Error(`Unsafe Git path: ${String(path)}`);
  }
  return normalized;
}

export function sortPaths(paths) {
  return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export async function run(command, args, cwd, options = {}) {
  await runProcess(command, args, cwd, { ...options, capture: false });
}

export async function runCapture(command, args, cwd, options = {}) {
  return await runProcess(command, args, cwd, { ...options, capture: true });
}

function nulPaths(value) {
  return sortPaths(
    value
      .split('\0')
      .filter(Boolean)
      .map((path) => normalizeGitPath(path)),
  );
}

async function runProcess(command, args, cwd, options) {
  return await new Promise((resolvePromise, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, {
      cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: false,
    });
    if (options.capture) {
      child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    }
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolvePromise(options.capture ? Buffer.concat(stdout).toString('utf8') : '');
        return;
      }
      const detail = options.capture
        ? `: ${Buffer.concat(stderr).toString('utf8').trim()}`
        : '';
      reject(new Error(`${command} exited with ${String(code)}${detail}`));
    });
  });
}
