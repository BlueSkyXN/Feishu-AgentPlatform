import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';

import type { LoadedBindingConfig } from '../config/types.js';
import type { ToolBroker } from '../tools/tool-broker.js';
import type { BridgeEvent } from './text-delta-bridge.js';
import type {
  AgentPromptInput,
  AgentSessionHandle,
  AgentSessionSnapshot,
} from './agent-session.js';
import { createPiSessionCore } from './session-core.js';
import type { WorkerInit } from './worker-protocol.js';

export interface InProcessAgentSessionOptions {
  config: LoadedBindingConfig;
  workspace: string;
  sessionDir: string;
  agentDir: string;
  broker: ToolBroker;
  modelAccess: {
    baseUrl: string;
    capability: string;
    revoke(): void;
  };
}

export class InProcessAgentSession implements AgentSessionHandle {
  private readonly listeners = new Set<(event: BridgeEvent) => void>();
  private unsubscribe: (() => void) | undefined;
  private disposed = false;

  private constructor(
    private readonly session: AgentSession,
    private readonly revokeModelAccess: () => void,
  ) {
    this.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      const mapped = mapEvent(event);
      if (mapped) for (const listener of this.listeners) listener(mapped);
    });
  }

  static async create(
    options: InProcessAgentSessionOptions,
  ): Promise<InProcessAgentSession> {
    const init: WorkerInit = {
      workspace: options.workspace,
      sessionDir: options.sessionDir,
      agentDir: options.agentDir,
      provider: options.config.agent.provider,
      model: options.config.agent.model,
      modelApi: options.config.agent.modelApi,
      modelOptions: options.config.agent.modelOptions,
      modelBroker: {
        baseUrl: options.modelAccess.baseUrl,
        capability: options.modelAccess.capability,
      },
      thinkingLevel: options.config.agent.thinkingLevel,
      systemPrompt: options.config.systemPrompt,
      skillPaths: options.config.agent.skillPaths,
      tools: [
        ...options.config.agent.feishuTools,
        ...options.config.agent.workspaceTools,
      ],
    };
    const core = await createPiSessionCore(
      init,
      async (name, args, signal) => await options.broker.execute(name, args, signal),
    );
    return new InProcessAgentSession(core.session, options.modelAccess.revoke);
  }

  subscribe(listener: (event: BridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(input: AgentPromptInput): Promise<void> {
    if (this.disposed) throw new Error('Pi agent session is not available.');
    if (input.images.length > 0) {
      await this.session.prompt(input.prompt, { images: input.images });
    } else {
      await this.session.prompt(input.prompt);
    }
  }

  async abort(): Promise<void> {
    if (this.disposed) return;
    if (this.session.isStreaming) await this.session.abort();
  }

  snapshot(): AgentSessionSnapshot {
    const model = this.session.model;
    return {
      sessionId: this.session.sessionId,
      model: model ? `${model.provider}/${model.id}` : '(no model)',
      messageCount: this.session.messages.length,
      streaming: this.session.isStreaming,
      supportsImages: Boolean(model?.input?.includes('image')),
      available: !this.disposed,
      isolation: 'in-process',
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.session.isStreaming) await this.session.abort();
    this.session.dispose();
    this.revokeModelAccess();
  }
}

function mapEvent(event: AgentSessionEvent): BridgeEvent | undefined {
  if (
    event.type === 'message_update' &&
    event.assistantMessageEvent.type === 'text_delta'
  ) {
    return { type: 'text_delta', delta: event.assistantMessageEvent.delta };
  }
  if (event.type === 'tool_execution_start') {
    return { type: 'tool_start', toolName: event.toolName };
  }
  if (event.type === 'tool_execution_end') {
    return {
      type: 'tool_end',
      toolName: event.toolName,
      isError: event.isError,
    };
  }
  return undefined;
}
