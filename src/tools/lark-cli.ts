import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type {
  LarkCliFlagRule,
  LarkCliOperationGrant,
  LoadedBindingConfig,
  ToolEffect,
} from '../config/types.js';

export interface LarkCliResult {
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  parsed?: unknown;
}

export interface LarkCliTurnScope {
  chatId: string;
  chatType?: string;
  senderId: string;
  messageId: string;
  threadId?: string;
  rootId?: string;
}

const MAX_OUTPUT_BYTES = 1_000_000;
const PROFILE_CACHE_TTL_MS = 60_000;
const profileInitializations = new Map<string, {
  promise: Promise<LarkCliProfileStatus>;
  expiresAt: number;
}>();
const commandRiskChecks = new Map<string, Promise<ToolEffect>>();
const PROHIBITED_FLAGS = new Set([
  '--app-id',
  '--client-id',
  '--app-secret',
  '--client-secret',
  '--access-token',
  '--tenant-access-token',
  '--user-access-token',
  '--refresh-token',
  '--token',
  '--password',
  '--secret',
  '--credential',
  '--credentials',
  '--config',
  '--profile',
  '--as',
  '--identity',
  '--user',
  '--tenant',
  '--domain',
  '--scope',
  '--recommend',
  '--device-code',
  '--no-wait',
  '--risk-control',
  '--force',
  '--yes',
  '--method',
  '--http-method',
  '--data',
  '--body',
  '--payload',
  '--file',
  '--input',
  '--download-resources',
  '--output',
  '--output-file',
  '--directory',
  '--cwd',
  '--url',
  '--endpoint',
  '--execute',
  '--command',
  '--shell',
]);

export interface LarkCliProfileStatus {
  appKey: string;
  home: string;
  expectedVersion: string;
  actualVersion: string;
  initialized: true;
}

const UNSAFE_COMMAND_TOKENS = new Set([
  'api',
  'openapi',
  'request',
  'raw',
  'http',
  'curl',
  'auth',
  'login',
  'logout',
  'token',
  'config',
  'profile',
  'consume',
]);

const WRITE_TOKENS = new Set([
  'accept',
  'add',
  'append',
  'apply',
  'approve',
  'archive',
  'assign',
  'bind',
  'cancel',
  'close',
  'complete',
  'copy',
  'create',
  'decline',
  'delete',
  'duplicate',
  'edit',
  'execute',
  'forward',
  'grant',
  'import',
  'insert',
  'invite',
  'leave',
  'mark',
  'merge',
  'move',
  'overwrite',
  'patch',
  'pin',
  'publish',
  'reject',
  'remove',
  'rename',
  'replace',
  'reply',
  'restore',
  'revoke',
  'run',
  'send',
  'set',
  'share',
  'star',
  'start',
  'stop',
  'submit',
  'subscribe',
  'transfer',
  'trigger',
  'unarchive',
  'unbind',
  'unpin',
  'unstar',
  'update',
  'upload',
  'watch',
  'write',
]);

const HIGH_RISK_TOKENS = new Set([
  'delete',
  'overwrite',
  'remove',
  'revoke',
  'transfer',
]);

/** Rejects commands whose fixed subcommand contains a generic, credential, or mutation verb. */
export function assertReadOnlyLarkCommand(command: string): void {
  const effect = classifyLarkCliCommandEffect(command);
  if (effect !== 'read') {
    const mutation = commandSemanticTokens(command).find((token) => WRITE_TOKENS.has(token));
    throw new Error(
      `lark-cli command must be read-only; mutation token "${mutation ?? 'unknown'}" is prohibited: ${command}`,
    );
  }
}

export function classifyLarkCliCommandEffect(command: string):
  | 'read'
  | 'write'
  | 'high-risk-write' {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error('lark-cli command is empty.');

  const semanticTokens = parts.flatMap(commandSemanticTokens);
  const unsafe = semanticTokens.find((token) => UNSAFE_COMMAND_TOKENS.has(token));
  if (unsafe) {
    throw new Error(
      `lark-cli generic or credential-bearing command token "${unsafe}" is prohibited: ${command}`,
    );
  }
  if (semanticTokens.some((token) => HIGH_RISK_TOKENS.has(token))) {
    return 'high-risk-write';
  }
  return semanticTokens.some((token) => WRITE_TOKENS.has(token)) ? 'write' : 'read';
}

