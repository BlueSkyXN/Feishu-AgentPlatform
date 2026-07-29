export interface WorkspaceListEntry {
  path: string;
  type: 'file' | 'directory';
  size?: number;
}

/**
 * A bounded view of one conversation workspace.
 *
 * This is a path and persistence boundary, not an operating-system sandbox
 * and not a code-execution environment.
 */
export interface WorkspaceGuard {
  readonly mode: 'none' | 'read-only' | 'read-write';
  list(
    path?: string,
    maxEntries?: number,
    signal?: AbortSignal,
  ): Promise<WorkspaceListEntry[]>;
  read(path: string, maxBytes?: number, signal?: AbortSignal): Promise<string>;
  search(
    query: string,
    path?: string,
    maxResults?: number,
    signal?: AbortSignal,
  ): Promise<Array<{ path: string; line: number; text: string }>>;
  write(
    path: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; bytes: number }>;
  /** Host-only persistence path for trusted attachment bytes. */
  writeHostFile(
    path: string,
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<{ path: string; bytes: number }>;
  dispose(): Promise<void>;
}
