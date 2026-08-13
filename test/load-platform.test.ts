import assert from 'node:assert/strict';
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { loadPlatformConfig } from '../src/config/load-platform.js';
import {
  DEFAULT_WORKSPACE_MAX_FILES,
  DEFAULT_WORKSPACE_MAX_TOTAL_BYTES,
  READ_ONLY_FEISHU_TOOL_NAMES,
} from '../src/config/types.js';

const projectRoot = resolve(process.cwd());

test('committed examples materialize into a valid single-App multi-Agent deployment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-platform-examples-'));
  process.env.FEISHU_PRIMARY_APP_ID = 'cli_primary';
  process.env.FEISHU_PRIMARY_APP_SECRET = 'primary-secret';
  process.env.FEISHU_PRIMARY_VERIFICATION_TOKEN = 'verification-token';
  try {
    await Promise.all([
      cp(join(projectRoot, 'prompts'), join(root, 'prompts'), { recursive: true }),
      cp(join(projectRoot, 'vendor'), join(root, 'vendor'), { recursive: true }),
      cp(join(projectRoot, 'skills'), join(root, 'skills'), { recursive: true }),
      mkdir(join(root, 'config/apps'), { recursive: true }),
      mkdir(join(root, 'config/agents'), { recursive: true }),
      mkdir(join(root, 'config/bindings'), { recursive: true }),
    ]);
    for (const relativePath of [
      'apps/primary.yaml',
      'agents/general.yaml',
      'agents/office.yaml',
      'bindings/primary-general.yaml',
      'bindings/primary-office.yaml',
    ]) {
      await copyFile(
        join(projectRoot, 'config', `${relativePath}.example`),
        join(root, 'config', relativePath),
      );
    }

    const platform = await loadPlatformConfig('config', root, join(root, 'data'));
    assert.deepEqual(platform.apps.map((app) => app.id), ['primary']);
    assert.deepEqual(platform.agents.map((agent) => agent.id), ['general', 'office']);
    assert.ok(platform.agents.every((agent) =>
      agent.workspace.maxTotalBytes === DEFAULT_WORKSPACE_MAX_TOTAL_BYTES &&
      agent.workspace.maxFiles === DEFAULT_WORKSPACE_MAX_FILES
    ));
    assert.ok(platform.agents.every((agent) =>
      agent.tools.feishu.every((name) =>
        (READ_ONLY_FEISHU_TOOL_NAMES as readonly string[]).includes(name)
      ) && agent.larkCli.operations.every((operation) => operation.effect === 'read')
    ));
    assert.deepEqual(
      platform.bindings.map((binding) => binding.id),
      ['primary-general', 'primary-office'],
    );
  } finally {
    delete process.env.FEISHU_PRIMARY_APP_ID;
    delete process.env.FEISHU_PRIMARY_APP_SECRET;
    delete process.env.FEISHU_PRIMARY_VERIFICATION_TOKEN;
    await rm(root, { recursive: true, force: true });
  }
});

test('platform loader supports one App with multiple Agents and one Agent across Apps', async () => {
  const root = await fixture();
  try {
    const platform = await loadPlatformConfig('config', root, join(root, 'data'));
    assert.equal(platform.apps.length, 2);
    assert.equal(platform.agents.length, 2);
    assert.equal(platform.bindings.length, 3);
    assert.ok(platform.agents.every((agent) =>
      agent.workspace.maxTotalBytes === DEFAULT_WORKSPACE_MAX_TOTAL_BYTES &&
      agent.workspace.maxFiles === DEFAULT_WORKSPACE_MAX_FILES
    ));
    assert.deepEqual(
      platform.bindings.filter((binding) => binding.app === 'primary').map((binding) => binding.agent).sort(),
      ['general', 'office'],
    );
    assert.deepEqual(
      platform.bindings.filter((binding) => binding.agent === 'office').map((binding) => binding.app).sort(),
      ['primary', 'secondary'],
    );
  } finally {
    cleanupEnvironment();
    await rm(root, { recursive: true, force: true });
  }
});