export async function ensureLarkCliProfile(
  config: LoadedBindingConfig,
  signal?: AbortSignal,
): Promise<LarkCliProfileStatus> {
  if (!config.agent.larkCli.enabled) {
    throw new Error('lark-cli is disabled for this Agent definition.');
  }
  const home = larkCliHome(config);
  const fingerprint = profileFingerprint(config);
  const key = `${home}\u0000${fingerprint}`;
  const existing = profileInitializations.get(key);
  if (existing && existing.expiresAt > Date.now()) {
    const profile = await existing.promise;
    await validateConfiguredOperationRisks(config, profile, signal);
    return profile;
  }
  if (existing) profileInitializations.delete(key);
  const initialization = initializeProfile(config, home, fingerprint, signal).catch(
    (error) => {
      profileInitializations.delete(key);
      throw error;
    },
  );
  profileInitializations.set(key, {
    promise: initialization,
    expiresAt: Date.now() + PROFILE_CACHE_TTL_MS,
  });
  const profile = await initialization;
  await validateConfiguredOperationRisks(config, profile, signal);
  return profile;
}

export async function runLarkCliOperation(
  config: LoadedBindingConfig,
  operationId: string,
  rawParameters: unknown,
  scope: LarkCliTurnScope,
  approved: boolean,
  signal?: AbortSignal,
): Promise<LarkCliResult> {
  const operation = config.agent.larkCli.operations.find(
    (candidate) => candidate.id === operationId,
  );
  if (!operation) {
    throw new Error(`lark-cli operation is not allowed by the Agent definition: ${operationId}`);
  }
  if (operation.effect !== 'read' && !approved) {
    throw new Error(`lark-cli operation ${operationId} requires Host approval.`);
  }
  const profile = await ensureLarkCliProfile(config, signal);
  const requestRoot = join(profile.home, 'tmp', 'requests', randomUUID());
  await mkdir(requestRoot, { recursive: true, mode: 0o700 });
  try {
    const rendered = await renderOperationArguments(
      operation,
      rawParameters,
      requestRoot,
      profile.home,
    );
    const scopedArguments = rendered.filter((argument) => !argument.startsWith('--as='));
    assertLarkCliTurnScope(
      config,
      operation.command.join(' '),
      scopedArguments,
      scope,
    );
    const argv = [
      ...operation.command,
      ...rendered,
      '--as=bot',
      '--format=json',
      ...(operation.effect === 'high-risk-write' ? ['--yes'] : []),
    ];
    const result = await runCliProcess(
      config,
      argv,
      profile.home,
      undefined,
      signal,
    );
    return {
      ...result,
      command: [
        config.agent.larkCli.executable,
        ...operation.command,
        ...(rendered.length > 0 ? [`[${rendered.length} parameter(s) omitted]`] : []),
      ],
    };
  } finally {
    await rm(requestRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function readLarkCliSkill(
  config: LoadedBindingConfig,
  skill: string,
  path: string | undefined,
  signal?: AbortSignal,
): Promise<{ skill: string; path?: string; content: string; version: string }> {
  if (!config.agent.larkCli.skills.includes(skill)) {
    throw new Error(`lark-cli skill is not selected by this Agent definition: ${skill}`);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(skill)) {
    throw new Error('Invalid lark-cli skill name.');
  }
  if (
    path !== undefined &&
    (!/^[A-Za-z0-9._/-]{1,512}$/u.test(path) ||
      path.startsWith('/') ||
      path.split('/').includes('..'))
  ) {
    throw new Error('Invalid lark-cli skill path.');
  }
  const profile = await ensureLarkCliProfile(config, signal);
  const result = await runCliProcess(
    config,
    ['skills', 'read', skill, ...(path ? [path] : [])],
    profile.home,
    undefined,
    signal,
  );
  return {
    skill,
    ...(path ? { path } : {}),
    content: result.stdout,
    version: profile.actualVersion,
  };
}

async function initializeProfile(
  config: LoadedBindingConfig,
  home: string,
  fingerprint: string,
  signal?: AbortSignal,
): Promise<LarkCliProfileStatus> {
  const directories = profileDirectories(home);
  await Promise.all(Object.values(directories).map(ensurePrivateDirectory));
  const versionResult = await runCliProcess(
    config,
    ['--version'],
    home,
    undefined,
    signal,
  );
  const actualVersion = parseCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (actualVersion !== config.agent.larkCli.expectedVersion) {
    throw new Error(
      `lark-cli version mismatch: expected ${config.agent.larkCli.expectedVersion}, received ${actualVersion}.`,
    );
  }

  const markerPath = join(home, '.platform-profile.json');
  const marker = await readFile(markerPath, 'utf8')
    .then((value) => JSON.parse(value) as { fingerprint?: unknown; version?: unknown })
    .catch(() => undefined);
  if (marker?.fingerprint !== fingerprint || marker.version !== actualVersion) {
    await runCliProcess(
      config,
      [
        'config',
        'init',
        '--app-id',
        config.appId,
        '--app-secret-stdin',
        '--brand',
        config.feishu.domain === 'lark' ? 'lark' : 'feishu',
      ],
      home,
      `${config.appSecret}\n`,
      signal,
    );
    await writeFile(
      markerPath,
      `${JSON.stringify({ fingerprint, version: actualVersion, initializedAt: Date.now() })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  }
  await runCliProcess(config, ['config', 'strict-mode', 'bot'], home, undefined, signal);
  await runCliProcess(config, ['config', 'default-as', 'bot'], home, undefined, signal);
  await chmod(markerPath, 0o600);
  return {
    appKey: config.appKey,
    home,
    expectedVersion: config.agent.larkCli.expectedVersion,
    actualVersion,
    initialized: true,
  };
}

async function validateConfiguredOperationRisks(
  config: LoadedBindingConfig,
  profile: LarkCliProfileStatus,
  signal?: AbortSignal,
): Promise<void> {
  for (const operation of config.agent.larkCli.operations) {
    const command = operation.command.join(' ');
    const key = [
      config.agent.larkCli.executable,
      profile.actualVersion,
      command,
    ].join('\u0000');
    let check = commandRiskChecks.get(key);
    if (!check) {
      check = runCliProcess(
        config,
        [...operation.command, '--help'],
        profile.home,
        undefined,
        signal,
      ).then((help) => parseCliCommandEffect(
        `${help.stdout}\n${help.stderr}`,
        command,
      ));
      commandRiskChecks.set(key, check);
      void check.catch(() => {
        if (commandRiskChecks.get(key) === check) commandRiskChecks.delete(key);
      });
    }
    const actualEffect = await check;
    if (operation.effect !== actualEffect) {
      throw new Error(
        `lark-cli operation ${operation.id} effect mismatch: configured ${operation.effect}, CLI reports ${actualEffect}.`,
      );
    }
  }
}

async function renderOperationArguments(
  operation: LarkCliOperationGrant,
  rawParameters: unknown,
  requestRoot: string,
  home: string,
): Promise<string[]> {
  const parameters = objectParameters(rawParameters);
  const normalized = new Map<string, unknown>();
  for (const [name, value] of Object.entries(parameters)) {
    const flag = name.startsWith('--') ? name : `--${name.replaceAll('_', '-')}`;
    if (normalized.has(flag)) throw new Error(`Duplicate lark-cli parameter: ${flag}`);
    normalized.set(flag, value);
  }
  for (const flag of operation.requiredFlags) {
    if (!normalized.has(flag)) throw new Error(`Missing required lark-cli parameter: ${flag}`);
  }
  const output: string[] = [];
  for (const [flag, value] of normalized.entries()) {
    const rule = operation.allowedFlags[flag];
    if (!rule) throw new Error(`lark-cli parameter is not allowed for ${operation.id}: ${flag}`);
    if (PROHIBITED_FLAGS.has(flag) || ['--as', '--yes', '--format', '--dry-run'].includes(flag)) {
      throw new Error(`lark-cli parameter is Host-managed: ${flag}`);
    }
    output.push(...await renderFlag(flag, value, rule, requestRoot, home));
  }
  return output;
}

async function renderFlag(
  flag: string,
  value: unknown,
  rule: LarkCliFlagRule,
  requestRoot: string,
  home: string,
): Promise<string[]> {
  if (rule.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${flag} must be a boolean.`);
    return value ? [flag] : [];
  }
  if (rule.type === 'integer') {
    if (!Number.isSafeInteger(value)) throw new Error(`${flag} must be a safe integer.`);
    if (rule.minimum !== undefined && (value as number) < rule.minimum) {
      throw new Error(`${flag} must be at least ${rule.minimum}.`);
    }
    if (rule.maximum !== undefined && (value as number) > rule.maximum) {
      throw new Error(`${flag} must be at most ${rule.maximum}.`);
    }
    return [`${flag}=${String(value)}`];
  }
  if (rule.type === 'string-array') {
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      throw new Error(`${flag} must be a string array.`);
    }
    if (!rule.repeatable && value.length > 1) {
      throw new Error(`${flag} does not allow repeated values.`);
    }
    return value.map((item) => `${flag}=${validateFlagString(flag, item, rule)}`);
  }
  if (rule.type === 'json') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error(`${flag} must be JSON serializable.`);
    return [`${flag}=${validateFlagString(flag, serialized, rule)}`];
  }
  if (rule.type === 'content-file') {
    if (typeof value !== 'string') throw new Error(`${flag} must be a string.`);
    validateFlagString(flag, value, rule);
    const path = join(requestRoot, `${flag.slice(2)}.txt`);
    await writeFile(path, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const relativePath = relative(home, path).replaceAll('\\', '/');
    if (relativePath.startsWith('../')) throw new Error('lark-cli content file escaped its profile.');
    return [`${flag}=@${relativePath}`];
  }
  if (typeof value !== 'string') throw new Error(`${flag} must be a string.`);
  return [`${flag}=${validateFlagString(flag, value, rule)}`];
}

function validateFlagString(flag: string, value: string, rule: LarkCliFlagRule): string {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (value.includes('\u0000') || bytes > (rule.maxBytes ?? 4096)) {
    throw new Error(`${flag} exceeds its configured value boundary.`);
  }
  if (rule.pattern && !new RegExp(rule.pattern, 'u').test(value)) {
    throw new Error(`${flag} does not match its configured pattern.`);
  }
  if (rule.choices && !rule.choices.includes(value)) {
    throw new Error(`${flag} must be one of: ${rule.choices.join(', ')}.`);
  }
  return value;
}

function objectParameters(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('lark-cli parameters must be an object.');
  }
  return value as Record<string, unknown>;
}

async function runCliProcess(
  config: LoadedBindingConfig,
  argv: string[],
  home: string,
  stdin: string | undefined,
  signal?: AbortSignal,
): Promise<LarkCliResult> {
  const directories = profileDirectories(home);
  return await new Promise<LarkCliResult>((resolve, reject) => {
    const child = spawn(config.agent.larkCli.executable, argv, {
      shell: false,
      cwd: home,
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: larkCliEnvironment(config, directories),
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    const terminate = (): void => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    };
    const finish = (error?: Error, exitCode = -1): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else {
        let safeStdout = redactCliOutput(stdout, config);
        const safeStderr = redactCliOutput(stderr, config);
        let parsed: unknown;
        try { parsed = JSON.parse(safeStdout) as unknown; } catch { parsed = undefined; }
        if (parsed !== undefined) {
          parsed = redactSensitiveJson(parsed);
          safeStdout = JSON.stringify(parsed);
        }
        resolve({
          command: [config.agent.larkCli.executable, ...argv.slice(0, 2)],
          exitCode,
          stdout: safeStdout,
          stderr: safeStderr,
          ...(parsed !== undefined ? { parsed } : {}),
        });
      }
    };
    const abort = (): void => {
      terminate();
      finish(abortError('lark-cli execution aborted.'));
    };
    const timer = setTimeout(() => {
      terminate();
      finish(new Error(`lark-cli timed out after ${config.agent.larkCli.timeoutMs} ms.`));
    }, config.agent.larkCli.timeoutMs);
    timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) {
        terminate();
        finish(new Error(`lark-cli output exceeded the ${MAX_OUTPUT_BYTES}-byte limit.`));
      } else stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) {
        terminate();
        finish(new Error(`lark-cli output exceeded the ${MAX_OUTPUT_BYTES}-byte limit.`));
      } else stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        finish(new Error(
          `lark-cli exited with code ${exitCode}: ${redactCliOutput(stderr, config).slice(0, 4000)}`,
        ), exitCode);
      } else finish(undefined, exitCode);
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

function larkCliHome(config: LoadedBindingConfig): string {
  return join(config.agent.larkCli.root, config.appKey);
}

function profileDirectories(home: string): {
  home: string;
  config: string;
  cache: string;
  temp: string;
} {
  return {
    home,
    config: join(home, 'config'),
    cache: join(home, 'cache'),
    temp: join(home, 'tmp'),
  };
}

function profileFingerprint(config: LoadedBindingConfig): string {
  return createHash('sha256')
    .update(config.appKey)
    .update('\u0000')
    .update(config.appId)
    .update('\u0000')
    .update(config.appSecret)
    .update('\u0000')
    .update(config.feishu.domain)
    .update('\u0000')
    .update(config.agent.larkCli.expectedVersion)
    .update('\u0000')
    .update(config.agent.larkCli.executable)
    .digest('hex');
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`lark-cli profile path is not a private directory: ${path}`);
  }
  await chmod(path, 0o700);
}

