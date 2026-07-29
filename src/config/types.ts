export const APP_VERSION = '0.1.0' as const;
export const DEFAULT_WORKSPACE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const DEFAULT_WORKSPACE_MAX_FILES = 10_000;

export const READ_ONLY_FEISHU_TOOL_NAMES = [
  'user.profile',
  'chat.info',
  'message.history',
  'doc.read',
  'base.records.list',
  'base.records.search',
  'calendar.events.list',
  'task.list',
  'approval.instance.get',
  'approval.instance.detail',
  'openapi.get',
  'larkcli.run',
  'larkcli.skill.read',
] as const;

export const WRITE_FEISHU_TOOL_NAMES = [
  'doc.create',
  'base.records.create',
  'base.records.update',
  'base.records.delete',
  'calendar.events.create',
  'calendar.events.update',
  'calendar.events.delete',
  'task.create',
  'task.update',
  'task.delete',
  'approval.instance.create',
] as const;

export const FEISHU_TOOL_NAMES = [
  ...READ_ONLY_FEISHU_TOOL_NAMES,
  ...WRITE_FEISHU_TOOL_NAMES,
] as const;

export type FeishuToolName = (typeof FEISHU_TOOL_NAMES)[number];
export type ToolEffect = 'read' | 'write' | 'high-risk-write';
export type ToolApproval = 'never' | 'requester' | 'admin';

export interface ToolGrant {
  name: FeishuToolName | WorkspaceToolName;
  identity: ToolIdentity;
  effect: ToolEffect;
  approval: ToolApproval;
}

export interface LarkCliFlagRule {
  type: 'string' | 'integer' | 'boolean' | 'string-array' | 'json' | 'content-file';
  required?: boolean;
  repeatable?: boolean;
  maxBytes?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  choices?: string[];
}

export interface LarkCliOperationGrant {
  id: string;
  command: string[];
  allowedFlags: Record<string, LarkCliFlagRule>;
  requiredFlags: string[];
  identity: 'bot';
  effect: ToolEffect;
  approval: ToolApproval;
}

export const WORKSPACE_TOOL_NAMES = [
  'workspace.list',
  'workspace.read',
  'workspace.search',
  'workspace.write',
] as const;

export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];

export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ConversationScope = 'chat' | 'thread';
export type DmMode = 'open' | 'allowlist' | 'pair' | 'disabled';
export type FeishuIngressTransport = 'websocket' | 'http' | 'disabled';
export type FeishuCallbackTransport = 'http' | 'disabled';
export type FeishuDomain = 'feishu' | 'lark';
export type ToolIdentity = 'app' | 'user';
export type RuntimeIsolation = 'process' | 'in-process';
export type WorkspaceMode = 'none' | 'read-only' | 'read-write';
export type ModelProviderPolicy = 'host-broker-only';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ModelApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai';

export interface ReadOnlyOpenApiRule {
  pathPrefix: string;
}

export interface FeishuChannelPolicy {
  requireMention: boolean;
  dmMode: DmMode;
  dmAllowlist: string[];
  groupAllowlist: string[];
  respondToMentionAll: boolean;
}

export interface AttachmentPolicy {
  enabled: boolean;
  maxItems: number;
  maxBytesPerItem: number;
  maxTotalBytes: number;
  passImagesToModel: boolean;
  persistFiles: boolean;
}

export interface IdentityPolicy {
  resolveUserProfile: boolean;
  profileCacheTtlSeconds: number;
}

export interface OAuthDefinition {
  enabled: boolean;
  publicBaseUrlEnv: string;
  redirectPath: string;
  scopes: string[];
  tokenRoot: string;
  stateRoot: string;
  stateTtlSeconds: number;
  encryptionKeyEnv: string;
}

/** A Feishu application identity and its single inbound channel lifecycle. */
export interface FeishuAppManifest {
  id: string;
  enabled: boolean;
  appIdEnv: string;
  appSecretEnv: string;
  domain: FeishuDomain;
  events: {
    transport: FeishuIngressTransport;
    path: string;
  };
  callbacks: {
    transport: FeishuCallbackTransport;
    path: string;
  };
  verificationTokenEnv?: string;
  encryptKeyEnv?: string;
  policy: FeishuChannelPolicy;
  attachments: AttachmentPolicy;
  identity: IdentityPolicy;
  oauth: OAuthDefinition;
}

export interface LoadedFeishuApp extends FeishuAppManifest {
  configFile: string;
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  oauthPublicBaseUrl?: string;
  oauthEncryptionKey?: string;
}

