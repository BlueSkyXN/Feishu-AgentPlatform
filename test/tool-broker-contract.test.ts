import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';

import type {
  FeishuToolName,
  LoadedBindingConfig,
  ToolEffect,
  ToolIdentity,
} from '../src/config/types.js';
import {
  FEISHU_TOOL_NAMES,
  READ_ONLY_FEISHU_TOOL_NAMES,
} from '../src/config/types.js';
import { loadAgentDefinition } from '../src/config/load-platform.js';
import type {
  ApprovalCoordinator,
  ApprovalRequest,
} from '../src/approvals/coordinator.js';
import type {
  FeishuApiRequest,
  FeishuOpenApiClient,
} from '../src/feishu/api-client.js';
import type { FeishuIdentityContextService } from '../src/feishu/identity-context.js';
import { toolCatalogEntry } from '../src/tools/catalog.js';
import { ToolBroker } from '../src/tools/tool-broker.js';
import { TurnContextRef } from '../src/tools/turn-context.js';

interface BrokerFixture {
  broker: ToolBroker;
  requests: FeishuApiRequest[];
  approvals: ApprovalRequest[];
}

function makeBroker(
  name: FeishuToolName,
  identity: ToolIdentity,
): BrokerFixture {
  const requests: FeishuApiRequest[] = [];
  const approvals: ApprovalRequest[] = [];
  const readOnly = (READ_ONLY_FEISHU_TOOL_NAMES as readonly string[]).includes(name);
  const effect: ToolEffect = readOnly ? 'read' : 'write';
  const turn = new TurnContextRef();
  turn.set({
    appKey: 'primary',
    agentId: 'contract-agent',
    bindingId: 'primary-contract-agent',
    conversationKey: 'contract-conversation',
    tenantKey: 'tenant',
    message: {
      messageId: 'om_current',
      chatId: 'oc_current',
      senderId: 'ou_current',
      content: 'test',
      chatType: 'group',
      rawContentType: 'text',
    } as NormalizedMessage,
    identity: { openId: 'ou_current', tenantKey: 'tenant' },
    recentHistory: [],
    workspace: '/tmp/not-used',
    receivedAt: Date.now(),
  });

  const broker = new ToolBroker({
    config: {
      conversation: { toolTimeoutSeconds: 5 },
      sandbox: {
        maxReadBytes: 1_000_000,
        maxWriteBytes: 1_000_000,
        maxTotalBytes: 256_000_000,
        maxFiles: 10_000,
      },
      agent: {
        feishuTools: [name],
        workspaceTools: [],
        allowCrossChatRead: false,
        defaultToolIdentity: identity === 'app' ? 'user' : 'app',
        toolGrants: [{
          name,
          identity,
          effect,
          approval: readOnly ? 'never' : 'requester',
        }],
        larkCli: { operations: [] },
      },
    } as unknown as LoadedBindingConfig,
    channel: { getChatInfo: async () => ({}) },
    api: {
      request: async ({ signal, ...request }: FeishuApiRequest) => {
        assert.ok(signal, 'typed Feishu requests must carry the tool AbortSignal');
        requests.push(request);
        return { code: 0 };
      },
    } as unknown as FeishuOpenApiClient,
    identityContext: {} as unknown as FeishuIdentityContextService,
    approvals: {
      request: async (request: ApprovalRequest) => {
        approvals.push(request);
      },
    } as unknown as ApprovalCoordinator,
    turn,
  });
  return { broker, requests, approvals };
}

