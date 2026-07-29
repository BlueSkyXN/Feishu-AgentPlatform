import type {
  BrokerToolName,
} from '../tools/catalog.js';
import type { PiImageContent } from '../feishu/attachments.js';
import type { ThinkingLevel } from '../config/types.js';
import type { ModelApi } from '../config/types.js';
import type { BridgeEvent } from './text-delta-bridge.js';

export interface WorkerInit {
  workspace: string;
  sessionDir: string;
  agentDir: string;
  provider: string;
  model: string;
  modelApi: ModelApi;
  modelOptions: {
    reasoning: boolean;
    input: Array<'text' | 'image'>;
    contextWindow: number;
    maxTokens: number;
  };
  modelBroker: {
    baseUrl: string;
    capability: string;
  };
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  skillPaths: string[];
  tools: BrokerToolName[];
}

export type HostToWorkerMessage =
  | { type: 'init'; init: WorkerInit }
  | {
      type: 'prompt';
      requestId: string;
      prompt: string;
      images: PiImageContent[];
    }
  | { type: 'abort'; requestId: string }
  | { type: 'status'; requestId: string }
  | { type: 'dispose'; requestId: string }
  | {
      type: 'tool_result';
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      type: 'tool_result';
      requestId: string;
      ok: false;
      error: SerializedError;
    };

export interface WorkerStatus {
  sessionId: string;
  model: string;
  messageCount: number;
  streaming: boolean;
  supportsImages: boolean;
}

export type WorkerToHostMessage =
  | { type: 'ready'; status: WorkerStatus }
  | { type: 'event'; requestId: string; event: BridgeEvent }
  | { type: 'result'; requestId: string; status?: WorkerStatus }
  | { type: 'error'; requestId: string; error: SerializedError }
  | { type: 'tool_cancel'; requestId: string }
  | {
      type: 'tool_request';
      requestId: string;
      name: BrokerToolName;
      arguments: unknown;
    }
  | { type: 'fatal'; error: SerializedError };

export interface SerializedError {
  name: string;
  message: string;
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return { name: 'Error', message: String(error) };
}

export function deserializeError(error: SerializedError): Error {
  const value = new Error(error.message);
  value.name = error.name;
  return value;
}