export interface AgentDefinitionManifest {
  id: string;
  enabled: boolean;
  systemPromptFile: string;
  provider: string;
  model: string;
  modelApi: ModelApi;
  upstreamPath: string;
  modelOptions: {
    reasoning: boolean;
    input: Array<'text' | 'image'>;
    contextWindow: number;
    maxTokens: number;
  };
  thinkingLevel: ThinkingLevel;
  runtime: {
    isolation: RuntimeIsolation;
    workerShutdownGraceSeconds: number;
  };
  workspace: {
    mode: WorkspaceMode;
    root: string;
    sessionRoot: string;
    maxReadBytes: number;
    maxWriteBytes: number;
    maxTotalBytes: number;
    maxFiles: number;
  };
  tools: {
    feishu: FeishuToolName[];
    workspace: WorkspaceToolName[];
    grants: ToolGrant[];
    defaultIdentity: ToolIdentity;
    allowCrossChatRead: boolean;
    openApiReadAllowlist: ReadOnlyOpenApiRule[];
  };
  skillPaths: string[];
  larkCli: {
    enabled: boolean;
    executable: string;
    expectedVersion: string;
    root: string;
    timeoutMs: number;
    operations: LarkCliOperationGrant[];
    skillsRoot?: string;
    skills: string[];
  };
}

export interface LoadedAgentDefinition extends AgentDefinitionManifest {
  configFile: string;
  systemPrompt: string;
}

export interface BindingRoute {
  default: boolean;
  priority: number;
  commandPrefixes: string[];
  chatAllowlist: string[];
  userAllowlist: string[];
  threadAllowlist: string[];
}

export interface ConversationPolicy {
  scope: ConversationScope;
  maxPendingTurns: number;
  idleTtlSeconds: number;
  turnTimeoutSeconds: number;
  toolTimeoutSeconds: number;
  queuedTurnTtlSeconds: number;
  maxResidentSessions: number;
  maxConcurrentTurns: number;
  recentHistory: {
    enabled: boolean;
    maxMessages: number;
    maxCharacters: number;
    currentThreadOnly: boolean;
  };
}

/** Explicit N:N edge between one Feishu app and one reusable Agent definition. */
export interface AppAgentBindingManifest {
  id: string;
  enabled: boolean;
  app: string;
  agent: string;
  route: BindingRoute;
  conversation: ConversationPolicy;
}

export interface LoadedAppAgentBinding extends AppAgentBindingManifest {
  configFile: string;
  appDefinition: LoadedFeishuApp;
  agentDefinition: LoadedAgentDefinition;
}

export interface PlatformConfig {
  apps: LoadedFeishuApp[];
  agents: LoadedAgentDefinition[];
  bindings: LoadedAppAgentBinding[];
}

/** Serializable configuration document used by the SQLite revision store. */
export interface PlatformConfigDocument {
  schemaVersion: 1;
  apps: FeishuAppManifest[];
  agents: AgentDefinitionManifest[];
  bindings: AppAgentBindingManifest[];
}

/**
 * A resolved binding view used by the runtime adapters. It deliberately keeps
 * App credentials separate from the Agent definition at rest; this projection
 * exists only after referential-integrity and routing validation succeeds.
 */
export interface LoadedBindingConfig {
  id: string;
  appKey: string;
  agentId: string;
  configFile: string;
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  oauthPublicBaseUrl?: string;
  oauthEncryptionKey?: string;
  systemPrompt: string;
  feishu: {
    domain: FeishuDomain;
    events: FeishuAppManifest['events'];
    callbacks: FeishuAppManifest['callbacks'];
    requireMention: boolean;
    dmMode: DmMode;
    dmAllowlist: string[];
    groupAllowlist: string[];
    respondToMentionAll: boolean;
    attachments: AttachmentPolicy;
  };
  conversation: ConversationPolicy;
  identity: IdentityPolicy;
  runtime: AgentDefinitionManifest['runtime'];
  sandbox: {
    mode: WorkspaceMode;
    maxReadBytes: number;
    maxWriteBytes: number;
    maxTotalBytes: number;
    maxFiles: number;
  };
  agent: {
    systemPromptFile: string;
    provider: string;
    model: string;
    modelApi: ModelApi;
    upstreamPath: string;
    modelOptions: AgentDefinitionManifest['modelOptions'];
    thinkingLevel: ThinkingLevel;
    feishuTools: FeishuToolName[];
    workspaceTools: WorkspaceToolName[];
    toolGrants: ToolGrant[];
    defaultToolIdentity: ToolIdentity;
    allowCrossChatRead: boolean;
    openApiReadAllowlist: ReadOnlyOpenApiRule[];
    skillPaths: string[];
    workspaceRoot: string;
    sessionRoot: string;
    larkCli: AgentDefinitionManifest['larkCli'];
  };
  oauth: OAuthDefinition;
  route: BindingRoute;
}

