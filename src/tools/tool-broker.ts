import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';

import type {
  FeishuToolName,
  LoadedBindingConfig,
  ToolIdentity,
  WorkspaceToolName,
} from '../config/types.js';
import type { ApprovalCoordinator } from '../approvals/coordinator.js';
import { withTimeout } from '../core/timeout.js';
import {
  FeishuOpenApiClient,
  type FeishuApiRequest,
} from '../feishu/api-client.js';
import type { FeishuIdentityContextService } from '../feishu/identity-context.js';
import type { WorkspaceGuard } from '../sandbox/types.js';
import { readLarkCliSkill, runLarkCliOperation } from './lark-cli.js';
import type { BrokerToolName } from './catalog.js';
import type { TurnContextRef } from './turn-context.js';

interface ToolChannel {
  getChatInfo(chatId: string): Promise<unknown>;
}

export interface ToolBrokerDependencies {
  config: LoadedBindingConfig;
  channel: ToolChannel;
  api: FeishuOpenApiClient;
  identityContext: FeishuIdentityContextService;
  workspace?: WorkspaceGuard;
  approvals?: ApprovalCoordinator;
  turn: TurnContextRef;
}

export class ToolBroker {
  constructor(private readonly dependencies: ToolBrokerDependencies) {}

  async execute(
    name: BrokerToolName,
    rawArguments: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const timeoutMs = this.dependencies.config.conversation.toolTimeoutSeconds * 1_000;
    const args = hostControlledArguments(rawArguments);
    validateBeforeAuthorization(name, args);
    const approved = await this.authorize(name, args, signal);
    return await withTimeout(
      (operationSignal) => this.executeUnsafe(name, args, approved, operationSignal),
      timeoutMs,
      `Tool ${name}`,
      signal,
    );
  }