test('typed Feishu catalog does not expose Host-controlled identity or doc.read.lang', () => {
  for (const name of FEISHU_TOOL_NAMES) {
    assert.equal(
      schemaDeclaresProperty(toolCatalogEntry(name).parameters, 'identity'),
      false,
      `${name} must not expose identity`,
    );
  }
  assert.equal(
    schemaDeclaresProperty(toolCatalogEntry('doc.read').parameters, 'lang'),
    false,
  );

  assert.deepEqual(requiredProperties(nestedProperty('calendar.events.create', 'body')), [
    'start_time',
    'end_time',
  ]);
  assert.deepEqual(requiredProperties(nestedProperty('task.create', 'body')), ['summary']);
  assert.deepEqual(requiredProperties(nestedProperty('task.update', 'body')), [
    'task',
    'update_fields',
  ]);
  assert.deepEqual(
    requiredProperties(nestedProperty('approval.instance.create', 'body')),
    ['approval_code'],
  );
});

test('typed tool request contracts map method, path, query, body and Host identity', async (t) => {
  const calendarBody = {
    summary: 'Release window',
    start_time: { timestamp: '1785254400', timezone: 'Asia/Shanghai' },
    end_time: { timestamp: '1785258000', timezone: 'Asia/Shanghai' },
  };
  const cases: Array<{
    label: string;
    name: FeishuToolName;
    identity: ToolIdentity;
    args: Record<string, unknown>;
    expected: FeishuApiRequest;
    approval: boolean;
  }> = [
    {
      label: 'doc.read drops removed lang and ignores model identity',
      name: 'doc.read',
      identity: 'app',
      args: { document_id: 'doccn_test', lang: 'en-US', identity: 'user' },
      expected: {
        method: 'GET',
        path: '/open-apis/docx/v1/documents/doccn_test/raw_content',
        identity: 'app',
        userId: 'ou_current',
      },
      approval: false,
    },
    {
      label: 'Base create sends client_token as query',
      name: 'base.records.create',
      identity: 'app',
      args: {
        app_token: 'app_test',
        table_id: 'tbl_test',
        fields: { Name: 'A' },
        client_token: 'create-001',
        identity: 'user',
      },
      expected: {
        method: 'POST',
        path: '/open-apis/bitable/v1/apps/app_test/tables/tbl_test/records',
        query: { client_token: 'create-001' },
        body: { fields: { Name: 'A' } },
        identity: 'app',
        userId: 'ou_current',
      },
      approval: true,
    },
    {
      label: 'Base update sends client_token as query',
      name: 'base.records.update',
      identity: 'user',
      args: {
        app_token: 'app_test',
        table_id: 'tbl_test',
        record_id: 'rec_test',
        fields: { Status: 'Done' },
        client_token: 'update-001',
        identity: 'app',
      },
      expected: {
        method: 'PUT',
        path: '/open-apis/bitable/v1/apps/app_test/tables/tbl_test/records/rec_test',
        query: { client_token: 'update-001' },
        body: { fields: { Status: 'Done' } },
        identity: 'user',
        userId: 'ou_current',
      },
      approval: true,
    },
    {
      label: 'Calendar create encodes special calendar ID and sends idempotency query',
      name: 'calendar.events.create',
      identity: 'user',
      args: {
        calendar_id: 'cal+ops@example.com',
        body: calendarBody,
        idempotency_key: 'event-001',
        identity: 'app',
      },
      expected: {
        method: 'POST',
        path: '/open-apis/calendar/v4/calendars/cal%2Bops%40example.com/events',
        query: { idempotency_key: 'event-001' },
        body: calendarBody,
        identity: 'user',
        userId: 'ou_current',
      },
      approval: true,
    },
    {
      label: 'Task create sends validated Task v2 body',
      name: 'task.create',
      identity: 'app',
      args: {
        body: { summary: 'Prepare release', description: 'Run the checklist' },
        identity: 'user',
      },
      expected: {
        method: 'POST',
        path: '/open-apis/task/v2/tasks',
        body: { summary: 'Prepare release', description: 'Run the checklist' },
        identity: 'app',
        userId: 'ou_current',
      },
      approval: true,
    },
    {
      label: 'Task update sends task and update_fields body',
      name: 'task.update',
      identity: 'user',
      args: {
        task_guid: 'task_test',
        body: { task: { summary: 'Updated' }, update_fields: ['summary'] },
        identity: 'app',
      },
      expected: {
        method: 'PATCH',
        path: '/open-apis/task/v2/tasks/task_test',
        body: { task: { summary: 'Updated' }, update_fields: ['summary'] },
        identity: 'user',
        userId: 'ou_current',
      },
      approval: true,
    },
    {
      label: 'Approval instance path lookup uses instance_id',
      name: 'approval.instance.get',
      identity: 'app',
      args: { instance_id: 'inst:123', identity: 'user' },
      expected: {
        method: 'GET',
        path: '/open-apis/approval/v4/instances/inst%3A123',
        identity: 'app',
        userId: 'ou_current',
      },
      approval: false,
    },
    {
      label: 'Approval detail uses instance_code query and user identity',
      name: 'approval.instance.detail',
      identity: 'user',
      args: { instance_code: 'code_123', identity: 'app' },
      expected: {
        method: 'GET',
        path: '/open-apis/approval/v4/instances/detail',
        query: { instance_code: 'code_123' },
        identity: 'user',
        userId: 'ou_current',
      },
      approval: false,
    },
    {
      label: 'Approval create validates and forwards approval_code',
      name: 'approval.instance.create',
      identity: 'user',
      args: {
        body: { approval_code: 'approval_123', form: '[]' },
        identity: 'app',
      },
      expected: {
        method: 'POST',
        path: '/open-apis/approval/v4/instances',
        body: { approval_code: 'approval_123', form: '[]' },
        identity: 'user',
        userId: 'ou_current',
      },
      approval: true,
    },
  ];

  for (const contract of cases) {
    await t.test(contract.label, async () => {
      const fixture = makeBroker(contract.name, contract.identity);
      await fixture.broker.execute(contract.name, contract.args);
      assert.deepEqual(fixture.requests, [contract.expected]);
      assert.equal(fixture.approvals.length, contract.approval ? 1 : 0);
      if (fixture.approvals[0]) {
        assert.equal(fixture.approvals[0].operation, contract.name);
        assert.equal(
          Object.hasOwn(fixture.approvals[0].arguments as object, 'identity'),
          false,
        );
      }
    });
  }
});

