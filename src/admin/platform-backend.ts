import type { PlatformHost } from '../app/host.js';
import { lstat, realpath, rm } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import {
  conversationStorageId,
  parseConversationKey,
} from '../core/conversation.js';
import {
  loadPlatformConfigDocument,
  validatePlatformConfigDocument,
} from '../config/load-platform.js';
import type {
  HostConfig,
  PlatformConfigDocument,
} from '../config/types.js';
import type { AuditEvent } from '../storage/database.js';
import {
  ConfigConflictError,
  type ConfigDocumentStore,
  type ConfigRevision,
  type ConfigRevisionSummary,
} from '../storage/config-store.js';
import type { CredentialVault } from '../storage/credential-vault.js';
import type { PlatformDatabase } from '../storage/database.js';
import {
  PersistentSessionIndex,
  type PersistentSessionRecord,
} from '../storage/session-index.js';
import {
  ToolApprovalStore,
  type StoredApprovalState,
} from '../storage/approval-store.js';
import {
  AdminBackendError,
  type AdminAppSummary,
  type AdminAuditEvent,
  type AdminBackend,
  type AdminBindingSummary,
  type AdminConfigState,
  type AdminCredentialStatus,
  type AdminOverview,
  type AdminRequestContext,
  type AdminRevisionDetail,
  type AdminRevisionSummary,
  type AdminAgentSummary,
  type AdminApprovalSummary,
  type AdminSessionSummary,
  type AdminLarkCliDiagnostic,
} from './contracts.js';

export class PlatformAdminBackend implements AdminBackend {
  private readonly sessionIndex: PersistentSessionIndex;
  private readonly approvalStore: ToolApprovalStore;

  constructor(
    private readonly host: PlatformHost,
    private readonly hostConfig: HostConfig,
    private readonly database: PlatformDatabase,
    private readonly store: ConfigDocumentStore<PlatformConfigDocument>,
    private readonly vault: CredentialVault,
  ) {
    this.sessionIndex = new PersistentSessionIndex(database);
    this.approvalStore = new ToolApprovalStore(database);
  }

  async startAdminSso(input: { appKey: string; returnTo?: string }): Promise<string> {
    const app = this.host.getApp(input.appKey);
    if (!app) throw new AdminBackendError(404, 'app_not_found', 'Feishu App 未运行。');
    try {
      return await app.createAdminSsoAuthorizationUrl(input.returnTo ?? '/admin');
    } catch (error) {
      throw new AdminBackendError(400, 'sso_unavailable', errorText(error));
    }
  }

  async completeAdminSso(input: {
    appKey: string;
    code: string;
    state: string;
  }): Promise<{ openId: string; returnTo?: string }> {
    const app = this.host.getApp(input.appKey);
    if (!app) throw new AdminBackendError(404, 'app_not_found', 'Feishu App 未运行。');
    try {
      return await app.handleAdminSsoCallback(input.code, input.state);
    } catch (error) {
      throw new AdminBackendError(400, 'sso_callback_rejected', errorText(error));
    }
  }

  getOverview(_context: AdminRequestContext): AdminOverview {
    const state = this.store.getState();
    const snapshot = this.host.snapshot();
    const document = state.active?.document;
    const warnings: string[] = [];
    if (!state.active) warnings.push('平台尚未发布配置，请完成首次设置。');
    if (snapshot.failedApps > 0) warnings.push(`${snapshot.failedApps} 个 Feishu App 启动失败。`);
    if (state.active && !snapshot.modelBroker.started) warnings.push('Model Broker 未就绪。');
    return {
      status: !state.active ? 'setup_required' : snapshot.ready ? 'ready' : 'degraded',
      version: snapshot.version,
      ...(state.active ? { activeRevisionId: state.active.id } : {}),
      ...(state.draft ? { draftRevisionId: state.draft.id } : {}),
      appCount: document?.apps.length ?? 0,
      agentCount: document?.agents.length ?? 0,
      bindingCount: document?.bindings.length ?? 0,
      configuredCredentialCount: this.vault.listStatuses().length,
      warnings,
      runtime: {
        activeApps: snapshot.activeApps,
        failedApps: snapshot.failedApps,
        residentWorkers: snapshot.runtimeCapacity.residentWorkers,
        residentWorkerLimit: snapshot.runtimeCapacity.residentWorkerLimit,
        workerStartsInUse: snapshot.runtimeCapacity.workerStartsInUse,
        workerStartLimit: snapshot.runtimeCapacity.workerStartLimit,
        activeTurns: snapshot.apps.reduce(
          (total, app) => total + app.bindings.reduce(
            (appTotal, binding) => appTotal + binding.activeTurns,
            0,
          ),
          0,
        ),
        waitingTurns: snapshot.apps.reduce(
          (total, app) => total + app.bindings.reduce(
            (appTotal, binding) => appTotal + binding.waitingTurns,
            0,
          ),
          0,
        ),
        modelBrokerStarted: snapshot.modelBroker.started,
        activeModelCapabilities: snapshot.modelBroker.activeCapabilities,
      },
    };
  }