  private async executeUnsafe(
    name: BrokerToolName,
    args: Record<string, unknown>,
    approved: boolean,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const turn = this.dependencies.turn.require();
    const requestFeishu = (
      request: Omit<FeishuApiRequest, 'signal'>,
    ): Promise<unknown> => this.dependencies.api.request({
      ...request,
      ...(signal ? { signal } : {}),
    });
    if (isFeishuTool(name)) {
      if (!this.dependencies.config.agent.feishuTools.includes(name)) {
        throw new Error(`Feishu tool is disabled by manifest: ${name}`);
      }
    } else if (isWorkspaceTool(name)) {
      if (!this.dependencies.config.agent.workspaceTools.includes(name)) {
        throw new Error(`Workspace tool is disabled by manifest: ${name}`);
      }
    } else {
      return assertNever(name);
    }

    switch (name) {
      case 'user.profile':
        return await this.dependencies.identityContext.currentUserProfile(
          turn.message,
          turn.tenantKey,
          signal,
        );
      case 'chat.info':
        return await this.dependencies.channel.getChatInfo(turn.message.chatId);
      case 'message.history':
        return await this.dependencies.identityContext.currentChatHistory(
          turn.message,
          optionalInteger(args.page_size, 1, 50),
          signal,
        );
      case 'doc.read':
        return await requestFeishu({
          method: 'GET',
          path: `/open-apis/docx/v1/documents/${segment(requiredString(args.document_id, 'document_id'))}/raw_content`,
          identity: this.toolIdentity(name),
          userId: turn.identity.openId,
        });
      case 'doc.create':
        return await requestFeishu({
          method: 'POST',
          path: '/open-apis/docx/v1/documents',
          body: compact({
            title: requiredString(args.title, 'title'),
            folder_token: optionalString(args.folder_token),
          }),
          identity: this.toolIdentity(name),
          userId: turn.identity.openId,
        });
      case 'base.records.list':
        return await requestFeishu({
          method: 'GET',
          path: baseRecordsPath(
            requiredString(args.app_token, 'app_token'),
            requiredString(args.table_id, 'table_id'),
          ),
          query: compact({
            page_size: optionalInteger(args.page_size, 1, 500) ?? 100,
            page_token: optionalString(args.page_token),
            view_id: optionalString(args.view_id),
            filter: optionalString(args.filter),
            field_names: optionalString(args.field_names_json),
            sort: optionalString(args.sort_json),
          }),
          identity: this.toolIdentity(name),
          userId: turn.identity.openId,
        });
      case 'base.records.search':
        return await requestFeishu({
          method: 'POST',
          path: `${baseRecordsPath(
            requiredString(args.app_token, 'app_token'),
            requiredString(args.table_id, 'table_id'),
          )}/search`,
          query: compact({
            page_size: optionalInteger(args.page_size, 1, 500) ?? 100,
            page_token: optionalString(args.page_token),
          }),
          body: parseJsonObject(requiredString(args.body_json, 'body_json'), 'body_json'),
          identity: this.toolIdentity(name),
          userId: turn.identity.openId,
        });
      case 'base.records.create': {
        const clientToken = optionalNonEmptyString(args.client_token, 'client_token');
        return await requestFeishu({
          method: 'POST',
          path: baseRecordsPath(
            requiredString(args.app_token, 'app_token'),
            requiredString(args.table_id, 'table_id'),
          ),
          body: { fields: objectBody(args.fields, 'fields') },
          ...(clientToken ? { query: { client_token: clientToken } } : {}),
          identity: this.toolIdentity(name),
          userId: turn.identity.openId,
        });
      }
      case 'base.records.update': {
        const clientToken = optionalNonEmptyString(args.client_token, 'client_token');
        return await requestFeishu({
          method: 'PUT',
          path: `${baseRecordsPath(
            requiredString(args.app_token, 'app_token'),
            requiredString(args.table_id, 'table_id'),
          )}/${segment(requiredString(args.record_id, 'record_id'))}`,
          body: { fields: objectBody(args.fields, 'fields') },
          ...(clientToken ? { query: { client_token: clientToken } } : {}),
          identity: this.toolIdentity(name),
          userId: turn.identity.openId,
        });
      }
      case 'base.records.delete':
        return await requestFeishu({
          method: 'DELETE',
          path: `${baseRecordsPath(
            requiredString(args.app_token, 'app_token'),
            requiredString(args.table_id, 'table_id'),
          )}/${segment(requiredString(args.record_id, 'record_id'))}`,
          identity: this.toolIdentity(name),
          userId: turn.identity.openId,
        });
      case 'calendar.events.list':
        return await requestFeishu({
          method: 'GET',
          path: `/open-apis/calendar/v4/calendars/${segment(requiredString(args.calendar_id, 'calendar_id'))}/events`,
          query: compact({
            start_time: optionalString(args.start_time),
            end_time: optionalString(args.end_time),
            page_size: optionalInteger(args.page_size, 1, 500) ?? 100,
            page_token: optionalString(args.page_token),
          }),
          identity: this.toolIdentity(name),
          userId: turn.identity.openId,
        });
      case 'calendar.events.create': {
        const calendarId = segment(requiredString(args.calendar_id, 'calendar_id'));
        const idempotencyKey = optionalNonEmptyString(
          args.idempotency_key,
          'idempotency_key',
        );
        return await requestFeishu({
          method: 'POST',
          path: `/open-apis/calendar/v4/calendars/${calendarId}/events`,
          body: calendarCreateBody(args),
          ...(idempotencyKey ? { query: { idempotency_key: idempotencyKey } } : {}),
          identity: this.toolIdentity(name),
          userId: turn.identity.openId,
        });
      }
      case 'calendar.events.update': {
        const calendarId = segment(requiredString(args.calendar_id, 'calendar_id'));
        const eventId = segment(requiredString(args.event_id, 'event_id'));
        return await requestFeishu({
          method: 'PATCH',
          path: `/open-apis/calendar/v4/calendars/${calendarId}/events/${eventId}`,
          body: objectBody(args.body, 'body'),
          identity: this.toolIdentity(name),
          userId: turn.identity.openId,
        });
      }
      case 'calendar.events.delete': {
        const calendarId = segment(requiredString(args.calendar_id, 'calendar_id'));
        const eventId = segment(requiredString(args.event_id, 'event_id'));
        return await requestFeishu({
          method: 'DELETE',
          path: `/open-apis/calendar/v4/calendars/${calendarId}/events/${eventId}`,
          identity: this.toolIdentity(name),
          userId: turn.identity.openId,
        });
      }
      case 'task.list':
        return await requestFeishu({
          method: 'GET',
          path: '/open-apis/task/v2/tasks',
          query: compact({
            page_size: optionalInteger(args.page_size, 1, 100) ?? 50,
            page_token: optionalString(args.page_token),
            completed: optionalBoolean(args.completed),
          }),
          identity: this.toolIdentity(name),
          userId: turn.identity.openId,
        });
      case 'task.create':
        return await requestFeishu({
          method: 'POST',
          path: '/open-apis/task/v2/tasks',
          body: taskCreateBody(args),
          identity: this.toolIdentity(name),
          userId: turn.identity.openId,
        });
      case 'task.update':
        return await requestFeishu({
          method: 'PATCH',
          path: `/open-apis/task/v2/tasks/${segment(requiredString(args.task_guid, 'task_guid'))}`,
          body: taskUpdateBody(args),
          identity: this.toolIdentity(name),
          userId: turn.identity.openId,
        });
      case 'task.delete':
        return await requestFeishu({
          method: 'DELETE',
          path: `/open-apis/task/v2/tasks/${segment(requiredString(args.task_guid, 'task_guid'))}`,
          identity: this.toolIdentity(name),
          userId: turn.identity.openId,
        });
      case 'approval.instance.get':
        return await requestFeishu({
          method: 'GET',
          path: `/open-apis/approval/v4/instances/${segment(requiredString(args.instance_id, 'instance_id'))}`,
          identity: this.toolIdentity(name),
          userId: turn.identity.openId,
        });
      case 'approval.instance.detail':
        return await requestFeishu({
          method: 'GET',
          path: '/open-apis/approval/v4/instances/detail',
          query: {
            instance_code: requiredString(args.instance_code, 'instance_code'),
          },
          identity: this.toolIdentity(name),
          userId: turn.identity.openId,
        });
      case 'approval.instance.create':
        return await requestFeishu({
          method: 'POST',
          path: '/open-apis/approval/v4/instances',
          body: approvalCreateBody(args),
          identity: this.toolIdentity(name),
          userId: turn.identity.openId,
        });
      case 'openapi.get':
        const path = requiredString(args.path, 'path');
        if (
          !this.dependencies.config.agent.allowCrossChatRead &&
          path.startsWith('/open-apis/im/')
        ) {
          throw new Error(
            'Generic IM OpenAPI access requires allowCrossChatRead=true; use current-chat typed tools instead.',
          );
        }
        const query = optionalJsonObject(args.query_json, 'query_json');
        return await requestFeishu({
          method: 'GET',
          path,
          ...(query ? { query } : {}),
          identity: this.toolIdentity(name),
          userId: turn.identity.openId,
          enforceGenericAllowlist: true,
        });
      case 'larkcli.run':
        return await runLarkCliOperation(
          this.dependencies.config,
          requiredString(args.operation_id, 'operation_id'),
          args.parameters,
          {
            chatId: turn.message.chatId,
            chatType: turn.message.chatType,
            senderId: turn.message.senderId,
            messageId: turn.message.messageId,
            ...(turn.message.threadId ? { threadId: turn.message.threadId } : {}),
            ...(turn.message.rootId ? { rootId: turn.message.rootId } : {}),
          },
          approved,
          signal,
        );
      case 'larkcli.skill.read':
        return await readLarkCliSkill(
          this.dependencies.config,
          requiredString(args.skill, 'skill'),
          optionalString(args.path),
          signal,
        );
      case 'workspace.list':
        return await requireWorkspace(this.dependencies.workspace).list(
          optionalString(args.path) ?? '.',
          optionalInteger(args.max_entries, 1, 5_000) ?? 500,
          signal,
        );
      case 'workspace.read':
        return {
          content: await requireWorkspace(this.dependencies.workspace).read(
            requiredString(args.path, 'path'),
            optionalInteger(args.max_bytes, 1, this.dependencies.config.sandbox.maxReadBytes),
            signal,
          ),
        };
      case 'workspace.search':
        return await requireWorkspace(this.dependencies.workspace).search(
          requiredString(args.query, 'query'),
          optionalString(args.path) ?? '.',
          optionalInteger(args.max_results, 1, 500) ?? 100,
          signal,
        );
      case 'workspace.write':
        return await requireWorkspace(this.dependencies.workspace).write(
          requiredString(args.path, 'path'),
          requiredString(args.content, 'content', true),
          signal,
        );
      default:
        return assertNever(name);
    }
  }

