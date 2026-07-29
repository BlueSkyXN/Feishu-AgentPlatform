import { isAbsolute, relative, resolve, sep } from 'node:path';

export function assertRelativeWorkspacePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '.') return '.';
  if (trimmed.includes('\u0000') || isAbsolute(trimmed)) {
    throw new Error('Workspace path must be relative.');
  }
  const normalized = trimmed.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new Error('Workspace path cannot contain parent traversal.');
  }
  return normalized.replace(/^\.\//, '');
}

export function assertInsideRoot(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (rel === '') return;
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Resolved path escapes the workspace root.');
  }
}