  listApps(_context: AdminRequestContext): AdminAppSummary[] {
    const document = this.currentDocument();
    return document.apps.map((app) => ({
      id: app.id,
      enabled: app.enabled,
      domain: app.domain,
      eventsTransport: app.events.transport,
      callbacksTransport: app.callbacks.transport,
      credentials: credentialNames(app).map((name) => {
        const status = this.vault.getStatus(name);
        return {
          name,
          configured: status.configured,
          ...(status.fingerprint ? { fingerprint: status.fingerprint } : {}),
        };
      }),
    }));
  }

  listAgents(_context: AdminRequestContext): AdminAgentSummary[] {
    return this.currentDocument().agents.map((agent) => ({
      id: agent.id,
      enabled: agent.enabled,
      provider: agent.provider,
      model: agent.model,
      modelApi: agent.modelApi,
      runtimeIsolation: agent.runtime.isolation,
      workspaceMode: agent.workspace.mode,
    }));
  }

  listBindings(_context: AdminRequestContext): AdminBindingSummary[] {
    return this.currentDocument().bindings.map((binding) => ({
      id: binding.id,
      enabled: binding.enabled,
      app: binding.app,
      agent: binding.agent,
      isDefault: binding.route.default,
      priority: binding.route.priority,
    }));
  }

  getConfigState(_context: AdminRequestContext): AdminConfigState {
    const state = this.store.getState();
    return {
      ...(state.active ? { active: revisionDetail(state.active) } : {}),
      ...(state.draft ? { draft: revisionDetail(state.draft) } : {}),
    };
  }

  mutateDraftEntity(
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
  ): AdminRevisionDetail {
    const state = this.store.getState();
    const document = structuredClone(
      state.draft?.document ?? state.active?.document ?? {
        schemaVersion: 1,
        apps: [],
        agents: [],
        bindings: [],
      },
    );
    const id = entityId(input.id);
    const items = document[input.kind] as Array<Record<string, unknown>>;
    const index = items.findIndex((item) => item.id === id);
    if (input.action === 'create') {
      if (index >= 0) throw new AdminBackendError(409, 'entity_exists', `${id} 已存在。`);
      if (!input.entity) throw new AdminBackendError(400, 'entity_required', 'entity 必填。');
      items.push({ ...structuredClone(input.entity), id });
    } else if (input.action === 'update') {
      if (index < 0) throw new AdminBackendError(404, 'entity_not_found', `${id} 不存在。`);
      if (!input.entity) throw new AdminBackendError(400, 'entity_required', 'entity 必填。');
      items[index] = { ...structuredClone(input.entity), id };
    } else if (input.action === 'copy') {
      if (index < 0) throw new AdminBackendError(404, 'entity_not_found', `${id} 不存在。`);
      const newId = entityId(input.newId ?? '');
      if (items.some((item) => item.id === newId)) {
        throw new AdminBackendError(409, 'entity_exists', `${newId} 已存在。`);
      }
      items.push({ ...structuredClone(items[index]), id: newId, enabled: false });
    } else if (input.action === 'disable') {
      if (index < 0) throw new AdminBackendError(404, 'entity_not_found', `${id} 不存在。`);
      items[index] = { ...items[index], enabled: false };
    } else {
      if (index < 0) throw new AdminBackendError(404, 'entity_not_found', `${id} 不存在。`);
      if (input.confirmation !== id) {
        throw new AdminBackendError(
          400,
          'confirmation_required',
          '永久删除需要以实体 ID 作为二次确认值。',
        );
      }
      items.splice(index, 1);
    }
    try {
      return revisionDetail(this.store.saveDraft(document, {
        actor: context.actor,
        note: `${input.kind}.${input.action}:${id}`,
        expectedDraftRevisionId:
          input.expectedDraftRevisionId === undefined
            ? state.draft?.id ?? null
            : input.expectedDraftRevisionId,
        ...(state.draft ? { sourceRevisionId: state.draft.id } : state.active
          ? { sourceRevisionId: state.active.id }
          : {}),
      }));
    } catch (error) {
      throw adminMutationError(error);
    }
  }

