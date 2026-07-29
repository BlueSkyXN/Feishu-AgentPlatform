import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';

import type { LoadedAppAgentBinding } from '../config/types.js';

export interface BindingRouteMatch {
  binding: LoadedAppAgentBinding;
  message: NormalizedMessage;
  commandPrefix?: string;
}

interface Candidate extends BindingRouteMatch {
  score: readonly [priority: number, commandLength: number, specificity: number];
}

export class AmbiguousBindingRouteError extends Error {
  constructor(readonly bindingIds: string[]) {
    super(`Message matches multiple bindings with equal precedence: ${bindingIds.join(', ')}.`);
    this.name = 'AmbiguousBindingRouteError';
  }
}

/** Deterministic one-message-to-one-Agent routing inside a Feishu AppRuntime. */
export class BindingRouter {
  private readonly defaultBinding: LoadedAppAgentBinding;

  constructor(private readonly bindings: LoadedAppAgentBinding[]) {
    const defaults = bindings.filter((binding) => binding.route.default);
    if (defaults.length !== 1 || !defaults[0]) {
      throw new Error('BindingRouter requires exactly one default binding.');
    }
    this.defaultBinding = defaults[0];
  }

  resolve(message: NormalizedMessage): BindingRouteMatch {
    const candidates = this.bindings
      .filter((binding) => !binding.route.default)
      .map((binding) => matchBinding(binding, message))
      .filter((value): value is Candidate => value !== undefined)
      .sort(compareCandidates);

    const winner = candidates[0];
    if (!winner) return { binding: this.defaultBinding, message };
    const tied = candidates.filter((candidate) => equalScore(candidate, winner));
    if (tied.length > 1) {
      throw new AmbiguousBindingRouteError(tied.map((candidate) => candidate.binding.id));
    }
    return {
      binding: winner.binding,
      message: winner.message,
      ...(winner.commandPrefix ? { commandPrefix: winner.commandPrefix } : {}),
    };
  }
}

function matchBinding(
  binding: LoadedAppAgentBinding,
  message: NormalizedMessage,
): Candidate | undefined {
  const route = binding.route;
  const topicKey = message.threadId ?? message.rootId ?? 'main';
  if (route.chatAllowlist.length > 0 && !route.chatAllowlist.includes(message.chatId)) {
    return undefined;
  }
  if (route.userAllowlist.length > 0 && !route.userAllowlist.includes(message.senderId)) {
    return undefined;
  }
  if (route.threadAllowlist.length > 0 && !route.threadAllowlist.includes(topicKey)) {
    return undefined;
  }

  const commandPrefix = longestMatchingPrefix(message.content, route.commandPrefixes);
  if (route.commandPrefixes.length > 0 && !commandPrefix) return undefined;
  const specificity = Number(route.chatAllowlist.length > 0) +
    Number(route.userAllowlist.length > 0) +
    Number(route.threadAllowlist.length > 0) +
    Number(route.commandPrefixes.length > 0);
  const routedMessage = commandPrefix
    ? {
        ...message,
        content:
          message.content
            .slice(
              message.content.length - message.content.trimStart().length +
                commandPrefix.length,
            )
            .trim() ||
          '请说明当前 Agent 可以完成的任务。',
      }
    : message;
  return {
    binding,
    message: routedMessage,
    ...(commandPrefix ? { commandPrefix } : {}),
    score: [route.priority, commandPrefix?.length ?? 0, specificity],
  };
}

function longestMatchingPrefix(content: string, prefixes: string[]): string | undefined {
  const normalized = content.trimStart().toLowerCase();
  return prefixes
    .filter(
      (prefix) =>
        normalized === prefix ||
        (normalized.startsWith(prefix) && /^\s/u.test(normalized.slice(prefix.length))),
    )
    .sort((left, right) => right.length - left.length)[0];
}

function compareCandidates(left: Candidate, right: Candidate): number {
  for (let index = 0; index < left.score.length; index += 1) {
    const difference = (right.score[index] ?? 0) - (left.score[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.binding.id.localeCompare(right.binding.id);
}

function equalScore(left: Candidate, right: Candidate): boolean {
  return left.score.every((value, index) => value === right.score[index]);
}