  private async authorize(
    name: BrokerToolName,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const turn = this.dependencies.turn.require();
    const policy = name === 'larkcli.run'
      ? this.dependencies.config.agent.larkCli.operations.find(
          (operation) => operation.id === requiredString(args.operation_id, 'operation_id'),
        )
      : this.dependencies.config.agent.toolGrants.find((grant) => grant.name === name);
    if (!policy) throw new Error(`Tool has no Host grant: ${name}`);
    if (policy.effect === 'read' || policy.approval === 'never') return true;
    if (!this.dependencies.approvals) {
      throw new Error(`Tool approval coordinator is unavailable for ${name}.`);
    }
    await this.dependencies.approvals.request({
      appKey: turn.appKey,
      agentId: turn.agentId,
      bindingId: turn.bindingId,
      conversationKey: turn.conversationKey,
      chatId: turn.message.chatId,
      messageId: turn.message.messageId,
      replyInThread: Boolean(turn.message.threadId ?? turn.message.rootId),
      requesterOpenId: turn.message.senderId,
      operation: name === 'larkcli.run'
        ? `lark-cli:${requiredString(args.operation_id, 'operation_id')}`
        : name,
      effect: policy.effect,
      approval: policy.approval,
      arguments: args,
    }, signal);
    return true;
  }