  saveDraft(
    input: {
      document: Record<string, unknown>;
      note?: string;
      expectedDraftRevisionId?: number | null;
    },
    context: AdminRequestContext,
  ): AdminRevisionDetail {
    try {
      const document = validatePlatformConfigDocument(input.document);
      return revisionDetail(this.store.saveDraft(document, {
        actor: context.actor,
        ...(input.note ? { note: input.note } : {}),
        ...(input.expectedDraftRevisionId === undefined
          ? {}
          : { expectedDraftRevisionId: input.expectedDraftRevisionId }),
      }));
    } catch (error) {
      throw adminMutationError(error);
    }
  }

  async validateDraft(
    _context: AdminRequestContext,
  ): Promise<{ valid: boolean; errors: string[]; warnings: string[] }> {
    const draft = this.store.getState().draft;
    if (!draft) return { valid: false, errors: ['当前没有可校验的 Draft。'], warnings: [] };
    try {
      await this.loadRuntimeConfig(draft.document);
      return { valid: true, errors: [], warnings: [] };
    } catch (error) {
      return { valid: false, errors: [errorText(error)], warnings: [] };
    }
  }

  async publishDraft(
    input: { expectedDraftRevisionId?: number; note?: string },
    context: AdminRequestContext,
  ): Promise<AdminRevisionDetail> {
    const draft = this.store.getState().draft;
    if (!draft) throw new AdminBackendError(409, 'draft_missing', '当前没有可发布的 Draft。');
    if (
      input.expectedDraftRevisionId !== undefined &&
      input.expectedDraftRevisionId !== draft.id
    ) {
      throw new AdminBackendError(409, 'draft_conflict', 'Draft 已被其他管理员更新。');
    }
    let platform;
    try {
      platform = await this.loadRuntimeConfig(draft.document);
    } catch (error) {
      throw new AdminBackendError(400, 'config_invalid', errorText(error));
    }
    let revision: ConfigRevision<PlatformConfigDocument>;
    try {
      revision = this.store.publishDraft({
        actor: context.actor,
        expectedDraftRevisionId: draft.id,
        ...(input.note ? { note: input.note } : {}),
      });
    } catch (error) {
      throw adminMutationError(error);
    }
    try {
      await this.host.applyPlatformConfig(platform, revision.id);
    } catch (error) {
      this.database.recordAudit({
        actor: context.actor,
        action: 'config.runtime_apply_failed',
        entityType: 'config_revision',
        entityId: String(revision.id),
        details: { error: errorText(error) },
      });
      throw new AdminBackendError(
        503,
        'runtime_apply_failed',
        '配置已发布，但运行时应用失败；请检查状态后回滚或修正配置。',
      );
    }
    return revisionDetail(revision);
  }

  async rollbackRevision(
    input: { revisionId: number; note?: string },
    context: AdminRequestContext,
  ): Promise<AdminRevisionDetail> {
    const target = this.store.getRevision(input.revisionId);
    if (!target) throw new AdminBackendError(404, 'revision_not_found', 'Revision 不存在。');
    let platform;
    try {
      platform = await this.loadRuntimeConfig(target.document);
    } catch (error) {
      throw new AdminBackendError(400, 'config_invalid', errorText(error));
    }
    let revision: ConfigRevision<PlatformConfigDocument>;
    try {
      revision = this.store.rollback(input.revisionId, {
        actor: context.actor,
        ...(input.note ? { note: input.note } : {}),
      });
    } catch (error) {
      throw adminMutationError(error);
    }
    try {
      await this.host.applyPlatformConfig(platform, revision.id);
    } catch (error) {
      this.database.recordAudit({
        actor: context.actor,
        action: 'config.runtime_apply_failed',
        entityType: 'config_revision',
        entityId: String(revision.id),
        details: {
          operation: 'rollback',
          targetRevisionId: input.revisionId,
          error: errorText(error),
        },
      });
      throw new AdminBackendError(
        503,
        'runtime_apply_failed',
        '回滚 revision 已发布，但运行时应用失败；请检查状态后修正或再次回滚。',
      );
    }
    return revisionDetail(revision);
  }

