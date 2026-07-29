import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import type { WorkspaceGuard, WorkspaceListEntry } from './types.js';
import { assertInsideRoot, assertRelativeWorkspacePath } from './path-policy.js';

export interface LocalWorkspaceGuardOptions {
  root: string;
  mode: 'none' | 'read-only' | 'read-write';
  maxReadBytes: number;
  maxWriteBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
}

export class WorkspaceQuotaError extends Error {
  override readonly name = 'WorkspaceQuotaError';
}

export class LocalWorkspaceGuard implements WorkspaceGuard {
  readonly mode: 'none' | 'read-only' | 'read-write';
  private rootReal = '';
  private initialized = false;
  private initializing: Promise<void> | undefined;

  constructor(private readonly options: LocalWorkspaceGuardOptions) {
    this.mode = options.mode;
    positiveSafeInteger(options.maxReadBytes, 'maxReadBytes');
    positiveSafeInteger(options.maxWriteBytes, 'maxWriteBytes');
    positiveSafeInteger(options.maxTotalBytes, 'maxTotalBytes');
    positiveSafeInteger(options.maxFiles, 'maxFiles');
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initializing ??= this.initializeOnce().catch((error: unknown) => {
      this.initializing = undefined;
      throw error;
    });
    await this.initializing;
  }

  async list(
    path = '.',
    maxEntries = 500,
    signal?: AbortSignal,
  ): Promise<WorkspaceListEntry[]> {
    throwIfAborted(signal);
    await this.initialize();
    const target = await this.existingPath(path);
    const metadata = await stat(target);
    if (!metadata.isDirectory()) {
      throw new Error('Workspace list target is not a directory.');
    }
    const output: WorkspaceListEntry[] = [];
    await this.walk(
      target,
      output,
      Math.max(1, Math.min(maxEntries, 5_000)),
      signal,
    );
    return output;
  }

