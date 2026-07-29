import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';

import type { LoadedBindingConfig } from '../config/types.js';
import { shouldReplyInThread } from '../core/conversation.js';
import { Logger, errorFields } from '../core/logger.js';
import { withTimeout } from '../core/timeout.js';
import type { PreparedTurnInput } from '../feishu/attachments.js';
import type { AgentSessionHandle } from './agent-session.js';
import { bridgeTextDeltas } from './text-delta-bridge.js';

export async function streamSessionReply(
  channel: LarkChannel,
  session: AgentSessionHandle,
  config: LoadedBindingConfig,
  message: NormalizedMessage,
  input: PreparedTurnInput,
  logger: Logger,
): Promise<void> {
  await channel.stream(
    message.chatId,
    {
      markdown: async (controller: { append(chunk: string): Promise<void> | void }) => {
        await bridgeTextDeltas(
          {
            subscribe: (listener) => session.subscribe(listener),
            prompt: async () =>
              await withTimeout(
                () => session.prompt({ prompt: input.prompt, images: input.images }),
                config.conversation.turnTimeoutSeconds * 1_000,
                'Pi turn',
                undefined,
                async () => await session.abort(),
              ),
            abort: () => session.abort(),
          },
          { append: async (chunk) => await controller.append(chunk) },
          {
            onToolStart: (toolName) => {
              logger.info('Pi tool execution started', { toolName });
            },
            onToolEnd: (toolName, isError) => {
              logger.info('Pi tool execution ended', { toolName, isError });
            },
            onAbortError: (error) => {
              logger.warn('Failed to abort Pi after stream failure', {
                ...errorFields(error),
              });
            },
          },
        );
      },
    },
    {
      replyTo: message.messageId,
      replyInThread: shouldReplyInThread(message),
    },
  );

  logger.info('Feishu turn completed', {
    messageId: message.messageId,
    imageCount: input.images.length,
    attachmentPathCount: input.attachmentPaths.length,
    skippedAttachmentCount: input.skipped.length,
    attachmentBytes: input.totalBytes,
    model: session.snapshot().model,
    appKey: config.appKey,
    agentId: config.agentId,
    bindingId: config.id,
  });
}