  listRevisions(
    input: { limit: number },
    _context: AdminRequestContext,
  ): AdminRevisionSummary[] {
    return this.store.listRevisions(input.limit).map(revisionSummary);
  }

  getRevision(
    revisionId: number,
    _context: AdminRequestContext,
  ): AdminRevisionDetail | undefined {
    const revision = this.store.getRevision(revisionId);
    return revision ? revisionDetail(revision) : undefined;
  }

  listCredentials(_context: AdminRequestContext): AdminCredentialStatus[] {
    return this.vault.listStatuses();
  }

  async setCredential(
    input: { name: string; kind: string; value: string },
    context: AdminRequestContext,
  ): Promise<AdminCredentialStatus> {
    let status: AdminCredentialStatus;
    try {
      status = this.vault.setCredential({ ...input, actor: context.actor });
    } catch (error) {
      throw new AdminBackendError(400, 'credential_invalid', errorText(error));
    }
    await this.reloadActiveIfCredentialIsReferenced(input.name, context.actor);
    return status;
  }

  async deleteCredential(
    name: string,
    context: AdminRequestContext,
  ): Promise<boolean> {
    const active = this.store.getState().active;
    if (active && documentCredentialNames(active.document).has(name)) {
      throw new AdminBackendError(
        409,
        'credential_in_use',
        '该凭据仍被当前 Active 配置引用，请先禁用相关 App 并发布。',
      );
    }
    try {
      return this.vault.deleteCredential(name, context.actor);
    } catch (error) {
      throw new AdminBackendError(400, 'credential_invalid', errorText(error));
    }
  }

  listAudit(
    input: { limit: number; beforeId?: number },
    _context: AdminRequestContext,
  ): AdminAuditEvent[] {
    return this.database.listAudit(input).map(auditEvent);
  }

  async listSessions(
    input: { appKey?: string; agentId?: string; bindingId?: string; limit: number },
    _context: AdminRequestContext,
  ): Promise<AdminSessionSummary[]> {
    const resident = new Set<string>();
    const snapshots = await Promise.all(
      this.host.listApps().map((app) => app.listSessions()),
    );
    for (const session of snapshots.flat()) resident.add(session.storageId);
    return this.sessionIndex.list(input).map((session) => ({
      storageId: session.storageId,
      conversationKey: session.conversationKey,
      appKey: session.appKey,
      agentId: session.agentId,
      bindingId: session.bindingId,
      chatId: session.chatId,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      resident: resident.has(session.storageId),
    }));
  }

  async operateSession(
    input: {
      storageId: string;
      action: 'abort' | 'reset' | 'delete';
      confirmation?: string;
    },
    context: AdminRequestContext,
  ): Promise<{ operated: boolean }> {
    const session = this.sessionIndex.get(input.storageId);
    if (!session) throw new AdminBackendError(404, 'session_not_found', '会话不存在。');
    const app = this.host.getApp(session.appKey);
    if (input.action === 'abort') {
      const operated = app ? await app.abortConversation(session.conversationKey) : false;
      this.recordSessionAudit(context.actor, input.action, session.storageId, operated);
      return { operated };
    }
    if (input.action === 'delete' && input.confirmation !== input.storageId) {
      throw new AdminBackendError(
        400,
        'confirmation_required',
        '永久清理需要以 storageId 作为二次确认值。',
      );
    }
    if (app) await app.resetConversation(session.conversationKey);
    else {
      await this.removeSessionPath(session.sessionPath, session, 'session');
      this.sessionIndex.remove(session.storageId);
    }
    if (input.action === 'delete') {
      await this.removeSessionPath(session.workspacePath, session, 'workspace');
      await this.removeSessionPath(session.sessionPath, session, 'session');
      this.sessionIndex.remove(session.storageId);
    }
    this.recordSessionAudit(context.actor, input.action, session.storageId, true);
    return { operated: true };
  }