test('required typed write fields fail before approval or OpenAPI dispatch', async (t) => {
  const cases: Array<{
    label: string;
    name: FeishuToolName;
    args: Record<string, unknown>;
    error: RegExp;
  }> = [
    {
      label: 'Calendar start_time is required',
      name: 'calendar.events.create',
      args: { calendar_id: 'primary', body: { end_time: {} } },
      error: /body\.start_time must be an object/,
    },
    {
      label: 'Calendar end_time must be an object',
      name: 'calendar.events.create',
      args: { calendar_id: 'primary', body: { start_time: {}, end_time: [] } },
      error: /body\.end_time must be an object/,
    },
    {
      label: 'Task summary must not be blank',
      name: 'task.create',
      args: { body: { summary: '   ' } },
      error: /body\.summary must be a string and must not be empty/,
    },
    {
      label: 'Task update task must be an object',
      name: 'task.update',
      args: {
        task_guid: 'task_test',
        body: { task: [], update_fields: ['summary'] },
      },
      error: /body\.task must be an object/,
    },
    {
      label: 'Task update_fields must not be empty',
      name: 'task.update',
      args: { task_guid: 'task_test', body: { task: {}, update_fields: [] } },
      error: /body\.update_fields must be a non-empty string array/,
    },
    {
      label: 'Task update_fields entries must not be blank',
      name: 'task.update',
      args: { task_guid: 'task_test', body: { task: {}, update_fields: [' '] } },
      error: /body\.update_fields\[0\].*must not be empty/,
    },
    {
      label: 'Approval create requires approval_code',
      name: 'approval.instance.create',
      args: { body: { form: '[]' } },
      error: /body\.approval_code.*must not be empty/,
    },
  ];

  for (const contract of cases) {
    await t.test(contract.label, async () => {
      const fixture = makeBroker(
        contract.name,
        contract.name.startsWith('approval.') ? 'user' : 'app',
      );
      await assert.rejects(
        () => fixture.broker.execute(contract.name, contract.args),
        contract.error,
      );
      assert.equal(fixture.approvals.length, 0);
      assert.equal(fixture.requests.length, 0);
    });
  }
});

