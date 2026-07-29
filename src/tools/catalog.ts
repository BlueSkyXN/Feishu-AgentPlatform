import { Type } from 'typebox';

import type { FeishuToolName, WorkspaceToolName } from '../config/types.js';

export type BrokerToolName = FeishuToolName | WorkspaceToolName;

export interface ToolCatalogEntry {
  logicalName: BrokerToolName;
  runtimeName: string;
  label: string;
  description: string;
  parameters: unknown;
}

const entries: Record<BrokerToolName, ToolCatalogEntry> = {
  'user.profile': {
    logicalName: 'user.profile',
    runtimeName: 'feishu_current_user_profile',
    label: 'Current Feishu user profile',
    description:
      'Read the verified profile of the user who sent the current message. The user cannot be changed.',
    parameters: Type.Object({}),
  },
  'chat.info': {
    logicalName: 'chat.info',
    runtimeName: 'feishu_current_chat_info',
    label: 'Current Feishu chat information',
    description:
      'Read metadata for the current Feishu chat. The target chat cannot be changed.',
    parameters: Type.Object({}),
  },
  'message.history': {
    logicalName: 'message.history',
    runtimeName: 'feishu_current_chat_history',
    label: 'Current Feishu chat history',
    description:
      'Read recent messages from the current chat or topic only. This operation is read-only.',
    parameters: Type.Object({
      page_size: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
    }),
  },
  'doc.read': {
    logicalName: 'doc.read',
    runtimeName: 'feishu_doc_read',
    label: 'Read Feishu document',
    description: 'Read raw text content from a Feishu Docx document.',
    parameters: Type.Object({
      document_id: Type.String({ minLength: 1, maxLength: 256 }),
    }),
  },
  'doc.create': {
    logicalName: 'doc.create',
    runtimeName: 'feishu_doc_create',
    label: 'Create Feishu document',
    description:
      'Create a Feishu Docx document. The Host applies the configured identity and approval policy.',
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 800 }),
      folder_token: Type.Optional(Type.String({ maxLength: 256 })),
    }),
  },
  'base.records.list': {
    logicalName: 'base.records.list',
    runtimeName: 'feishu_base_list_records',
    label: 'List Feishu Base records',
    description: 'List records from a Feishu Base table without modifying data.',
    parameters: Type.Object({
      app_token: Type.String({ minLength: 1, maxLength: 256 }),
      table_id: Type.String({ minLength: 1, maxLength: 256 }),
      page_size: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
      page_token: Type.Optional(Type.String({ maxLength: 1024 })),
      view_id: Type.Optional(Type.String({ maxLength: 256 })),
      filter: Type.Optional(Type.String({ maxLength: 20_000 })),
      field_names_json: Type.Optional(Type.String({ maxLength: 20_000 })),
      sort_json: Type.Optional(Type.String({ maxLength: 20_000 })),
    }),
  },
  'base.records.search': {
    logicalName: 'base.records.search',
    runtimeName: 'feishu_base_search_records',
    label: 'Search Feishu Base records',
    description:
      'Run the documented Base record search endpoint. POST is used only for a read-only search operation.',
    parameters: Type.Object({
      app_token: Type.String({ minLength: 1, maxLength: 256 }),
      table_id: Type.String({ minLength: 1, maxLength: 256 }),
      body_json: Type.String({ maxLength: 100_000 }),
      page_size: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
      page_token: Type.Optional(Type.String({ maxLength: 1024 })),
    }),
  },
  'base.records.create': {
    logicalName: 'base.records.create',
    runtimeName: 'feishu_base_create_record',
    label: 'Create Feishu Base record',
    description: 'Create one record in an explicitly selected Feishu Base table.',
    parameters: Type.Object({
      app_token: Type.String({ minLength: 1, maxLength: 256 }),
      table_id: Type.String({ minLength: 1, maxLength: 256 }),
      fields: Type.Record(Type.String(), Type.Unknown()),
      client_token: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    }),
  },
  'base.records.update': {
    logicalName: 'base.records.update',
    runtimeName: 'feishu_base_update_record',
    label: 'Update Feishu Base record',
    description: 'Update fields of one explicitly selected Feishu Base record.',
    parameters: Type.Object({
      app_token: Type.String({ minLength: 1, maxLength: 256 }),
      table_id: Type.String({ minLength: 1, maxLength: 256 }),
      record_id: Type.String({ minLength: 1, maxLength: 256 }),
      fields: Type.Record(Type.String(), Type.Unknown()),
      client_token: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    }),
  },
  'base.records.delete': {
    logicalName: 'base.records.delete',
    runtimeName: 'feishu_base_delete_record',
    label: 'Delete Feishu Base record',
    description: 'Delete one explicitly selected record. This is a high-risk operation.',
    parameters: Type.Object({
      app_token: Type.String({ minLength: 1, maxLength: 256 }),
      table_id: Type.String({ minLength: 1, maxLength: 256 }),
      record_id: Type.String({ minLength: 1, maxLength: 256 }),
    }),
  },
  'calendar.events.list': {
    logicalName: 'calendar.events.list',
    runtimeName: 'feishu_calendar_list_events',
    label: 'List Feishu calendar events',
    description: 'List calendar events. This tool cannot create or update events.',
    parameters: Type.Object({
      calendar_id: Type.String({ minLength: 1, maxLength: 256 }),
      start_time: Type.Optional(Type.String({ maxLength: 64 })),
      end_time: Type.Optional(Type.String({ maxLength: 64 })),
      page_size: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
      page_token: Type.Optional(Type.String({ maxLength: 1024 })),
    }),
  },
  'calendar.events.create': {
    logicalName: 'calendar.events.create',
    runtimeName: 'feishu_calendar_create_event',
    label: 'Create Feishu calendar event',
    description: 'Create an event using a structured Feishu Calendar request body.',
    parameters: Type.Object({
      calendar_id: Type.String({ minLength: 1, maxLength: 256 }),
      body: Type.Object({
        start_time: Type.Record(Type.String(), Type.Unknown()),
        end_time: Type.Record(Type.String(), Type.Unknown()),
      }, { additionalProperties: true }),
      idempotency_key: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    }),
  },
  'calendar.events.update': {
    logicalName: 'calendar.events.update',
    runtimeName: 'feishu_calendar_update_event',
    label: 'Update Feishu calendar event',
    description: 'Update one explicitly selected calendar event.',
    parameters: Type.Object({
      calendar_id: Type.String({ minLength: 1, maxLength: 256 }),
      event_id: Type.String({ minLength: 1, maxLength: 256 }),
      body: Type.Record(Type.String(), Type.Unknown()),
    }),
  },
  'calendar.events.delete': {
    logicalName: 'calendar.events.delete',
    runtimeName: 'feishu_calendar_delete_event',
    label: 'Delete Feishu calendar event',
    description: 'Delete one explicitly selected event. This is a high-risk operation.',
    parameters: Type.Object({
      calendar_id: Type.String({ minLength: 1, maxLength: 256 }),
      event_id: Type.String({ minLength: 1, maxLength: 256 }),
    }),
  },
  'task.list': {
    logicalName: 'task.list',
    runtimeName: 'feishu_task_list',
    label: 'List Feishu tasks',
    description: 'List tasks without creating, updating, or deleting any task.',
    parameters: Type.Object({
      page_size: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
      page_token: Type.Optional(Type.String({ maxLength: 1024 })),
      completed: Type.Optional(Type.Boolean()),
    }),
  },
  'task.create': {
    logicalName: 'task.create',
    runtimeName: 'feishu_task_create',
    label: 'Create Feishu task',
    description: 'Create a task using a structured Feishu Task request body.',
    parameters: Type.Object({
      body: Type.Object({
        summary: Type.String({ minLength: 1 }),
      }, { additionalProperties: true }),
    }),
  },
  'task.update': {
    logicalName: 'task.update',
    runtimeName: 'feishu_task_update',
    label: 'Update Feishu task',
    description: 'Update one explicitly selected Feishu task.',
    parameters: Type.Object({
      task_guid: Type.String({ minLength: 1, maxLength: 256 }),
      body: Type.Object({
        task: Type.Record(Type.String(), Type.Unknown()),
        update_fields: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      }),
    }),
  },
  'task.delete': {
    logicalName: 'task.delete',
    runtimeName: 'feishu_task_delete',
    label: 'Delete Feishu task',
    description: 'Delete one explicitly selected task. This is a high-risk operation.',
    parameters: Type.Object({
      task_guid: Type.String({ minLength: 1, maxLength: 256 }),
    }),
  },
  'approval.instance.get': {
    logicalName: 'approval.instance.get',
    runtimeName: 'feishu_approval_instance_get',
    label: 'Get Feishu approval instance',
    description: 'Read one approval instance by instance ID.',
    parameters: Type.Object({
      instance_id: Type.String({ minLength: 1, maxLength: 256 }),
    }),
  },
  'approval.instance.detail': {
    logicalName: 'approval.instance.detail',
    runtimeName: 'feishu_approval_instance_detail',
    label: 'Get Feishu approval instance detail',
    description: 'Read one approval instance detail by instance code using user identity.',
    parameters: Type.Object({
      instance_code: Type.String({ minLength: 1, maxLength: 256 }),
    }),
  },
  'approval.instance.create': {
    logicalName: 'approval.instance.create',
    runtimeName: 'feishu_approval_instance_create',
    label: 'Create Feishu approval instance',
    description: 'Create an approval instance using a structured request body.',
    parameters: Type.Object({
      body: Type.Object({
        approval_code: Type.String({ minLength: 1, maxLength: 256 }),
      }, { additionalProperties: true }),
    }),
  },
  'openapi.get': {
    logicalName: 'openapi.get',
    runtimeName: 'feishu_openapi_get',
    label: 'Read allowed Feishu OpenAPI',
    description:
      'Call an allowlisted Feishu OpenAPI endpoint using GET only. Mutating methods are impossible.',
    parameters: Type.Object({
      path: Type.String({ minLength: 12, maxLength: 2048 }),
      query_json: Type.Optional(Type.String({ maxLength: 100_000 })),
    }),
  },
  'larkcli.run': {
    logicalName: 'larkcli.run',
    runtimeName: 'feishu_lark_cli_operation',
    label: 'Run allowlisted lark-cli operation',
    description:
      'Run a named lark-cli operation allowed by the Agent definition. Identity, command, flags and approval are controlled by the Host.',
    parameters: Type.Object({
      operation_id: Type.String({ minLength: 1, maxLength: 64 }),
      parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
  },
  'larkcli.skill.read': {
    logicalName: 'larkcli.skill.read',
    runtimeName: 'feishu_lark_cli_skill_read',
    label: 'Read version-matched lark-cli skill',
    description:
      'Read a selected lark-cli SKILL.md or one referenced file from the pinned CLI version.',
    parameters: Type.Object({
      skill: Type.String({ minLength: 1, maxLength: 128 }),
      path: Type.Optional(Type.String({ maxLength: 512 })),
    }),
  },
  'workspace.list': {
    logicalName: 'workspace.list',
    runtimeName: 'workspace_list',
    label: 'List conversation workspace',
    description:
      'List files beneath the current conversation workspace. Absolute paths, parent traversal, and symlinks are rejected.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ maxLength: 1024 })),
      max_entries: Type.Optional(Type.Number({ minimum: 1, maximum: 5000 })),
    }),
  },
  'workspace.read': {
    logicalName: 'workspace.read',
    runtimeName: 'workspace_read',
    label: 'Read conversation workspace file',
    description:
      'Read a text file beneath the current conversation workspace only.',
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 1024 }),
      max_bytes: Type.Optional(Type.Number({ minimum: 1, maximum: 20_000_000 })),
    }),
  },
  'workspace.search': {
    logicalName: 'workspace.search',
    runtimeName: 'workspace_search',
    label: 'Search conversation workspace',
    description: 'Search text files beneath the current conversation workspace only.',
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 1024 }),
      path: Type.Optional(Type.String({ maxLength: 1024 })),
      max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
    }),
  },
  'workspace.write': {
    logicalName: 'workspace.write',
    runtimeName: 'workspace_write',
    label: 'Write conversation workspace file',
    description:
      'Write a UTF-8 file beneath the current conversation workspace. This tool is only exposed in read-write sandbox profiles.',
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 1024 }),
      content: Type.String({ maxLength: 5_000_000 }),
    }),
  },
};

export function toolCatalogEntry(name: BrokerToolName): ToolCatalogEntry {
  return entries[name];
}

export function enabledToolCatalog(
  feishuTools: readonly FeishuToolName[],
  workspaceTools: readonly WorkspaceToolName[],
): ToolCatalogEntry[] {
  return [...feishuTools, ...workspaceTools].map((name) => entries[name]);
}

export function logicalNameForRuntimeName(runtimeName: string): BrokerToolName | undefined {
  return Object.values(entries).find((entry) => entry.runtimeName === runtimeName)?.logicalName;
}