  listApprovals(
    input: { state?: string; limit: number },
    _context: AdminRequestContext,
  ): AdminApprovalSummary[] {
    const allowed = new Set<StoredApprovalState>([
      'pending', 'approved', 'denied', 'expired', 'aborted',
    ]);
    if (input.state && !allowed.has(input.state as StoredApprovalState)) {
      throw new AdminBackendError(400, 'approval_state_invalid', '审批状态无效。');
    }
    return this.approvalStore.list({
      ...(input.state ? { state: input.state as StoredApprovalState } : {}),
      limit: input.limit,
    });
  }

  async resolveApproval(
    input: { id: string; decision: 'approve' | 'deny' },
    context: AdminRequestContext,
  ): Promise<AdminApprovalSummary> {
    const approval = this.approvalStore.get(input.id);
    if (!approval) throw new AdminBackendError(404, 'approval_not_found', '审批不存在。');
    if (approval.state !== 'pending') {
      throw new AdminBackendError(409, 'approval_resolved', '审批已处理或已过期。');
    }
    if (approval.approval !== 'admin') {
      throw new AdminBackendError(403, 'requester_approval_required', '该操作必须由原请求者在飞书中审批。');
    }
    const app = this.host.getApp(approval.appKey);
    if (!app) throw new AdminBackendError(409, 'approval_runtime_unavailable', '审批所属 App 当前不可用。');
    const operator = context.session.actor.type === 'feishu-sso'
      ? context.session.actor.openId
      : context.session.actor.id;
    const resolved = await app.resolveAdminApproval(input.id, input.decision, operator);
    if (!resolved) {
      throw new AdminBackendError(409, 'approval_resolved', '审批已处理、已过期或不属于当前运行时。');
    }
    this.database.recordAudit({
      actor: context.actor,
      action: `tool_approval.${input.decision === 'approve' ? 'approved' : 'denied'}`,
      entityType: 'tool_approval',
      entityId: input.id,
      details: {
        appKey: approval.appKey,
        agentId: approval.agentId,
        bindingId: approval.bindingId,
        operation: approval.operation,
        argumentsHash: approval.argumentsHash,
      },
    });
    return this.approvalStore.get(input.id) as AdminApprovalSummary;
  }

  listLarkCliDiagnostics(_context: AdminRequestContext): AdminLarkCliDiagnostic[] {
    const document = this.currentDocument();
    const snapshot = this.host.snapshot();
    const runtimeBindings = new Map(
      snapshot.apps.flatMap((app) =>
        app.bindings.map((binding) => [binding.id, { app, binding }] as const),
      ),
    );
    return document.bindings
      .filter((binding) => binding.enabled)
      .flatMap((binding) => {
        const agent = document.agents.find((item) => item.id === binding.agent);
        const app = document.apps.find((item) => item.id === binding.app);
        if (!agent || !app) return [];
        const runtime = runtimeBindings.get(binding.id);
        const operations = agent.larkCli.operations;
        const error = runtime?.binding.lastError ??
          (agent.larkCli.enabled && !runtime ? 'App 或 Binding 运行时不可用。' : undefined);
        return [{
          appKey: binding.app,
          bindingId: binding.id,
          agentId: binding.agent,
          enabled: agent.larkCli.enabled,
          ready: runtime?.binding.ready ?? false,
          expectedVersion: agent.larkCli.expectedVersion,
          ...(runtime?.binding.larkCli?.actualVersion
            ? { actualVersion: runtime.binding.larkCli.actualVersion }
            : {}),
          initialized: runtime?.binding.larkCli?.initialized ?? false,
          readOperations: operations.filter((operation) => operation.effect === 'read').length,
          writeOperations: operations.filter((operation) => operation.effect === 'write').length,
          highRiskOperations: operations.filter(
            (operation) => operation.effect === 'high-risk-write',
          ).length,
          approvalCallbackConfigured: app.callbacks.transport === 'http',
          approvalCallbackReady: Boolean(
            runtime?.app.started && runtime.app.callbacksTransport === 'http',
          ),
          ...(error ? { error } : {}),
        }];
      });
  }

  private currentDocument(): PlatformConfigDocument {
    return this.store.getState().active?.document ?? {
      schemaVersion: 1,
      apps: [],
      agents: [],
      bindings: [],
    };
  }

  private async loadRuntimeConfig(document: PlatformConfigDocument) {
    return await loadPlatformConfigDocument(
      document,
      this.hostConfig.projectRoot,
      this.hostConfig.dataRoot,
      (name) => this.vault.resolveForInternalUse(name),
    );
  }