test('platform loader rejects dangling references and duplicate routes', async () => {
  const root = await fixture();
  try {
    await writeFile(
      join(root, 'config/bindings/primary-office.yaml'),
      binding('primary-office', 'primary', 'missing', false, '/office'),
    );
    await assert.rejects(
      () => loadPlatformConfig('config', root, join(root, 'data')),
      /unknown agent reference/,
    );
  } finally {
    cleanupEnvironment();
    await rm(root, { recursive: true, force: true });
  }
});

test('platform loader rejects invalid conversation workspace quotas', async () => {
  const root = await fixture();
  try {
    await writeFile(
      join(root, 'config/agents/general.yaml'),
      agent('general').replace(
        'workspace:\n  mode: read-only',
        'workspace:\n  mode: read-only\n  maxTotalBytes: 0',
      ),
    );
    await assert.rejects(
      () => loadPlatformConfig('config', root, join(root, 'data')),
      /workspace\.maxTotalBytes must be an integer from 1024/,
    );
  } finally {
    cleanupEnvironment();
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'feishu-platform-config-'));
  await Promise.all([
    mkdir(join(root, 'config/apps'), { recursive: true }),
    mkdir(join(root, 'config/agents'), { recursive: true }),
    mkdir(join(root, 'config/bindings'), { recursive: true }),
    mkdir(join(root, 'prompts'), { recursive: true }),
  ]);
  process.env.TEST_PRIMARY_ID = 'cli_primary';
  process.env.TEST_PRIMARY_SECRET = 'primary-secret';
  process.env.TEST_SECONDARY_ID = 'cli_secondary';
  process.env.TEST_SECONDARY_SECRET = 'secondary-secret';
  await Promise.all([
    writeFile(join(root, 'prompts/general.md'), 'General prompt'),
    writeFile(join(root, 'prompts/office.md'), 'Office prompt'),
    writeFile(join(root, 'config/apps/primary.yaml'), app('primary', 'PRIMARY')),
    writeFile(join(root, 'config/apps/secondary.yaml'), app('secondary', 'SECONDARY')),
    writeFile(join(root, 'config/agents/general.yaml'), agent('general')),
    writeFile(join(root, 'config/agents/office.yaml'), agent('office')),
    writeFile(
      join(root, 'config/bindings/primary-general.yaml'),
      binding('primary-general', 'primary', 'general', true),
    ),
    writeFile(
      join(root, 'config/bindings/primary-office.yaml'),
      binding('primary-office', 'primary', 'office', false, '/office'),
    ),
    writeFile(
      join(root, 'config/bindings/secondary-office.yaml'),
      binding('secondary-office', 'secondary', 'office', true),
    ),
  ]);
  return root;
}

function app(id: string, env: 'PRIMARY' | 'SECONDARY'): string {
  return `id: ${id}\nappIdEnv: TEST_${env}_ID\nappSecretEnv: TEST_${env}_SECRET\nevents:\n  transport: websocket\ncallbacks:\n  transport: disabled\npolicy:\n  dmMode: open\noauth:\n  enabled: false\n`;
}

function agent(id: string): string {
  return `id: ${id}\nsystemPromptFile: prompts/${id}.md\nprovider: host-broker\nmodel: test-model\nmodelApi: openai-completions\nruntime:\n  isolation: process\nworkspace:\n  mode: read-only\ntools:\n  feishu: [chat.info]\n  workspace: [workspace.list, workspace.read]\nlarkCli:\n  enabled: false\n`;
}

function binding(
  id: string,
  appId: string,
  agentId: string,
  isDefault: boolean,
  command?: string,
): string {
  return `id: ${id}\napp: ${appId}\nagent: ${agentId}\nroute:\n  default: ${String(isDefault)}\n  priority: ${isDefault ? 0 : 100}\n  commandPrefixes: ${command ? `[${command}]` : '[]'}\nconversation:\n  scope: thread\n`;
}

function cleanupEnvironment(): void {
  delete process.env.TEST_PRIMARY_ID;
  delete process.env.TEST_PRIMARY_SECRET;
  delete process.env.TEST_SECONDARY_ID;
  delete process.env.TEST_SECONDARY_SECRET;
}
