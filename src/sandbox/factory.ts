import {
  DEFAULT_WORKSPACE_MAX_FILES,
  DEFAULT_WORKSPACE_MAX_TOTAL_BYTES,
  type LoadedBindingConfig,
} from '../config/types.js';
import type { WorkspaceGuard } from './types.js';
import { LocalWorkspaceGuard } from './workspace-guard.js';

export async function createWorkspaceGuard(
  config: LoadedBindingConfig,
  workspace: string,
): Promise<WorkspaceGuard> {
  const guard = new LocalWorkspaceGuard({
    root: workspace,
    mode: config.sandbox.mode,
    maxReadBytes: config.sandbox.maxReadBytes,
    maxWriteBytes: config.sandbox.maxWriteBytes,
    maxTotalBytes:
      config.sandbox.maxTotalBytes ?? DEFAULT_WORKSPACE_MAX_TOTAL_BYTES,
    maxFiles: config.sandbox.maxFiles ?? DEFAULT_WORKSPACE_MAX_FILES,
  });
  await guard.initialize();
  return guard;
}