export function resolveBindingConfig(
  binding: LoadedAppAgentBinding,
): LoadedBindingConfig {
  const app = binding.appDefinition;
  const agent = binding.agentDefinition;
  return {
    id: binding.id,
    appKey: app.id,
    agentId: agent.id,
    configFile: binding.configFile,
    appId: app.appId,
    appSecret: app.appSecret,
    ...(app.verificationToken ? { verificationToken: app.verificationToken } : {}),
    ...(app.encryptKey ? { encryptKey: app.encryptKey } : {}),
    ...(app.oauthPublicBaseUrl
      ? { oauthPublicBaseUrl: app.oauthPublicBaseUrl }
      : {}),
    ...(app.oauthEncryptionKey
      ? { oauthEncryptionKey: app.oauthEncryptionKey }
      : {}),
    systemPrompt: agent.systemPrompt,
    feishu: {
      domain: app.domain,
      events: app.events,
      callbacks: app.callbacks,
      requireMention: app.policy.requireMention,
      dmMode: app.policy.dmMode,
      dmAllowlist: app.policy.dmAllowlist,
      groupAllowlist: app.policy.groupAllowlist,
      respondToMentionAll: app.policy.respondToMentionAll,
      attachments: app.attachments,
    },
    conversation: binding.conversation,
    identity: app.identity,
    runtime: agent.runtime,
    sandbox: {
      mode: agent.workspace.mode,
      maxReadBytes: agent.workspace.maxReadBytes,
      maxWriteBytes: agent.workspace.maxWriteBytes,
      maxTotalBytes: agent.workspace.maxTotalBytes,
      maxFiles: agent.workspace.maxFiles,
    },
    agent: {
      systemPromptFile: agent.systemPromptFile,
      provider: agent.provider,
      model: agent.model,
      modelApi: agent.modelApi,
      upstreamPath: agent.upstreamPath,
      modelOptions: agent.modelOptions,
      thinkingLevel: agent.thinkingLevel,
      feishuTools: agent.tools.feishu,
      workspaceTools: agent.tools.workspace,
      toolGrants: agent.tools.grants,
      defaultToolIdentity: agent.tools.defaultIdentity,
      allowCrossChatRead: agent.tools.allowCrossChatRead,
      openApiReadAllowlist: agent.tools.openApiReadAllowlist,
      skillPaths: agent.skillPaths,
      workspaceRoot: agent.workspace.root,
      sessionRoot: agent.workspace.sessionRoot,
      larkCli: agent.larkCli,
    },
    oauth: app.oauth,
    route: binding.route,
  };
}

export interface HttpListenerConfig {
  enabled: boolean;
  host: string;
  port: number;
  bodyLimitBytes: number;
}

export interface ModelBrokerConfig {
  enabled: boolean;
  host: string;
  port: number;
  publicBaseUrl: string;
  upstreamBaseUrl?: string;
  upstreamApiKey?: string;
  requestTimeoutMs: number;
  maxBodyBytes: number;
  capabilityTtlMs: number;
  capabilityMaxLifetimeMs: number;
  allowNonCloudflareUpstream: boolean;
}

export interface HostConfig {
  projectRoot: string;
  configRoot: string;
  instanceId: string;
  dataRoot: string;
  databasePath: string;
  platformMasterKey?: string;
  shard: {
    index: number;
    count: number;
  };
  lease: {
    ttlMs: number;
    heartbeatMs: number;
  };
  publicHttp: HttpListenerConfig;
  internalHttp: HttpListenerConfig & {
    adminToken?: string;
  };
  adminTrustedProxyAddresses?: string[];
  adminOpenIds: string[];
  approvalTtlMs: number;
  modelBroker: ModelBrokerConfig;
  modelProviderPolicy: ModelProviderPolicy;
  maxConcurrentTurnsGlobal: number;
  maxResidentPiWorkers: number;
  maxConcurrentWorkerStarts: number;
  maintenanceIntervalMs: number;
  isHuggingFaceSpace: boolean;
}
