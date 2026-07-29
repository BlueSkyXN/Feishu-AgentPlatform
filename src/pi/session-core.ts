import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';

import type { FeishuToolName, WorkspaceToolName } from '../config/types.js';
import { enabledToolCatalog, type BrokerToolName } from '../tools/catalog.js';
import type { WorkerInit } from './worker-protocol.js';

export interface PiSessionCore {
  session: AgentSession;
  modelFallbackMessage?: string;
}

export async function createPiSessionCore(
  init: WorkerInit,
  executeTool: (
    name: BrokerToolName,
    argumentsValue: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown>,
): Promise<PiSessionCore> {
  const settingsManager = SettingsManager.create(init.workspace, init.agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: init.workspace,
    agentDir: init.agentDir,
    settingsManager,
    additionalSkillPaths: init.skillPaths,
    // Disable implicit project/global skill discovery. Only the explicitly
    // configured, host-approved skill paths above are loaded.
    noSkills: true,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => init.systemPrompt,
  });
  await resourceLoader.reload();

  const skillErrors = resourceLoader
    .getSkills()
    .diagnostics.filter((diagnostic: { type?: string }) => diagnostic.type === 'error');
  if (skillErrors.length > 0) {
    throw new Error(
      `Pi skill loading failed: ${skillErrors
        .map((item: { path?: string; message?: string }) => `${item.path ?? '(unknown path)'}: ${item.message ?? 'unknown skill error'}`)
        .join('; ')}`,
    );
  }

  const customTools = enabledToolCatalog(
    init.tools.filter((name) => !name.startsWith('workspace.')) as FeishuToolName[],
    init.tools.filter((name) => name.startsWith('workspace.')) as WorkspaceToolName[],
  ).map((entry) =>
    defineTool({
      name: entry.runtimeName,
      label: entry.label,
      description: entry.description,
      parameters: entry.parameters as never,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ) => {
        const result = await executeTool(entry.logicalName, params, signal);
        return {
          content: [
            {
              type: 'text' as const,
              text: safeStringify(result),
            },
          ],
          details: {
            brokered: true,
            logicalName: entry.logicalName,
          },
        };
      },
    }),
  );

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  modelRuntime.registerProvider(init.provider, {
    name: `Host broker for ${init.provider}`,
    baseUrl: init.modelBroker.baseUrl,
    apiKey: init.modelBroker.capability,
    api: init.modelApi,
    authHeader: true,
    models: [
      {
        id: init.model,
        name: init.model,
        api: init.modelApi,
        reasoning: init.modelOptions.reasoning,
        input: init.modelOptions.input,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: init.modelOptions.contextWindow,
        maxTokens: init.modelOptions.maxTokens,
      },
    ],
  });
  const model = modelRuntime.getModel(init.provider, init.model);
  if (!model) {
    throw new Error(`Pi model not found: ${init.provider}/${init.model}`);
  }

  const runtimeToolNames = customTools.map((tool) => tool.name);
  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: init.workspace,
    agentDir: init.agentDir,
    modelRuntime,
    model,
    thinkingLevel: init.thinkingLevel,
    noTools: 'builtin',
    tools: runtimeToolNames,
    customTools,
    resourceLoader,
    sessionManager: SessionManager.continueRecent(
      init.workspace,
      init.sessionDir,
    ),
    settingsManager,
  });
  return {
    session,
    ...(modelFallbackMessage ? { modelFallbackMessage } : {}),
  };
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  const seen = new WeakSet<object>();
  const result = JSON.stringify(
    value,
    (_key, nested) => {
      if (nested && typeof nested === 'object') {
        if (seen.has(nested as object)) return '[Circular]';
        seen.add(nested as object);
      }
      return nested;
    },
    2,
  );
  return result ?? 'null';
}