function parseCliVersion(value: string): string {
  const match = /(?:lark-cli\s+version\s+)?(\d+\.\d+\.\d+)/iu.exec(value);
  if (!match?.[1]) throw new Error('Unable to determine lark-cli version.');
  return match[1];
}

function parseCliCommandEffect(value: string, command: string): ToolEffect {
  const match = /^Risk:\s*(read|write|high-risk-write)\s*$/imu.exec(value);
  if (!match?.[1]) {
    throw new Error(`Unable to determine lark-cli command risk: ${command}`);
  }
  return match[1] as ToolEffect;
}

export function assertLarkCliTurnScope(
  config: LoadedBindingConfig,
  command: string,
  extraArgs: string[],
  scope: LarkCliTurnScope,
): void {
  if (config.agent.allowCrossChatRead) return;
  const normalized = command.trim().replace(/\s+/gu, ' ');
  if (!normalized.startsWith('im ')) return;

  if (normalized === 'im +chat-messages-list') {
    const chatIds = flagValues(extraArgs, '--chat-id');
    const userIds = flagValues(extraArgs, '--user-id');
    if (chatIds.length + userIds.length === 0) {
      throw new Error('Current-chat lark-cli access requires --chat-id or --user-id.');
    }
    if (chatIds.some((value) => value !== scope.chatId)) {
      throw new Error('lark-cli cannot read another chat for this Agent definition.');
    }
    if (userIds.length > 0 && !isDirectChat(scope.chatType)) {
      throw new Error('lark-cli --user-id is only allowed for the current direct chat.');
    }
    if (userIds.some((value) => value !== scope.senderId)) {
      throw new Error('lark-cli cannot resolve another user conversation for this turn.');
    }
    return;
  }

  if (normalized === 'im +threads-messages-list') {
    const threads = flagValues(extraArgs, '--thread');
    const allowed = new Set(
      [scope.threadId, scope.rootId, scope.messageId].filter(
        (value): value is string => Boolean(value),
      ),
    );
    if (threads.length === 0 || threads.some((value) => !allowed.has(value))) {
      throw new Error('lark-cli thread access must stay inside the current turn.');
    }
    return;
  }

  if (normalized === 'im +messages-mget') {
    const batches = flagValues(extraArgs, '--message-ids');
    const allowed = new Set(
      [scope.messageId, scope.rootId].filter(
        (value): value is string => Boolean(value),
      ),
    );
    const messageIds = batches.flatMap((value) => value.split(',').filter(Boolean));
    if (messageIds.length === 0 || messageIds.some((value) => !allowed.has(value))) {
      throw new Error('lark-cli message access must stay inside the current turn.');
    }
    return;
  }

  throw new Error(
    `lark-cli IM command requires allowCrossChatRead=true: ${normalized}`,
  );
}

