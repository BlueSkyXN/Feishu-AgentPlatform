import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import type { LoadedBindingConfig } from '../src/config/types.js';
import { loadAgentDefinition } from '../src/config/load-platform.js';
import {
  assertLarkCliTurnScope,
  assertReadOnlyLarkCommand,
  classifyLarkCliCommandEffect,
  ensureLarkCliProfile,
  readLarkCliSkill,
  runLarkCliOperation,
} from '../src/tools/lark-cli.js';

function config(
  overrides: Partial<LoadedBindingConfig['agent']['larkCli']> = {},
  root = join(tmpdir(), 'feishu-agent-platform-lark-cli-test'),
  allowCrossChatRead = false,
): LoadedBindingConfig {
  return {
    appKey: 'primary',
    agentId: 'office',
    appId: 'cli_test_app_id',
    appSecret: 'test-app-secret-value',
    feishu: { domain: 'feishu' },
    agent: {
      sessionRoot: root,
      allowCrossChatRead,
      larkCli: {
        enabled: true,
        executable: 'lark-cli',
        expectedVersion: '1.0.79',
        root,
        timeoutMs: 30_000,
        operations: [],
        skills: [],
        ...overrides,
      },
    },
  } as LoadedBindingConfig;
}

test('structured lark-cli operations initialize one App profile and keep identity Host-owned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lark-cli-operation-'));
  const executable = join(root, 'fake-lark-cli');
  await writeFile(
    executable,
    `#!/usr/bin/env node\n` +
      `const fs = require('node:fs');\n` +
      `const path = require('node:path');\n` +
      `const argv = process.argv.slice(2);\n` +
      `if (argv[0] === '--version') { process.stdout.write('lark-cli version 1.0.79\\n'); process.exit(0); }\n` +
      `if (argv.includes('--help')) { const command = argv.slice(0, 2).join(' '); const risk = command === 'base +record-delete' ? 'high-risk-write' : 'write'; process.stdout.write('Risk: ' + risk + '\\n'); process.exit(0); }\n` +
      `let stdin = '';\n` +
      `process.stdin.setEncoding('utf8');\n` +
      `process.stdin.on('data', (chunk) => { stdin += chunk; });\n` +
      `process.stdin.on('end', () => {\n` +
      `  const contentArg = argv.find((value) => value.startsWith('--content=@'));\n` +
      `  const record = { argv, stdinMatches: stdin === 'test-app-secret-value\\n', credentialEnv: Object.keys(process.env).filter((name) => /LARK_APP|FEISHU_APP|SECRET|TOKEN/.test(name)), content: contentArg ? fs.readFileSync(path.resolve(process.env.HOME, contentArg.slice('--content=@'.length)), 'utf8') : undefined };\n` +
      `  fs.appendFileSync(path.join(process.env.HOME, 'invocations.jsonl'), JSON.stringify(record) + '\\n');\n` +
      `  if (argv[0] === 'skills') process.stdout.write('# Runtime Skill\\n');\n` +
      `  else process.stdout.write(JSON.stringify({ ok: true, access_token: 'must-not-leak', argv }));\n` +
      `});\n`,
    'utf8',
  );
  await chmod(executable, 0o700);

  const operations = [
    {
      id: 'create-document',
      command: ['docs', '+create'],
      allowedFlags: {
        '--title': { type: 'string', required: true },
        '--content': { type: 'content-file', required: true, maxBytes: 10_000 },
        '--page-size': { type: 'integer', minimum: 1, maximum: 50 },
      },
      requiredFlags: ['--title', '--content'],
      identity: 'bot',
      effect: 'write',
      approval: 'requester',
    },
    {
      id: 'delete-record',
      command: ['base', '+record-delete'],
      allowedFlags: { '--record-id': { type: 'string', required: true } },
      requiredFlags: ['--record-id'],
      identity: 'bot',
      effect: 'high-risk-write',
      approval: 'admin',
    },
  ] as LoadedBindingConfig['agent']['larkCli']['operations'];
  const configured = config({
    executable,
    root,
    operations,
    skills: ['lark-shared', 'lark-doc'],
  }, root);
  const scope = {
    chatId: 'oc_current',
    chatType: 'group',
    senderId: 'ou_current',
    messageId: 'om_current',
  };

  try {
    const [left, right] = await Promise.all([
      ensureLarkCliProfile(configured),
      ensureLarkCliProfile(configured),
    ]);
    assert.equal(left.home, join(root, 'primary'));
    assert.equal(right.home, left.home);

    const created = await runLarkCliOperation(
      configured,
      'create-document',
      { title: '测试文档', content: '受控正文', page_size: 50 },
      scope,
      true,
    );
    assert.equal((created.parsed as { access_token: string }).access_token, '[REDACTED]');
    await runLarkCliOperation(
      configured,
      'create-document',
      { title: '最小分页', content: '正文', page_size: 1 },
      scope,
      true,
    );
    await assert.rejects(
      () => runLarkCliOperation(
        configured,
        'create-document',
        { title: '测试文档', content: '正文', page_size: 0 },
        scope,
        true,
      ),
      /at least 1/,
    );
    await assert.rejects(
      () => runLarkCliOperation(
        configured,
        'create-document',
        { title: '测试文档', content: '正文', page_size: 51 },
        scope,
        true,
      ),
      /at most 50/,
    );
    await assert.rejects(
      () => runLarkCliOperation(
        configured,
        'create-document',
        { title: '测试文档', content: '正文', as: 'user' },
        scope,
        true,
      ),
      /not allowed|Host-managed/,
    );
    await runLarkCliOperation(
      configured,
      'delete-record',
      { record_id: 'rec_test' },
      scope,
      true,
    );
    const skill = await readLarkCliSkill(configured, 'lark-doc', undefined);
    assert.equal(skill.content, '# Runtime Skill\n');

    const records = (await readFile(join(root, 'primary', 'invocations.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as {
        argv: string[];
        stdinMatches: boolean;
        credentialEnv: string[];
        content?: string;
      });
    assert.equal(records.filter((record) => record.argv.slice(0, 2).join(' ') === 'config init').length, 1);
    assert.ok(records.every((record) => record.credentialEnv.length === 0));
    assert.equal(records.find((record) => record.argv.slice(0, 2).join(' ') === 'config init')?.stdinMatches, true);
    const createCall = records.find((record) => record.argv.slice(0, 2).join(' ') === 'docs +create');
    assert.equal(createCall?.content, '受控正文');
    assert.equal(createCall?.argv.includes('--as=bot'), true);
    assert.equal(createCall?.argv.includes('--yes'), false);
    const deleteCall = records.find((record) => record.argv.slice(0, 2).join(' ') === 'base +record-delete');
    assert.equal(deleteCall?.argv.includes('--as=bot'), true);
    assert.equal(deleteCall?.argv.includes('--yes'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lark-cli profile rejects an executable with a mismatched expectedVersion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lark-cli-version-mismatch-'));
  const executable = join(root, 'fake-lark-cli');
  await writeFile(
    executable,
    '#!/usr/bin/env node\nprocess.stdout.write("lark-cli version 1.0.78\\n");\n',
    'utf8',
  );
  await chmod(executable, 0o700);

  try {
    await assert.rejects(
      () => ensureLarkCliProfile(config({
        executable,
        expectedVersion: '1.0.79',
        root,
      }, root)),
      /version mismatch: expected 1\.0\.79, received 1\.0\.78/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lark-cli profile rejects a grant that downgrades the pinned CLI command risk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lark-cli-risk-mismatch-'));
  const executable = join(root, 'fake-lark-cli');
  await writeFile(
    executable,
    '#!/usr/bin/env node\n' +
      'const argv = process.argv.slice(2);\n' +
      "if (argv[0] === '--version') process.stdout.write('lark-cli version 1.0.79\\n');\n" +
      "else if (argv.includes('--help')) process.stdout.write('Risk: write\\n');\n" +
      "else process.stdout.write('{}\\n');\n",
    'utf8',
  );
  await chmod(executable, 0o700);
  const operation = {
    id: 'calendar-rsvp',
    command: ['calendar', '+rsvp'],
    allowedFlags: {},
    requiredFlags: [],
    identity: 'bot',
    effect: 'read',
    approval: 'never',
  } as LoadedBindingConfig['agent']['larkCli']['operations'][number];

  try {
    await assert.rejects(
      () => ensureLarkCliProfile(config({
        executable,
        root,
        operations: [operation],
      }, root)),
      /effect mismatch: configured read, CLI reports write/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shared App profile still validates every Agent operation grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lark-cli-shared-profile-risk-'));
  const executable = join(root, 'fake-lark-cli');
  await writeFile(
    executable,
    '#!/usr/bin/env node\n' +
      'const argv = process.argv.slice(2);\n' +
      "if (argv[0] === '--version') process.stdout.write('lark-cli version 1.0.79\\n');\n" +
      "else if (argv.includes('--help')) process.stdout.write('Risk: write\\n');\n" +
      "else process.stdout.write('{}\\n');\n",
    'utf8',
  );
  await chmod(executable, 0o700);
  const writeOperation = {
    id: 'calendar-rsvp-write',
    command: ['calendar', '+shared-profile-rsvp'],
    allowedFlags: {},
    requiredFlags: [],
    identity: 'bot',
    effect: 'write',
    approval: 'requester',
  } as LoadedBindingConfig['agent']['larkCli']['operations'][number];
  const downgradedOperation = {
    ...writeOperation,
    id: 'calendar-rsvp-read',
    effect: 'read',
    approval: 'never',
  } as LoadedBindingConfig['agent']['larkCli']['operations'][number];

  try {
    await ensureLarkCliProfile(config({
      executable,
      root,
      operations: [writeOperation],
    }, root));
    await assert.rejects(
      () => ensureLarkCliProfile(config({
        executable,
        root,
        operations: [downgradedOperation],
      }, root)),
      /effect mismatch: configured read, CLI reports write/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('agent config explicitly rejects legacy larkCli.allowedCommands', async () => {
  const projectRoot = resolve(process.cwd());
  await assert.rejects(
    () => loadAgentDefinition(
      'legacy-lark-cli-agent.yaml',
      projectRoot,
      resolve(projectRoot, 'data'),
      {
        id: 'legacy-lark-cli-agent',
        systemPromptFile: 'prompts/general.md',
        provider: 'host-broker',
        model: 'test-model',
        workspace: { mode: 'none' },
        tools: { feishu: [], workspace: [] },
        larkCli: {
          enabled: false,
          allowedCommands: ['docs +fetch'],
        },
      },
    ),
    /larkCli\.allowedCommands is no longer supported/,
  );
});

test('lark-cli command semantics cannot downgrade mutations to reads', () => {
  assert.equal(classifyLarkCliCommandEffect('docs +fetch'), 'read');
  assert.equal(classifyLarkCliCommandEffect('docs +create'), 'write');
  assert.equal(classifyLarkCliCommandEffect('base +record-delete'), 'high-risk-write');
  assert.doesNotThrow(() => assertReadOnlyLarkCommand('calendar +agenda'));
  assert.throws(() => assertReadOnlyLarkCommand('docs +create'), /must be read-only/);
  assert.throws(() => classifyLarkCliCommandEffect('auth login'), /prohibited/);
});

test('lark-cli IM operations stay within the current chat unless explicitly enabled', () => {
  const scope = {
    chatId: 'oc_current',
    chatType: 'group',
    senderId: 'ou_current',
    messageId: 'om_current',
    threadId: 'omt_current',
  };
  assert.doesNotThrow(() =>
    assertLarkCliTurnScope(
      config(),
      'im +chat-messages-list',
      ['--chat-id=oc_current'],
      scope,
    ),
  );
  assert.throws(
    () => assertLarkCliTurnScope(
      config(),
      'im +chat-messages-list',
      ['--chat-id=oc_other'],
      scope,
    ),
    /another chat/,
  );
  assert.throws(
    () => assertLarkCliTurnScope(config(), 'im +chat-list', [], scope),
    /allowCrossChatRead/,
  );
  assert.doesNotThrow(() =>
    assertLarkCliTurnScope(config({}, undefined, true), 'im +chat-list', [], scope),
  );
});