  private async reloadActiveIfCredentialIsReferenced(
    name: string,
    actor: string,
  ): Promise<void> {
    const active = this.store.getState().active;
    if (!active || !documentCredentialNames(active.document).has(name)) return;
    try {
      const platform = await this.loadRuntimeConfig(active.document);
      if (this.store.getState().active?.id !== active.id) return;
      await this.host.applyPlatformConfig(platform, active.id);
    } catch (error) {
      this.database.recordAudit({
        actor,
        action: 'credential.runtime_reload_failed',
        entityType: 'credential',
        entityId: name,
        details: { error: errorText(error) },
      });
      throw new AdminBackendError(
        503,
        'credential_reload_failed',
        '凭据已安全保存，但相关 App 重载失败；请检查运行状态。',
      );
    }
  }

  private async removeSessionPath(
    path: string,
    session: PersistentSessionRecord,
    kind: 'workspace' | 'session',
  ): Promise<void> {
    let address;
    try {
      address = parseConversationKey(session.conversationKey);
    } catch {
      throw new AdminBackendError(409, 'session_path_mismatch', '会话索引身份无效。');
    }
    if (
      conversationStorageId(session.conversationKey) !== session.storageId ||
      address.appKey !== session.appKey ||
      address.agentId !== session.agentId ||
      address.chatId !== session.chatId
    ) {
      throw new AdminBackendError(409, 'session_path_mismatch', '会话索引身份不一致。');
    }
    const target = resolve(path);
    const root = resolve(target, '..', '..', '..');
    const expected = resolve(root, session.appKey, session.agentId, session.storageId);
    const dataRelation = relative(resolve(this.hostConfig.dataRoot), root);
    if (
      expected !== target ||
      dataRelation === '..' ||
      dataRelation.startsWith('../') ||
      dataRelation.startsWith('..\\')
    ) {
      throw new AdminBackendError(409, 'session_path_mismatch', '会话存储路径与当前配置不一致。');
    }
    try {
      await lstat(target);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    const [realRoot, realParent] = await Promise.all([
      realpath(root),
      realpath(dirname(target)),
    ]);
    if (realParent !== resolve(realRoot, session.appKey, session.agentId)) {
      throw new AdminBackendError(409, 'session_path_mismatch', `${kind} 路径包含不安全的链接。`);
    }
    await rm(target, { recursive: true, force: true });
  }

  private recordSessionAudit(
    actor: string,
    action: string,
    storageId: string,
    operated: boolean,
  ): void {
    this.database.recordAudit({
      actor,
      action: `session.${action}`,
      entityType: 'conversation_session',
      entityId: storageId,
      details: { operated },
    });
  }
}

function credentialNames(app: PlatformConfigDocument['apps'][number]): string[] {
  return [
    app.appIdEnv,
    app.appSecretEnv,
    app.verificationTokenEnv,
    app.encryptKeyEnv,
    ...(app.oauth.enabled
      ? [app.oauth.publicBaseUrlEnv, app.oauth.encryptionKeyEnv]
      : []),
  ].filter((value): value is string => Boolean(value));
}

function documentCredentialNames(document: PlatformConfigDocument): Set<string> {
  return new Set(document.apps.flatMap(credentialNames));
}

function revisionSummary(revision: ConfigRevisionSummary): AdminRevisionSummary {
  return structuredClone(revision);
}

function revisionDetail(
  revision: ConfigRevision<PlatformConfigDocument>,
): AdminRevisionDetail {
  return {
    ...revisionSummary(revision),
    document: structuredClone(revision.document) as unknown as Record<string, unknown>,
  };
}

function auditEvent(event: AuditEvent): AdminAuditEvent {
  return structuredClone(event);
}

function adminMutationError(error: unknown): AdminBackendError {
  if (error instanceof AdminBackendError) return error;
  if (error instanceof ConfigConflictError) {
    return new AdminBackendError(409, 'config_conflict', error.message);
  }
  return new AdminBackendError(400, 'config_invalid', errorText(error));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'code' in error &&
    (error as { code?: string }).code === 'ENOENT',
  );
}

function entityId(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(normalized)) {
    throw new AdminBackendError(400, 'entity_id_invalid', '实体 ID 格式无效。');
  }
  return normalized;
}