function commandSemanticTokens(part: string): string[] {
  return part
    .toLowerCase()
    .replace(/^\++/u, '')
    .split(/[-_.:/+]+/u)
    .map((token) => token.replace(/^\++/u, ''))
    .filter(Boolean);
}

function flagValues(argumentsValue: string[], flag: string): string[] {
  const prefix = `${flag}=`;
  return argumentsValue
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length));
}

function isDirectChat(value: string | undefined): boolean {
  return ['p2p', 'private', 'direct', 'dm'].includes(value?.toLowerCase() ?? '');
}

function redactCliOutput(value: string, config: LoadedBindingConfig): string {
  let result = value;
  const sensitiveValues = [config.appSecret, config.appId]
    .map((entry) => entry?.trim())
    .filter((entry): entry is string => Boolean(entry));
  for (const sensitiveValue of sensitiveValues) {
    result = result.split(sensitiveValue).join('[REDACTED]');
  }
  result = result.replace(
    /((?:tenant_|user_)?access_token|refresh_token|app_secret|client_secret|authorization|password)(["']?\s*[:=]\s*["']?)([^\s,"'}]+)/giu,
    '$1$2[REDACTED]',
  );
  return result;
}

function redactSensitiveJson(value: unknown, key = ''): unknown {
  if (SENSITIVE_OUTPUT_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactSensitiveJson(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, nested]) => [
      name,
      redactSensitiveJson(nested, name),
    ]),
  );
}

const SENSITIVE_OUTPUT_KEY = /^(?:(?:tenant|user)_)?access_token$|^refresh_token$|^(?:app|client)_secret$|^authorization$|^password$/iu;

function larkCliEnvironment(
  config: LoadedBindingConfig,
  directories: { home: string; config: string; cache: string; temp: string },
): NodeJS.ProcessEnv {
  const inheritedNames = [
    'PATH',
    'LANG',
    'LC_ALL',
    'TZ',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of inheritedNames) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.HOME = directories.home;
  env.USERPROFILE = directories.home;
  env.XDG_CONFIG_HOME = directories.config;
  env.XDG_CACHE_HOME = directories.cache;
  env.TMPDIR = directories.temp;
  env.TMP = directories.temp;
  env.TEMP = directories.temp;
  env.NO_COLOR = '1';
  return env;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
