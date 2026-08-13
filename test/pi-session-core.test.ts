import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createPiSessionCore } from '../src/pi/session-core.js';
import { ProcessAgentSession } from '../src/pi/process-session.js';
import type { WorkerInit } from '../src/pi/worker-protocol.js';
import type { LoadedBindingConfig } from '../src/config/types.js';
import type { Logger } from '../src/core/logger.js';
import type { ToolBroker } from '../src/tools/tool-broker.js';

test('Pi SDK accepts the Host broker provider without shared credential files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-platform-pi-core-'));
  const workspace = join(root, 'workspace');
  const sessionDir = join(root, 'sessions');
  const agentDir = join(root, 'agent-runtime');
  await Promise.all(
    [workspace, sessionDir, agentDir].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  const init: WorkerInit = {
    workspace,
    sessionDir,
    agentDir,
    provider: 'host-broker',
    model: 'integration-model',
    modelApi: 'openai-responses',
    modelOptions: {
      reasoning: true,
      input: ['text'],
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
    modelBroker: {
      baseUrl: 'http://127.0.0.1:8790/v1',
      capability: 'session-capability-not-used-by-this-test',
    },
    thinkingLevel: 'off',
    systemPrompt: '仅回答用户问题。',
    skillPaths: [],
    tools: [],
  };
  const previousPiOffline = process.env.PI_OFFLINE;
  const previousPiTelemetry = process.env.PI_TELEMETRY;
  process.env.PI_OFFLINE = '0';
  process.env.PI_TELEMETRY = '1';

  try {
    const core = await createPiSessionCore(init, async () => {
      throw new Error('No tool should run during session creation.');
    });
    assert.equal(core.session.model?.provider, 'host-broker');
    assert.equal(core.session.model?.id, 'integration-model');
    assert.equal(core.session.settingsManager.getEnableInstallTelemetry(), false);
    assert.equal(process.env.PI_OFFLINE, '1');
    assert.equal(process.env.PI_TELEMETRY, '0');
    await core.session.dispose();
    await assert.rejects(access(join(agentDir, 'auth.json')));
    await assert.rejects(access(join(agentDir, 'models.json')));
  } finally {
    restoreEnvironmentVariable('PI_OFFLINE', previousPiOffline);
    restoreEnvironmentVariable('PI_TELEMETRY', previousPiTelemetry);
    await rm(root, { recursive: true, force: true });
  }
});

test('an exited Pi worker becomes unavailable and revokes its model capability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-platform-pi-worker-'));
  const workspace = join(root, 'workspace');
  const sessionDir = join(root, 'sessions');
  let revoked = false;
  const config = {
    id: 'primary-general',
    appKey: 'primary',
    agentId: 'general',
    systemPrompt: '仅回答用户问题。',
    runtime: { isolation: 'process', workerShutdownGraceSeconds: 1 },
    agent: {
      provider: 'host-broker',
      model: 'integration-model',
      modelApi: 'openai-responses',
      modelOptions: {
        reasoning: true,
        input: ['text'],
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
      thinkingLevel: 'off',
      skillPaths: [],
      feishuTools: [],
      workspaceTools: [],
    },
  } as unknown as LoadedBindingConfig;

  let session: ProcessAgentSession | undefined;
  try {
    session = await ProcessAgentSession.create({
      config,
      workspace,
      sessionDir,
      storageId: 'worker-exit-test',
      agentDir: join(sessionDir, 'agent-runtime'),
      broker: {
        execute: async () => {
          throw new Error('No tool should run during this test.');
        },
      } as unknown as ToolBroker,
      modelAccess: {
        baseUrl: 'http://127.0.0.1:8790/v1',
        capability: 'session-capability-not-used-by-this-test',
        revoke: () => {
          revoked = true;
        },
      },
      logger: { error: () => undefined } as unknown as Logger,
    });
    const pid = session.snapshot().workerPid;
    assert.ok(pid);
    process.kill(pid, 'SIGKILL');
    await waitFor(() => session?.snapshot().available === false);
    assert.equal(revoked, true);
    await assert.rejects(
      session.prompt({ prompt: '不会发送', images: [] }),
      /not available/,
    );
  } finally {
    await session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Pi worker exit.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