test('agent config fails fast unless Approval detail/create grants use user identity', async (t) => {
  for (const name of [
    'approval.instance.detail',
    'approval.instance.create',
  ] as const) {
    await t.test(`${name} rejects app identity`, async () => {
      await assert.rejects(
        () => loadAgentDefinition(
          `test-${name}.yaml`,
          resolve(process.cwd()),
          resolve(process.cwd(), 'data'),
          agentSource(name, 'app'),
        ),
        new RegExp(`${name.replaceAll('.', '\\.')} requires identity=user`),
      );
    });

    await t.test(`${name} accepts user identity`, async () => {
      const agent = await loadAgentDefinition(
        `test-${name}.yaml`,
        resolve(process.cwd()),
        resolve(process.cwd(), 'data'),
        agentSource(name, 'user'),
      );
      assert.equal(
        agent?.tools.grants.find((grant) => grant.name === name)?.identity,
        'user',
      );
    });
  }
});

test('typed write grants cannot be downgraded to read or weaker approval', async (t) => {
  for (const contract of [
    {
      name: 'base.records.create' as const,
      grant: { effect: 'read', approval: 'never' },
      error: /cannot downgrade base\.records\.create below write/,
    },
    {
      name: 'base.records.delete' as const,
      grant: { effect: 'write', approval: 'requester' },
      error: /cannot downgrade base\.records\.delete below high-risk-write/,
    },
  ]) {
    await t.test(contract.name, async () => {
      await assert.rejects(
        () => loadAgentDefinition(
          `test-${contract.name}.yaml`,
          resolve(process.cwd()),
          resolve(process.cwd(), 'data'),
          {
            id: `contract-${contract.name.replaceAll('.', '-')}`,
            systemPromptFile: 'prompts/general.md',
            provider: 'host-broker',
            model: 'test-model',
            workspace: { mode: 'none' },
            tools: {
              feishu: [contract.name],
              workspace: [],
              grants: [{ name: contract.name, identity: 'app', ...contract.grant }],
            },
            larkCli: { enabled: false },
          },
        ),
        contract.error,
      );
    });
  }
});

function agentSource(
  name: 'approval.instance.detail' | 'approval.instance.create',
  identity: ToolIdentity,
): Record<string, unknown> {
  return {
    id: `contract-${name.replaceAll('.', '-')}`,
    systemPromptFile: 'prompts/general.md',
    provider: 'host-broker',
    model: 'test-model',
    workspace: { mode: 'none' },
    tools: {
      feishu: [name],
      workspace: [],
      defaultIdentity: 'app',
      grants: [{ name, identity }],
    },
    larkCli: { enabled: false },
  };
}

function nestedProperty(name: FeishuToolName, property: string): unknown {
  const schema = toolCatalogEntry(name).parameters as {
    properties?: Record<string, unknown>;
  };
  return schema.properties?.[property];
}

function requiredProperties(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const required = (schema as { required?: unknown }).required;
  return Array.isArray(required)
    ? required.filter((value): value is string => typeof value === 'string')
    : [];
}

function schemaDeclaresProperty(schema: unknown, property: string): boolean {
  if (!schema || typeof schema !== 'object') return false;
  if (Array.isArray(schema)) {
    return schema.some((value) => schemaDeclaresProperty(value, property));
  }
  const record = schema as Record<string, unknown>;
  if (
    record.properties &&
    typeof record.properties === 'object' &&
    !Array.isArray(record.properties) &&
    Object.hasOwn(record.properties, property)
  ) {
    return true;
  }
  return Object.values(record).some((value) =>
    schemaDeclaresProperty(value, property)
  );
}
