import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';

export interface ResolvedUserIdentity {
  openId: string;
  tenantKey: string;
  displayName?: string;
  userId?: string;
  unionId?: string;
}

export interface RecentConversationMessage {
  messageId: string;
  senderOpenId?: string;
  senderName?: string;
  createTime?: number;
  messageType?: string;
  content: string;
  rootId?: string;
  parentId?: string;
}

export interface TurnContext {
  appKey: string;
  agentId: string;
  bindingId: string;
  conversationKey: string;
  tenantKey: string;
  message: NormalizedMessage;
  identity: ResolvedUserIdentity;
  recentHistory: RecentConversationMessage[];
  workspace: string;
  receivedAt: number;
}

export class TurnContextRef {
  private current: TurnContext | undefined;

  set(value: TurnContext): void {
    if (this.current) {
      throw new Error('Turn context is already active for this session.');
    }
    this.current = value;
  }

  clear(): void {
    this.current = undefined;
  }

  require(): TurnContext {
    if (!this.current) {
      throw new Error('This tool can only run while processing a Feishu turn.');
    }
    return this.current;
  }

  snapshot(): TurnContext | undefined {
    return this.current;
  }
}