  async read(
    path: string,
    maxBytes = this.options.maxReadBytes,
    signal?: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);
    await this.initialize();
    const target = await this.existingPath(path);
    const metadata = await stat(target);
    if (!metadata.isFile()) throw new Error('Workspace read target is not a file.');
    const limit = Math.min(maxBytes, this.options.maxReadBytes);
    if (metadata.size > limit) {
      throw new Error(`Workspace file exceeds the ${limit}-byte read limit.`);
    }
    throwIfAborted(signal);
    return await readFile(target, 'utf8');
  }

  async search(
    query: string,
    path = '.',
    maxResults = 100,
    signal?: AbortSignal,
  ): Promise<Array<{ path: string; line: number; text: string }>> {
    throwIfAborted(signal);
    const needle = query.trim().toLowerCase();
    if (!needle) throw new Error('Search query must not be empty.');
    const entries = await this.list(path, 5_000, signal);
    const results: Array<{ path: string; line: number; text: string }> = [];
    const limit = Math.max(1, Math.min(maxResults, 500));
    for (const entry of entries) {
      throwIfAborted(signal);
      if (entry.type !== 'file' || (entry.size ?? 0) > this.options.maxReadBytes) {
        continue;
      }
      let content: string;
      try {
        content = await this.read(entry.path, undefined, signal);
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (!line.toLowerCase().includes(needle)) continue;
        results.push({
          path: entry.path,
          line: index + 1,
          text: line.slice(0, 1_000),
        });
        if (results.length >= limit) return results;
      }
    }
    return results;
  }

  async write(
    path: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; bytes: number }> {
    throwIfAborted(signal);
    if (this.mode !== 'read-write') throw new Error('Workspace is read-only.');
    const buffer = Buffer.from(content, 'utf8');
    if (buffer.byteLength > this.options.maxWriteBytes) {
      throw new Error(
        `Workspace write exceeds the ${this.options.maxWriteBytes}-byte limit.`,
      );
    }
    return await this.persist(path, buffer, signal);
  }

  async writeHostFile(
    path: string,
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<{ path: string; bytes: number }> {
    throwIfAborted(signal);
    return await this.persist(path, Buffer.from(content), signal);
  }

  async dispose(): Promise<void> {
    // Persistent workspace; session registry controls retention.
  }

  private async initializeOnce(): Promise<void> {
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    this.rootReal = await realpath(this.options.root);
    this.initialized = true;
  }

  private async persist(
    path: string,
    content: Buffer,
    signal?: AbortSignal,
  ): Promise<{ path: string; bytes: number }> {
    await this.initialize();
    const relativePath = assertRelativeWorkspacePath(path);
    if (relativePath === '.') throw new Error('Workspace write requires a file path.');
    return await withRootMutationLock(this.rootReal, async () => {
      throwIfAborted(signal);
      const previousBytes = await this.existingFileBytesAt(relativePath);
      const usage = await this.scanUsage(this.rootReal);
      if (usage.truncated) {
        if (previousBytes === undefined || content.byteLength > previousBytes) {
          throw new WorkspaceQuotaError(
            'Workspace already exceeds its cumulative storage quota.',
          );
        }
      } else {
        const nextTotalBytes =
          usage.totalBytes - (previousBytes ?? 0) + content.byteLength;
        const nextFileCount =
          usage.fileCount + (previousBytes === undefined ? 1 : 0);
        if (nextTotalBytes > this.options.maxTotalBytes) {
          throw new WorkspaceQuotaError(
            `Workspace exceeds the ${this.options.maxTotalBytes}-byte cumulative limit.`,
          );
        }
        if (nextFileCount > this.options.maxFiles) {
          throw new WorkspaceQuotaError(
            `Workspace exceeds the ${this.options.maxFiles}-file cumulative limit.`,
          );
        }
      }

      const parentReal = await this.ensureSafeParent(dirname(relativePath));
      const target = join(parentReal, basename(relativePath));
      assertInsideRoot(this.rootReal, target);
      await this.existingFileBytes(target);
      const temporary = join(
        parentReal,
        `.${basename(relativePath)}.${randomUUID()}.tmp`,
      );
      await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
      try {
        throwIfAborted(signal);
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
      return { path: relativePath, bytes: content.byteLength };
    });
  }

  private async existingPath(requested: string): Promise<string> {
    const relativePath = assertRelativeWorkspacePath(requested);
    const candidate = resolve(this.rootReal, relativePath);
    assertInsideRoot(this.rootReal, candidate);
    const resolved = await realpath(candidate);
    assertInsideRoot(this.rootReal, resolved);
    return resolved;
  }

  private async walk(
    directory: string,
    output: WorkspaceListEntry[],
    maxEntries: number,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (output.length >= maxEntries) return;
      const absolute = join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) continue;
      const relativePath = absolute
        .slice(this.rootReal.length + 1)
        .replace(/\\/g, '/');
      if (metadata.isDirectory()) {
        output.push({ path: relativePath, type: 'directory' });
        await this.walk(absolute, output, maxEntries, signal);
      } else if (metadata.isFile()) {
        output.push({ path: relativePath, type: 'file', size: metadata.size });
      }
    }
  }

  private async ensureSafeParent(relativeParent: string): Promise<string> {
    let current = this.rootReal;
    const parts = relativeParent === '.' ? [] : relativeParent.split('/');
    for (const part of parts) {
      if (!part || part === '.') continue;
      const candidate = join(current, part);
      assertInsideRoot(this.rootReal, candidate);
      try {
        const metadata = await lstat(candidate);
        if (metadata.isSymbolicLink()) {
          throw new Error('Workspace parent path contains a symlink.');
        }
        if (!metadata.isDirectory()) {
          throw new Error('Workspace parent path contains a non-directory entry.');
        }
      } catch (error) {
        if (!isNotFound(error)) throw error;
        await mkdir(candidate, { mode: 0o700 });
      }
      const resolved = await realpath(candidate);
      assertInsideRoot(this.rootReal, resolved);
      current = resolved;
    }
    return current;
  }

  private async existingFileBytes(target: string): Promise<number | undefined> {
    try {
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink()) {
        throw new Error('Workspace writes cannot target symlinks.');
      }
      if (metadata.isDirectory()) {
        throw new Error('Workspace writes require a file target.');
      }
      if (!metadata.isFile()) {
        throw new Error('Workspace writes require a regular file target.');
      }
      return metadata.size;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  private async existingFileBytesAt(relativePath: string): Promise<number | undefined> {
    let current = this.rootReal;
    const parentParts = dirname(relativePath) === '.'
      ? []
      : dirname(relativePath).split('/');
    for (const part of parentParts) {
      const candidate = join(current, part);
      assertInsideRoot(this.rootReal, candidate);
      let metadata;
      try {
        metadata = await lstat(candidate);
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
      if (metadata.isSymbolicLink()) {
        throw new Error('Workspace parent path contains a symlink.');
      }
      if (!metadata.isDirectory()) {
        throw new Error('Workspace parent path contains a non-directory entry.');
      }
      current = await realpath(candidate);
      assertInsideRoot(this.rootReal, current);
    }
    return await this.existingFileBytes(join(current, basename(relativePath)));
  }

  private async scanUsage(
    directory: string,
  ): Promise<{ totalBytes: number; fileCount: number; truncated: boolean }> {
    let totalBytes = 0;
    let fileCount = 0;
    const visit = async (current: string): Promise<boolean> => {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const absolute = join(current, entry.name);
        const metadata = await lstat(absolute);
        if (metadata.isSymbolicLink()) continue;
        if (metadata.isDirectory()) {
          if (!await visit(absolute)) return false;
          continue;
        }
        if (!metadata.isFile()) continue;
        totalBytes += metadata.size;
        fileCount += 1;
        if (
          totalBytes > this.options.maxTotalBytes ||
          fileCount > this.options.maxFiles
        ) {
          return false;
        }
      }
      return true;
    };
    const complete = await visit(directory);
    return { totalBytes, fileCount, truncated: !complete };
  }

}

interface RootMutationLock {
  tail: Promise<void>;
  users: number;
}

const rootMutationLocks = new Map<string, RootMutationLock>();

async function withRootMutationLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  let lock = rootMutationLocks.get(root);
  if (!lock) {
    lock = { tail: Promise.resolve(), users: 0 };
    rootMutationLocks.set(root, lock);
  }
  lock.users += 1;
  const previous = lock.tail;
  let release!: () => void;
  lock.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
    lock.users -= 1;
    if (lock.users === 0 && rootMutationLocks.get(root) === lock) {
      rootMutationLocks.delete(root);
    }
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT',
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Workspace operation aborted.');
  error.name = 'AbortError';
  throw error;
}

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}