  private toolIdentity(name: FeishuToolName): ToolIdentity {
    return this.dependencies.config.agent.toolGrants.find((grant) => grant.name === name)
      ?.identity ?? this.dependencies.config.agent.defaultToolIdentity;
  }
}

function isFeishuTool(name: BrokerToolName): name is FeishuToolName {
  return !name.startsWith('workspace.');
}

function isWorkspaceTool(name: BrokerToolName): name is WorkspaceToolName {
  return name.startsWith('workspace.');
}

function requireWorkspace(value: WorkspaceGuard | undefined): WorkspaceGuard {
  if (!value) throw new Error('This Agent has no ConversationSession WorkspaceGuard.');
  return value;
}

function objectArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool arguments must be an object.');
  }
  return value as Record<string, unknown>;
}

function hostControlledArguments(value: unknown): Record<string, unknown> {
  const { identity: _modelIdentity, ...args } = objectArgs(value);
  return args;
}

function validateBeforeAuthorization(
  name: BrokerToolName,
  args: Record<string, unknown>,
): void {
  switch (name) {
    case 'base.records.create':
      baseRecordsPath(
        requiredString(args.app_token, 'app_token'),
        requiredString(args.table_id, 'table_id'),
      );
      objectBody(args.fields, 'fields');
      optionalNonEmptyString(args.client_token, 'client_token');
      return;
    case 'base.records.update':
      baseRecordsPath(
        requiredString(args.app_token, 'app_token'),
        requiredString(args.table_id, 'table_id'),
      );
      segment(requiredString(args.record_id, 'record_id'));
      objectBody(args.fields, 'fields');
      optionalNonEmptyString(args.client_token, 'client_token');
      return;
    case 'calendar.events.create':
      segment(requiredString(args.calendar_id, 'calendar_id'));
      calendarCreateBody(args);
      optionalNonEmptyString(args.idempotency_key, 'idempotency_key');
      return;
    case 'task.create':
      taskCreateBody(args);
      return;
    case 'task.update':
      segment(requiredString(args.task_guid, 'task_guid'));
      taskUpdateBody(args);
      return;
    case 'approval.instance.detail':
      requiredString(args.instance_code, 'instance_code');
      return;
    case 'approval.instance.create':
      approvalCreateBody(args);
      return;
    default:
      return;
  }
}

function calendarCreateBody(args: Record<string, unknown>): Record<string, unknown> {
  const body = objectBody(args.body, 'body');
  objectBody(body.start_time, 'body.start_time');
  objectBody(body.end_time, 'body.end_time');
  return body;
}

function taskCreateBody(args: Record<string, unknown>): Record<string, unknown> {
  const body = objectBody(args.body, 'body');
  requiredString(body.summary, 'body.summary');
  return body;
}

function taskUpdateBody(args: Record<string, unknown>): Record<string, unknown> {
  const body = objectBody(args.body, 'body');
  const task = objectBody(body.task, 'body.task');
  const updateFields = requiredNonEmptyStringArray(
    body.update_fields,
    'body.update_fields',
  );
  return { ...body, task, update_fields: updateFields };
}

function approvalCreateBody(args: Record<string, unknown>): Record<string, unknown> {
  const body = objectBody(args.body, 'body');
  requiredString(body.approval_code, 'body.approval_code');
  return body;
}

function objectBody(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  name: string,
  allowEmpty = false,
): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new Error(`${name} must be a string${allowEmpty ? '' : ' and must not be empty'}.`);
  }
  return allowEmpty ? value : value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('Expected a string.');
  return value;
}

function optionalNonEmptyString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredString(value, name);
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error('Expected a boolean.');
  return value;
}

function optionalInteger(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`Expected an integer from ${min} to ${max}.`);
  }
  return value as number;
}

function requiredNonEmptyStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty string array.`);
  }
  return value.map((item, index) => requiredString(item, `${name}[${index}]`));
}

function parseJsonObject(value: string, name: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${name} must be valid JSON.`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function optionalJsonObject(
  value: unknown,
  name: string,
): Record<string, unknown> | undefined {
  const string = optionalString(value);
  return string ? parseJsonObject(string, name) : undefined;
}

function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

function segment(value: string): string {
  if (
    !value ||
    Buffer.byteLength(value, 'utf8') > 1_024 ||
    /[\/\\?#\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error('Feishu resource identifier contains prohibited characters.');
  }
  return encodeURIComponent(value);
}

function baseRecordsPath(appToken: string, tableId: string): string {
  return `/open-apis/bitable/v1/apps/${segment(appToken)}/tables/${segment(tableId)}/records`;
}

function assertNever(value: never): never {
  throw new Error(`Unknown tool: ${String(value)}`);
}

export function currentMessageForTool(turn: TurnContextRef): NormalizedMessage {
  return turn.require().message;
}
