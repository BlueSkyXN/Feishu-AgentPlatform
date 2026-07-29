import type { PiImageContent } from '../feishu/attachments.js';
import type { BridgeEvent } from './text-delta-bridge.js';

export interface AgentPromptInput {
  prompt: string;
  images: PiImageContent[];
}

export interface AgentSessionSnapshot {
  sessionId: string;
  model: string;
  messageCount: number;
  streaming: boolean;
  supportsImages: boolean;
  available: boolean;
  isolation: 'process' | 'in-process';
  workerPid?: number;
}

export interface AgentSessionHandle {
  subscribe(listener: (event: BridgeEvent) => void): () => void;
  prompt(input: AgentPromptInput): Promise<void>;
  abort(): Promise<void>;
  snapshot(): AgentSessionSnapshot;
  dispose(): Promise<void>;
}
