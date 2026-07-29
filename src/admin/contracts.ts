import type { AdminSession } from './auth-service.js';

export interface AdminRequestContext {
  session: AdminSession;
  actor: string;
}

export interface AdminOverview {
  status: 'setup_required' | 'ready' | 'degraded' | 'unknown';
  version?: string;
  activeRevisionId?: number;
  draftRevisionId?: number;
  appCount: number;
  agentCount: number;
  bindingCount: number;
  configuredCredentialCount: number;
  warnings: string[];
  runtime: {
    activeApps: number;
    failedApps: number;
    residentWorkers: number;
    residentWorkerLimit: number;
    workerStartsInUse: number;
    workerStartLimit: number;
    activeTurns: number;
    waitingTurns: number;
    modelBrokerStarted: boolean;
    activeModelCapabilities: number;
  };
}

export interface AdminAppSummary {
  id: string;
  enabled: boolean;
  domain: 'feishu' | 'lark';
  eventsTransport: string;
  callbacksTransport: string;
  credentials: Array<{ name: string; configured: boolean; fingerprint?: string }>;
}

export interface AdminAgentSummary {
  id: string;
  enabled: boolean;
  provider: string;
  model: string;
  modelApi: string;
  runtimeIsolation: string;
  workspaceMode: string;
}

export interface AdminBindingSummary {
  id: string;
  enabled: boolean;
  app: string;
  agent: string;
  isDefault: boolean;
  priority: number;
}

export interface AdminRevisionSummary {
  id: number;
  contentSha256: string;
  createdAt: string;
  createdBy: string;
  note?: string;
  sourceRevisionId?: number;
  publishedAt?: string;
  publishedBy?: string;
  slots: Array<'active' | 'draft'>;
}

export interface AdminRevisionDetail extends AdminRevisionSummary {
  document: Record<string, unknown>;
}

export interface AdminConfigState {
  active?: AdminRevisionDetail;
  draft?: AdminRevisionDetail;
}

export interface AdminCredentialStatus {
  name: string;
  configured: boolean;
  kind?: string;
  fingerprint?: string;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface AdminAuditEvent {
  id: number;
  occurredAt: string;
  actor: string;
  action: string;
  entityType: string;
  entityId?: string;
  details: Record<string, unknown>;
}

export interface AdminSessionSummary {
  storageId: string;
  conversationKey: string;
  appKey: string;
  agentId: string;
  bindingId: string;
  chatId: string;
  createdAt: number;
  lastUsedAt: number;
  resident: boolean;
}

export interface AdminApprovalSummary {
  id: string;
  appKey: string;
  agentId: string;
  bindingId: string;
  conversationKey: string;
  messageId: string;
  requesterOpenId: string;
  operation: string;
  effect: string;
  approval: string;
  argumentsHash: string;
  state: string;
  approverOpenId?: string;
  createdAt: number;
  expiresAt: number;
  resolvedAt?: number;
}

export interface AdminLarkCliDiagnostic {
  appKey: string;
  bindingId: string;
  agentId: string;
  enabled: boolean;
  ready: boolean;
  expectedVersion: string;
  actualVersion?: string;
  initialized: boolean;
  readOperations: number;
  writeOperations: number;
  highRiskOperations: number;
  approvalCallbackConfigured: boolean;
  approvalCallbackReady: boolean;
  error?: string;
}

export interface AdminBackend {
  startAdminSso?(
    input: { appKey: string; returnTo?: string },
  ): Promise<string> | string;
  completeAdminSso?(
    input: { appKey: string; code: string; state: string },
  ):
    | Promise<{ openId: string; tenantKey?: string; displayName?: string; returnTo?: string }>
    | { openId: string; tenantKey?: string; displayName?: string; returnTo?: string };
  getOverview(context: AdminRequestContext): Promise<AdminOverview> | AdminOverview;
  listApps(context: AdminRequestContext): Promise<AdminAppSummary[]> | AdminAppSummary[];
  listAgents(context: AdminRequestContext): Promise<AdminAgentSummary[]> | AdminAgentSummary[];
  listBindings(context: AdminRequestContext): Promise<AdminBindingSummary[]> | AdminBindingSummary[];
  getConfigState(context: AdminRequestContext): Promise<AdminConfigState> | AdminConfigState;
  mutateDraftEntity?(
    input: {
      kind: 'apps' | 'agents' | 'bindings';
      action: 'create' | 'update' | 'copy' | 'disable' | 'delete';
      id: string;
      entity?: Record<string, unknown>;
      newId?: string;
      confirmation?: string;
      expectedDraftRevisionId?: number | null;
    },
    context: AdminRequestContext,
  ): Promise<AdminRevisionDetail> | AdminRevisionDetail;
  saveDraft(
    input: {
      document: Record<string, unknown>;
      note?: string;
      expectedDraftRevisionId?: number | null;
    },
    context: AdminRequestContext,
  ): Promise<AdminRevisionDetail> | AdminRevisionDetail;
  validateDraft?(
    context: AdminRequestContext,
  ):
    | Promise<{ valid: boolean; errors: string[]; warnings: string[] }>
    | { valid: boolean; errors: string[]; warnings: string[] };
  publishDraft(
    input: { expectedDraftRevisionId?: number; note?: string },
    context: AdminRequestContext,
  ): Promise<AdminRevisionDetail> | AdminRevisionDetail;
  rollbackRevision(
    input: { revisionId: number; note?: string },
    context: AdminRequestContext,
  ): Promise<AdminRevisionDetail> | AdminRevisionDetail;
  listRevisions(
    input: { limit: number },
    context: AdminRequestContext,
  ): Promise<AdminRevisionSummary[]> | AdminRevisionSummary[];
  getRevision(
    revisionId: number,
    context: AdminRequestContext,
  ): Promise<AdminRevisionDetail | undefined> | AdminRevisionDetail | undefined;
  listCredentials(
    context: AdminRequestContext,
  ): Promise<AdminCredentialStatus[]> | AdminCredentialStatus[];
  setCredential(
    input: { name: string; kind: string; value: string },
    context: AdminRequestContext,
  ): Promise<AdminCredentialStatus> | AdminCredentialStatus;
  deleteCredential(
    name: string,
    context: AdminRequestContext,
  ): Promise<boolean> | boolean;
  listAudit(
    input: { limit: number; beforeId?: number },
    context: AdminRequestContext,
  ): Promise<AdminAuditEvent[]> | AdminAuditEvent[];
  listSessions?(
    input: { appKey?: string; agentId?: string; bindingId?: string; limit: number },
    context: AdminRequestContext,
  ): Promise<AdminSessionSummary[]> | AdminSessionSummary[];
  operateSession?(
    input: {
      storageId: string;
      action: 'abort' | 'reset' | 'delete';
      confirmation?: string;
    },
    context: AdminRequestContext,
  ): Promise<{ operated: boolean }> | { operated: boolean };
  listApprovals?(
    input: { state?: string; limit: number },
    context: AdminRequestContext,
  ): Promise<AdminApprovalSummary[]> | AdminApprovalSummary[];
  resolveApproval?(
    input: { id: string; decision: 'approve' | 'deny' },
    context: AdminRequestContext,
  ): Promise<AdminApprovalSummary> | AdminApprovalSummary;
  listLarkCliDiagnostics?(
    context: AdminRequestContext,
  ): Promise<AdminLarkCliDiagnostic[]> | AdminLarkCliDiagnostic[];
}

export class AdminBackendError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AdminBackendError';
  }
}
