const EMPTY_CONFIG = Object.freeze({
  schemaVersion: 1,
  apps: [],
  agents: [],
  bindings: [],
});

const RESOURCE_NAMES = {
  apps: 'App',
  agents: 'Agent',
  bindings: 'Binding',
};

const PANEL_LOADERS = {
  overview: loadOverview,
  apps: () => loadResources('apps'),
  agents: () => loadResources('agents'),
  bindings: () => loadResources('bindings'),
  config: loadConfig,
  revisions: loadRevisions,
  credentials: loadCredentials,
  sessions: loadSessions,
  approvals: loadApprovals,
  diagnostics: loadDiagnostics,
  audit: loadAudit,
};

const state = {
  csrfToken: '',
  session: null,
  config: null,
  activePanel: 'overview',
  loadedPanels: new Set(),
  loadVersions: new Map(),
  resources: { apps: [], agents: [], bindings: [] },
  resourceRevisionIds: { apps: null, agents: null, bindings: null },
  revisions: [],
  sessions: [],
  approvals: [],
  entityEditor: null,
  confirmation: null,
  revisionTrigger: null,
};

const loginView = document.querySelector('#login-view');
const consoleView = document.querySelector('#console-view');
const sessionLabel = document.querySelector('#session-label');
const connectionDot = document.querySelector('.connection-dot');
const logoutButton = document.querySelector('#logout-button');
const notice = document.querySelector('#notice');
const entityDialog = document.querySelector('#entity-dialog');
const confirmDialog = document.querySelector('#confirm-dialog');
const revisionDialog = document.querySelector('#revision-dialog');

document.querySelector('#login-form').addEventListener('submit', login);
document.querySelector('#sso-form').addEventListener('submit', startSso);
logoutButton.addEventListener('click', () => void logout());

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => void showPanel(button.dataset.view));
});
document.querySelectorAll('[data-refresh]').forEach((button) => {
  button.addEventListener('click', () => void withBusy(
    button,
    '刷新中…',
    () => loadPanel(button.dataset.refresh, true),
  ));
});
document.querySelectorAll('[data-create-kind]').forEach((button) => {
  button.addEventListener('click', () => openEntityEditor(
    button.dataset.createKind,
    'create',
    undefined,
    undefined,
    button,
  ));
});

document.querySelector('#draft-form').addEventListener('submit', saveDraft);
document.querySelector('#validate-draft-button').addEventListener('click', validateDraft);
document.querySelector('#publish-form').addEventListener('submit', publishDraft);
document.querySelector('#rollback-form').addEventListener('submit', rollbackRevision);
document.querySelector('#credential-form').addEventListener('submit', saveCredential);
document.querySelector('#credential-delete-button').addEventListener('click', () => void deleteCredential());
document.querySelector('#session-filter-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void loadPanel('sessions', true);
});
document.querySelector('#session-filter-clear').addEventListener('click', () => {
  document.querySelector('#session-app-filter').value = '';
  document.querySelector('#session-agent-filter').value = '';
  document.querySelector('#session-binding-filter').value = '';
  void loadPanel('sessions', true);
});
document.querySelector('#approval-filter-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void loadPanel('approvals', true);
});

for (const kind of Object.keys(RESOURCE_NAMES)) {
  document.querySelector(`#${kind}-body`).addEventListener('click', handleResourceAction);
}
document.querySelector('#revisions-body').addEventListener('click', handleRevisionAction);
document.querySelector('#credentials-body').addEventListener('click', handleCredentialAction);
document.querySelector('#sessions-body').addEventListener('click', handleSessionAction);
document.querySelector('#approvals-body').addEventListener('click', handleApprovalAction);

document.querySelector('#entity-form').addEventListener('submit', submitEntityEditor);
document.querySelectorAll('[data-dialog-close]').forEach((button) => {
  button.addEventListener('click', () => closeNamedDialog(button.dataset.dialogClose));
});
entityDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeEntityEditor();
});
revisionDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeRevisionDialog();
});

document.querySelector('#confirm-form').addEventListener('submit', submitConfirmation);
document.querySelectorAll('[data-confirm-cancel]').forEach((button) => {
  button.addEventListener('click', () => settleConfirmation(false));
});
confirmDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  settleConfirmation(false);
});

await restoreSession();

async function restoreSession() {
  setLoginStatus('正在检查现有管理会话…');
  try {
    const result = await api('/api/admin/v1/auth/session');
    setAuthenticated(result.session, result.csrfToken);
    await loadPanel('overview', true);
  } catch (error) {
    setLoggedOut();
    if (error.status && error.status !== 401) {
      setLoginStatus(friendlyError(error), 'error');
    } else {
      setLoginStatus('请选择一种方式登录。');
    }
  }
}

async function login(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const tokenInput = document.querySelector('#admin-token');
  const token = tokenInput.value;
  tokenInput.value = '';
  setLoginStatus('正在建立管理会话…');
  try {
    await withBusy(event.submitter, '登录中…', async () => {
      const result = await api('/api/admin/v1/auth/login', {
        method: 'POST',
        body: { token },
      });
      setAuthenticated(result.session, result.csrfToken);
      form.reset();
      showNotice('登录成功。');
      await loadPanel('overview', true);
    });
  } catch (error) {
    setLoginStatus(friendlyError(error), 'error');
  }
}

function startSso(event) {
  event.preventDefault();
  const appKey = document.querySelector('#sso-app-key').value.trim();
  if (!appKey) return;
  const button = event.submitter;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = '正在跳转…';
  setLoginStatus(`正在通过 ${appKey} 跳转到飞书 SSO…`);
  window.location.assign(`/api/admin/v1/auth/sso/start?appKey=${encodeURIComponent(appKey)}`);
}

async function logout() {
  try {
    await withBusy(logoutButton, '退出中…', () => api('/api/admin/v1/auth/logout', {
      method: 'POST',
      body: {},
    }));
  } catch (error) {
    if (error.status !== 401) showNotice(friendlyError(error), 'error');
  } finally {
    setLoggedOut();
    setLoginStatus('已退出管理会话。');
    document.querySelector('#admin-token').focus();
  }
}

function setAuthenticated(session, csrfToken) {
  state.session = session;
  state.csrfToken = csrfToken;
  loginView.hidden = true;
  consoleView.hidden = false;
  logoutButton.hidden = false;
  connectionDot.classList.add('online');
  const actor = session?.actor ?? {};
  sessionLabel.textContent = actor.displayName || actor.openId || actor.id || '管理员';
}

function setLoggedOut() {
  state.session = null;
  state.csrfToken = '';
  state.config = null;
  state.resources = { apps: [], agents: [], bindings: [] };
  state.resourceRevisionIds = { apps: null, agents: null, bindings: null };
  state.loadedPanels.clear();
  for (const name of Object.keys(PANEL_LOADERS)) {
    state.loadVersions.set(name, (state.loadVersions.get(name) ?? 0) + 1);
  }
  loginView.hidden = false;
  consoleView.hidden = true;
  logoutButton.hidden = true;
  connectionDot.classList.remove('online');
  sessionLabel.textContent = '未登录';
  document.querySelector('#admin-token').value = '';
  document.querySelector('#credential-value').value = '';
  document.querySelector('#app-key-options').replaceChildren();
  closeEntityEditor();
  settleConfirmation(false);
  closeRevisionDialog();
}

async function showPanel(name) {
  if (!PANEL_LOADERS[name]) return;
  state.activePanel = name;
  document.querySelectorAll('[data-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== name;
  });
  document.querySelectorAll('[data-view]').forEach((button) => {
    const active = button.dataset.view === name;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  await loadPanel(name);
}

async function loadPanel(name, force = false) {
  const loader = PANEL_LOADERS[name];
  if (!loader) return;
  if (!force && state.loadedPanels.has(name)) return;
  const version = (state.loadVersions.get(name) ?? 0) + 1;
  state.loadVersions.set(name, version);
  setPanelStatus(name, 'loading', '正在读取最新状态…');
  try {
    await loader();
    if (state.loadVersions.get(name) !== version || !state.session) return;
    state.loadedPanels.add(name);
    setPanelStatus(name, 'ready');
  } catch (error) {
    if (state.loadVersions.get(name) !== version) return;
    if (error.status === 401) {
      setLoggedOut();
      setLoginStatus('管理会话已过期，请重新登录。', 'error');
      return;
    }
    const unsupported = [404, 405, 501].includes(error.status);
    const message = unsupported
      ? `当前后端尚未提供该能力：${friendlyError(error)}`
      : friendlyError(error);
    setPanelStatus(name, unsupported ? 'unsupported' : 'error', message);
  }
}

async function loadOverview() {
  const value = await api('/api/admin/v1/overview');
  const runtime = value.runtime ?? {};
  const statusLabel = value.status === 'setup_required'
    ? '待首次配置'
    : value.status === 'ready'
      ? '就绪'
      : value.status === 'degraded'
        ? '降级'
        : '未知';
  const cards = [
    ['运行状态', statusLabel],
    ['Active / Draft', `${value.activeRevisionId ?? '—'} / ${value.draftRevisionId ?? '—'}`],
    ['运行 Apps', `${runtime.activeApps ?? '—'} / ${value.appCount}`],
    ['失败 Apps', runtime.failedApps ?? '—'],
    ['Agents / Bindings', `${value.agentCount} / ${value.bindingCount}`],
    ['Resident Workers', `${runtime.residentWorkers ?? '—'} / ${runtime.residentWorkerLimit ?? '—'}`],
    ['Worker Starts', `${runtime.workerStartsInUse ?? '—'} / ${runtime.workerStartLimit ?? '—'}`],
    ['Active / Waiting Turns', `${runtime.activeTurns ?? '—'} / ${runtime.waitingTurns ?? '—'}`],
    ['Model Broker', runtime.modelBrokerStarted === undefined ? '—' : runtime.modelBrokerStarted ? '已启动' : '未启动'],
    ['模型能力租约', runtime.activeModelCapabilities ?? '—'],
    ['已配置凭据', value.configuredCredentialCount],
    ['版本', value.version ?? '—'],
  ];
  const root = document.querySelector('#overview-cards');
  root.replaceChildren(...cards.map(([label, data]) => element('div', { className: 'metric' }, [
    element('strong', { text: String(data) }),
    element('span', { text: label }),
  ])));
  const warnings = value.warnings?.length ? value.warnings : ['暂无服务端告警。'];
  document.querySelector('#overview-warnings').replaceChildren(
    ...warnings.map((warning) => element('li', { text: warning })),
  );
}

async function loadResources(kind) {
  const result = await api(`/api/admin/v1/draft/${kind}`);
  const items = Array.isArray(result.items) ? result.items.filter(isRecord) : [];
  state.resources[kind] = items;
  state.resourceRevisionIds[kind] = result.draftRevisionId ?? null;
  document.querySelector(`#${kind}-base`).textContent = result.draftRevisionId
    ? `正在编辑 Draft #${result.draftRevisionId}`
    : '尚无 Draft；当前显示 Active 基线或空配置，第一次修改会创建 Draft。';
  if (kind === 'apps') populateAppKeyOptions(items);

  const rows = items.map((item) => {
    if (kind === 'apps') {
      return [
        item.id ?? '—',
        enabledBadge(item.enabled),
        item.domain ?? '—',
        item.events?.transport ?? '—',
        item.callbacks?.transport ?? '—',
        resourceActions(kind, item),
      ];
    }
    if (kind === 'agents') {
      return [
        item.id ?? '—',
        enabledBadge(item.enabled),
        item.provider ?? '—',
        cellStack(item.model ?? '—', item.modelApi ?? '—'),
        item.runtime?.isolation ?? '—',
        item.workspace?.mode ?? '—',
        resourceActions(kind, item),
      ];
    }
    return [
      item.id ?? '—',
      enabledBadge(item.enabled),
      item.app ?? '—',
      item.agent ?? '—',
      item.route?.default ? '是' : '否',
      item.route?.priority ?? '—',
      resourceActions(kind, item),
    ];
  });
  fillTable(
    `#${kind}-body`,
    rows,
    `暂无 ${RESOURCE_NAMES[kind]}`,
    '可新建实体，或先从完整配置文档创建 Draft。',
  );
}

function resourceActions(kind, item) {
  const root = element('div', { className: 'table-actions' });
  const id = String(item.id ?? '');
  root.append(
    actionButton('编辑', 'edit', kind, id),
    actionButton('复制', 'copy', kind, id),
    actionButton(item.enabled ? '停用' : '启用', 'toggle', kind, id, 'secondary'),
    actionButton('永久删除', 'delete', kind, id, 'danger-outline'),
  );
  return root;
}

async function handleResourceAction(event) {
  const button = event.target.closest('[data-resource-action]');
  if (!button) return;
  const { kind, id, resourceAction: action } = button.dataset;
  const item = state.resources[kind]?.find((candidate) => String(candidate.id) === id);
  if (!item) {
    showNotice('实体已变化，请刷新后重试。', 'error');
    return;
  }
  if (action === 'edit') {
    openEntityEditor(kind, 'edit', id, item, button);
    return;
  }
  if (action === 'copy') {
    const newId = await askConfirmation({
      title: `复制 ${RESOURCE_NAMES[kind]}`,
      description: `将 ${id} 复制为一个默认停用的新实体。请输入新的唯一 ID。`,
      confirmLabel: '创建副本',
      inputLabel: '新实体 ID',
      requireValue: true,
      trigger: button,
      danger: false,
    });
    if (typeof newId !== 'string') return;
    await runResourceMutation(button, kind, '复制中…', async () => {
      await api(`/api/admin/v1/draft/${kind}/${encodeURIComponent(id)}/copy`, {
        method: 'POST',
        body: {
          newId,
          expectedDraftRevisionId: state.resourceRevisionIds[kind],
        },
      });
      showNotice(`${id} 已复制为 ${newId}，新副本默认停用。`);
    });
    return;
  }
  if (action === 'toggle') {
    const enabling = !item.enabled;
    const confirmed = await askConfirmation({
      title: `${enabling ? '启用' : '停用'} ${RESOURCE_NAMES[kind]}`,
      description: `此操作只修改 Draft 中的 ${id}；发布前不会影响 Active 运行时。`,
      confirmLabel: `确认${enabling ? '启用' : '停用'}`,
      trigger: button,
      danger: false,
    });
    if (confirmed !== true) return;
    await runResourceMutation(button, kind, '处理中…', async () => {
      if (enabling) {
        await api(`/api/admin/v1/draft/${kind}/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body: {
            entity: { ...item, enabled: true },
            expectedDraftRevisionId: state.resourceRevisionIds[kind],
          },
        });
      } else {
        await api(`/api/admin/v1/draft/${kind}/${encodeURIComponent(id)}/disable`, {
          method: 'POST',
          body: { expectedDraftRevisionId: state.resourceRevisionIds[kind] },
        });
      }
      showNotice(`${id} 已在 Draft 中${enabling ? '启用' : '停用'}。`);
    });
    return;
  }
  if (action === 'delete') {
    const confirmation = await askConfirmation({
      title: `永久删除 ${RESOURCE_NAMES[kind]}`,
      description: `该操作会从 Draft 永久移除 ${id}。为防止误操作，请输入完整实体 ID。`,
      confirmLabel: '永久删除',
      inputLabel: `输入 ${id} 以确认`,
      requiredText: id,
      trigger: button,
      danger: true,
    });
    if (confirmation !== id) return;
    await runResourceMutation(button, kind, '删除中…', async () => {
      await api(`/api/admin/v1/draft/${kind}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        body: {
          confirmation,
          expectedDraftRevisionId: state.resourceRevisionIds[kind],
        },
      });
      showNotice(`${id} 已从 Draft 永久删除。`);
    });
  }
}

async function runResourceMutation(button, kind, busyLabel, operation) {
  try {
    await withBusy(button, busyLabel, operation);
    markPanelsStale('overview', 'config', 'revisions', 'apps', 'agents', 'bindings');
    await loadPanel(kind, true);
  } catch (error) {
    showNotice(friendlyError(error), 'error');
  }
}

function openEntityEditor(kind, mode, id, item, trigger) {
  if (!RESOURCE_NAMES[kind]) return;
  state.entityEditor = { kind, mode, id, trigger };
  const creating = mode === 'create';
  document.querySelector('#entity-dialog-title').textContent = `${creating ? '新建' : '编辑'} ${RESOURCE_NAMES[kind]}`;
  document.querySelector('#entity-dialog-description').textContent = creating
    ? '填写唯一 ID 和完整实体 JSON。首次保存会创建 Draft，但不会自动发布。'
    : `正在编辑 ${id}。实体 ID 不可在此操作中改名；如需新 ID，请使用复制。`;
  const idInput = document.querySelector('#entity-id');
  idInput.value = id ?? '';
  idInput.readOnly = !creating;
  document.querySelector('#entity-json').value = JSON.stringify(
    creating ? { enabled: false } : item,
    null,
    2,
  );
  document.querySelector('#entity-error').hidden = true;
  document.querySelector('#entity-submit').textContent = creating ? '创建 Draft 实体' : '保存到 Draft';
  entityDialog.showModal();
  window.requestAnimationFrame(() => (creating ? idInput : document.querySelector('#entity-json')).focus());
}

async function submitEntityEditor(event) {
  event.preventDefault();
  const editor = state.entityEditor;
  if (!editor) return;
  const id = document.querySelector('#entity-id').value.trim();
  const errorRoot = document.querySelector('#entity-error');
  let entity;
  try {
    entity = JSON.parse(document.querySelector('#entity-json').value);
    if (!isRecord(entity)) throw new Error('实体 JSON 必须是对象。');
  } catch (error) {
    errorRoot.textContent = error instanceof SyntaxError ? '实体内容不是有效 JSON。' : error.message;
    errorRoot.hidden = false;
    return;
  }
  if (!id) {
    errorRoot.textContent = '实体 ID 必填。';
    errorRoot.hidden = false;
    return;
  }
  delete entity.id;
  errorRoot.hidden = true;
  try {
    await withBusy(event.submitter, '保存中…', async () => {
      if (editor.mode === 'create') {
        await api(`/api/admin/v1/draft/${editor.kind}`, {
          method: 'POST',
          body: {
            id,
            entity,
            expectedDraftRevisionId: state.resourceRevisionIds[editor.kind],
          },
        });
      } else {
        await api(`/api/admin/v1/draft/${editor.kind}/${encodeURIComponent(editor.id)}`, {
          method: 'PUT',
          body: {
            entity,
            expectedDraftRevisionId: state.resourceRevisionIds[editor.kind],
          },
        });
      }
      const kind = editor.kind;
      closeEntityEditor();
      showNotice(`${id} 已保存到 Draft。`);
      markPanelsStale('overview', 'config', 'revisions', 'apps', 'agents', 'bindings');
      await loadPanel(kind, true);
    });
  } catch (error) {
    errorRoot.textContent = friendlyError(error);
    errorRoot.hidden = false;
  }
}

function closeEntityEditor() {
  const trigger = state.entityEditor?.trigger;
  state.entityEditor = null;
  if (entityDialog.open) entityDialog.close();
  trigger?.focus();
}

async function loadConfig() {
  const config = await api('/api/admin/v1/config');
  state.config = config;
  const source = config.draft || config.active;
  document.querySelector('#draft-document').value = JSON.stringify(source?.document ?? EMPTY_CONFIG, null, 2);
  document.querySelector('#draft-base-label').textContent = config.draft
    ? `当前 Draft #${config.draft.id}，保存时会做 revision 冲突检查。`
    : config.active
      ? `尚无 Draft，当前编辑基于 Active #${config.active.id}。`
      : '尚无 Active 或 Draft，已载入 schemaVersion 1 空配置模板。';
  const summary = document.querySelector('#active-summary');
  summary.replaceChildren();
  if (config.active) {
    appendDetail(summary, 'Revision', `#${config.active.id}`);
    appendDetail(summary, 'Digest', config.active.contentSha256);
    appendDetail(summary, 'Published', config.active.publishedAt ? formatTime(config.active.publishedAt) : '—');
    appendDetail(summary, 'Actor', config.active.publishedBy || config.active.createdBy);
  } else {
    appendDetail(summary, '状态', '尚无 Active revision');
  }
  const validation = document.querySelector('#validation-result');
  validation.hidden = true;
  const apps = source?.document?.apps;
  if (Array.isArray(apps)) populateAppKeyOptions(apps);
}

async function saveDraft(event) {
  event.preventDefault();
  let documentValue;
  try {
    documentValue = JSON.parse(document.querySelector('#draft-document').value);
    if (!isRecord(documentValue)) throw new Error();
  } catch {
    showNotice('草稿必须是有效的 JSON 对象。', 'error');
    return;
  }
  try {
    await withBusy(event.submitter, '保存中…', async () => {
      const revision = await api('/api/admin/v1/config/draft', {
        method: 'PUT',
        body: {
          document: documentValue,
          note: document.querySelector('#draft-note').value.trim(),
          expectedDraftRevisionId: state.config?.draft?.id ?? null,
        },
      });
      document.querySelector('#draft-note').value = '';
      showNotice(`Draft #${revision.id} 已通过文档校验并保存。`);
      markPanelsStale('overview', 'revisions', 'apps', 'agents', 'bindings');
      await loadPanel('config', true);
    });
  } catch (error) {
    showNotice(friendlyError(error), 'error');
  }
}

async function validateDraft(event) {
  const button = event.currentTarget;
  const resultRoot = document.querySelector('#validation-result');
  try {
    const result = await withBusy(button, '校验中…', () => api('/api/admin/v1/draft/validate', {
      method: 'POST',
      body: {},
    }));
    renderValidationResult(resultRoot, result);
  } catch (error) {
    resultRoot.className = 'validation-result error';
    resultRoot.textContent = [404, 405, 501].includes(error.status)
      ? `当前后端尚未提供显式 Draft 校验：${friendlyError(error)}`
      : friendlyError(error);
    resultRoot.hidden = false;
  }
}

function renderValidationResult(root, result) {
  root.replaceChildren();
  const valid = result.valid === true;
  root.className = `validation-result${valid ? '' : ' error'}`;
  root.append(element('strong', { text: valid ? '校验通过' : '校验未通过' }));
  const messages = [
    ...(Array.isArray(result.errors) ? result.errors.map((message) => `错误：${message}`) : []),
    ...(Array.isArray(result.warnings) ? result.warnings.map((message) => `警告：${message}`) : []),
  ];
  if (messages.length) root.append(element('ul', {}, messages.map((message) => element('li', { text: message }))));
  else root.append(element('p', { className: 'muted', text: '服务端未返回错误或警告。' }));
  root.hidden = false;
}

async function publishDraft(event) {
  event.preventDefault();
  if (!state.config?.draft) {
    showNotice('当前没有可发布的 Draft。', 'error');
    return;
  }
  const draftId = state.config.draft.id;
  const confirmed = await askConfirmation({
    title: `发布 Draft #${draftId}`,
    description: '发布会更新 Active revision，并立即尝试应用到运行时。请确认已完成显式校验并了解影响范围。',
    confirmLabel: '确认发布',
    trigger: event.submitter,
    danger: true,
  });
  if (confirmed !== true) return;
  try {
    await withBusy(event.submitter, '发布中…', async () => {
      const revision = await api('/api/admin/v1/config/publish', {
        method: 'POST',
        body: {
          expectedDraftRevisionId: draftId,
          note: document.querySelector('#publish-note').value.trim(),
        },
      });
      document.querySelector('#publish-note').value = '';
      showNotice(`Revision #${revision.id} 已发布为 Active。`);
      markPanelsStale(...Object.keys(PANEL_LOADERS));
      await loadPanel('config', true);
    });
  } catch (error) {
    const runtimeAppliedFailed = error.code === 'runtime_apply_failed';
    showNotice(friendlyError(error), runtimeAppliedFailed ? 'warning' : 'error');
    if (runtimeAppliedFailed) {
      markPanelsStale(...Object.keys(PANEL_LOADERS));
      await loadPanel('config', true);
    }
  }
}

async function loadRevisions() {
  const { items } = await api('/api/admin/v1/revisions?limit=200');
  state.revisions = Array.isArray(items) ? items : [];
  fillTable('#revisions-body', state.revisions.map((item) => [
    `#${item.id}`,
    item.slots?.length ? item.slots.join(', ') : 'history',
    item.createdBy,
    formatTime(item.createdAt),
    item.contentSha256?.slice(0, 12) ?? '—',
    item.note || '—',
    revisionActions(item),
  ]), '暂无 Revision', '保存 Draft 后会在这里出现 revision 历史。');
}

function revisionActions(item) {
  const root = element('div', { className: 'table-actions' });
  root.append(
    tableButton('查看 JSON', 'secondary', { revisionAction: 'view', revisionId: String(item.id) }),
    tableButton('选择回滚', 'danger-outline', { revisionAction: 'rollback', revisionId: String(item.id) }),
  );
  return root;
}

async function handleRevisionAction(event) {
  const button = event.target.closest('[data-revision-action]');
  if (!button) return;
  const id = Number(button.dataset.revisionId);
  if (button.dataset.revisionAction === 'view') {
    try {
      state.revisionTrigger = button;
      await withBusy(button, '读取中…', async () => {
        const revision = await api(`/api/admin/v1/revisions/${id}`);
        showRevisionDetail(revision);
      });
    } catch (error) {
      state.revisionTrigger = null;
      showNotice(friendlyError(error), 'error');
    }
    return;
  }
  const input = document.querySelector('#rollback-id');
  input.value = String(id);
  input.scrollIntoView({ behavior: 'smooth', block: 'center' });
  input.focus();
}

function showRevisionDetail(revision) {
  document.querySelector('#revision-dialog-title').textContent = `Revision #${revision.id}`;
  const detail = document.querySelector('#revision-detail');
  detail.replaceChildren();
  appendDetail(detail, 'Slot', revision.slots?.length ? revision.slots.join(', ') : 'history');
  appendDetail(detail, '创建', `${formatTime(revision.createdAt)} · ${revision.createdBy}`);
  appendDetail(detail, 'Digest', revision.contentSha256 ?? '—');
  appendDetail(detail, '来源', revision.sourceRevisionId ? `#${revision.sourceRevisionId}` : '—');
  appendDetail(detail, '说明', revision.note || '—');
  document.querySelector('#revision-document').textContent = JSON.stringify(revision.document, null, 2);
  revisionDialog.showModal();
  window.requestAnimationFrame(() => revisionDialog.querySelector('[data-dialog-close]').focus());
}

async function rollbackRevision(event) {
  event.preventDefault();
  const revisionId = Number(document.querySelector('#rollback-id').value);
  const confirmed = await askConfirmation({
    title: `回滚到 Revision #${revisionId}`,
    description: '回滚会创建并发布一个新的 Active revision，并立即尝试应用运行时；已有历史不会被覆盖。',
    confirmLabel: '确认发布回滚',
    trigger: event.submitter,
    danger: true,
  });
  if (confirmed !== true) return;
  try {
    await withBusy(event.submitter, '回滚中…', async () => {
      const revision = await api('/api/admin/v1/config/rollback', {
        method: 'POST',
        body: {
          revisionId,
          note: document.querySelector('#rollback-note').value.trim(),
        },
      });
      document.querySelector('#rollback-note').value = '';
      showNotice(`回滚 Revision #${revision.id} 已发布。`);
      markPanelsStale(...Object.keys(PANEL_LOADERS));
      await loadPanel('revisions', true);
    });
  } catch (error) {
    const runtimeAppliedFailed = error.code === 'runtime_apply_failed';
    showNotice(friendlyError(error), runtimeAppliedFailed ? 'warning' : 'error');
    if (runtimeAppliedFailed) {
      markPanelsStale(...Object.keys(PANEL_LOADERS));
      await Promise.all([
        loadPanel('config', true),
        loadPanel('revisions', true),
      ]);
    }
  }
}

async function loadCredentials() {
  const { items } = await api('/api/admin/v1/credentials');
  const credentials = Array.isArray(items) ? items : [];
  fillTable('#credentials-body', credentials.map((item) => [
    item.name,
    item.kind || '—',
    badge(item.configured ? '已配置' : '未配置', item.configured ? '' : 'off'),
    item.fingerprint || '—',
    item.updatedAt ? formatTime(item.updatedAt) : '—',
    credentialActions(item),
  ]), '暂无凭据', '录入凭据后这里只会显示状态和 fingerprint。');
}

function credentialActions(item) {
  const root = element('div', { className: 'table-actions' });
  root.append(
    tableButton('轮换', 'secondary', { credentialAction: 'rotate', credentialName: item.name, credentialKind: item.kind ?? '' }),
    tableButton('删除', 'danger-outline', { credentialAction: 'delete', credentialName: item.name }),
  );
  return root;
}

function handleCredentialAction(event) {
  const button = event.target.closest('[data-credential-action]');
  if (!button) return;
  document.querySelector('#credential-name').value = button.dataset.credentialName;
  if (button.dataset.credentialKind) document.querySelector('#credential-kind').value = button.dataset.credentialKind;
  if (button.dataset.credentialAction === 'rotate') {
    document.querySelector('#credential-value').focus();
    showNotice('已选择凭据；请输入新 Secret 完成轮换。');
  } else {
    void deleteCredential(button);
  }
}

async function saveCredential(event) {
  event.preventDefault();
  const name = document.querySelector('#credential-name').value.trim();
  const kind = document.querySelector('#credential-kind').value.trim();
  const valueInput = document.querySelector('#credential-value');
  const value = valueInput.value;
  valueInput.value = '';
  try {
    await withBusy(event.submitter, '保存中…', async () => {
      const status = await api(`/api/admin/v1/credentials/${encodeURIComponent(name)}`, {
        method: 'PUT',
        body: { kind, value },
      });
      showNotice(`${status.name} 已加密保存${status.fingerprint ? `；fingerprint ${status.fingerprint}` : ''}。`);
      markPanelsStale('overview', 'apps', 'diagnostics');
      await loadPanel('credentials', true);
    });
  } catch (error) {
    showNotice(friendlyError(error), 'error');
  }
}

async function deleteCredential(trigger = document.querySelector('#credential-delete-button')) {
  const name = document.querySelector('#credential-name').value.trim();
  document.querySelector('#credential-value').value = '';
  if (!name) {
    showNotice('请先填写或选择要删除的凭据名称。', 'error');
    return;
  }
  const confirmed = await askConfirmation({
    title: '删除凭据',
    description: `删除 ${name} 后，依赖它的 App 或服务可能无法启动；Active 配置仍引用时服务端会拒绝。`,
    confirmLabel: '确认删除凭据',
    trigger,
    danger: true,
  });
  if (confirmed !== true) return;
  try {
    await withBusy(trigger, '删除中…', async () => {
      await api(`/api/admin/v1/credentials/${encodeURIComponent(name)}`, { method: 'DELETE' });
      showNotice(`${name} 已删除。`);
      markPanelsStale('overview', 'apps', 'diagnostics');
      await loadPanel('credentials', true);
    });
  } catch (error) {
    showNotice(friendlyError(error), 'error');
  }
}

async function loadSessions() {
  const params = new URLSearchParams({ limit: '200' });
  const filters = {
    appKey: document.querySelector('#session-app-filter').value.trim(),
    agentId: document.querySelector('#session-agent-filter').value.trim(),
    bindingId: document.querySelector('#session-binding-filter').value.trim(),
  };
  for (const [name, value] of Object.entries(filters)) {
    if (value) params.set(name, value);
  }
  const { items } = await api(`/api/admin/v1/sessions?${params}`);
  state.sessions = Array.isArray(items) ? items : [];
  fillTable('#sessions-body', state.sessions.map((item) => [
    item.storageId,
    cellStack(item.appKey, item.agentId),
    item.bindingId,
    cellStack(item.conversationKey, item.chatId),
    badge(item.resident ? '驻留' : '非驻留', item.resident ? '' : 'off'),
    formatEpoch(item.lastUsedAt),
    sessionActions(item),
  ]), '暂无会话', '当前筛选范围内没有持久化会话。');
}

function sessionActions(item) {
  const root = element('div', { className: 'table-actions' });
  root.append(
    tableButton('中止运行', 'secondary', { sessionAction: 'abort', storageId: item.storageId }),
    tableButton('重置', 'danger-outline', { sessionAction: 'reset', storageId: item.storageId }),
    tableButton('永久删除', 'danger-outline', { sessionAction: 'delete', storageId: item.storageId }),
  );
  return root;
}

async function handleSessionAction(event) {
  const button = event.target.closest('[data-session-action]');
  if (!button) return;
  const { sessionAction: action, storageId } = button.dataset;
  if (action === 'abort') {
    await operateSession(button, storageId, action);
    return;
  }
  if (action === 'reset') {
    const confirmed = await askConfirmation({
      title: '重置会话',
      description: `重置 ${storageId} 会清理当前运行会话；下一条消息会重新创建。`,
      confirmLabel: '确认重置',
      trigger: button,
      danger: true,
    });
    if (confirmed !== true) return;
    await operateSession(button, storageId, action);
    return;
  }
  const confirmation = await askConfirmation({
    title: '永久删除会话',
    description: `此操作会清理 ${storageId} 的 session 与 workspace 数据。为防止误操作，请输入完整 storageId。`,
    confirmLabel: '永久删除',
    inputLabel: `输入 ${storageId} 以确认`,
    requiredText: storageId,
    trigger: button,
    danger: true,
  });
  if (confirmation !== storageId) return;
  await operateSession(button, storageId, action, confirmation);
}

async function operateSession(button, storageId, action, confirmation) {
  const label = { abort: '中止中…', reset: '重置中…', delete: '删除中…' }[action];
  try {
    const result = await withBusy(button, label, () => api(
      action === 'delete'
        ? `/api/admin/v1/sessions/${encodeURIComponent(storageId)}`
        : `/api/admin/v1/sessions/${encodeURIComponent(storageId)}/${action}`,
      {
        method: action === 'delete' ? 'DELETE' : 'POST',
        body: action === 'delete' ? { confirmation } : {},
      },
    ));
    showNotice(result.operated
      ? `会话 ${storageId} 已执行${{ abort: '中止', reset: '重置', delete: '永久删除' }[action]}。`
      : `会话 ${storageId} 当前没有可中止的驻留运行。`, result.operated ? 'success' : 'warning');
    await loadPanel('sessions', true);
  } catch (error) {
    showNotice(friendlyError(error), 'error');
  }
}

async function loadApprovals() {
  const params = new URLSearchParams({ limit: '200' });
  const approvalState = document.querySelector('#approval-state-filter').value;
  if (approvalState) params.set('state', approvalState);
  const { items } = await api(`/api/admin/v1/approvals?${params}`);
  state.approvals = Array.isArray(items) ? items : [];
  fillTable('#approvals-body', state.approvals.map((item) => [
    cellStack(item.id, item.approval),
    approvalStateBadge(item.state),
    cellStack(item.appKey, `${item.agentId} · ${item.bindingId}`),
    cellStack(item.operation, item.effect),
    item.requesterOpenId,
    formatEpoch(item.expiresAt),
    approvalActions(item),
  ]), '暂无审批', '当前筛选范围内没有工具审批记录。');
}

function approvalActions(item) {
  const root = element('div', { className: 'table-actions' });
  if (item.state === 'pending' && item.approval === 'admin') {
    root.append(
      tableButton('批准', 'secondary', { approvalAction: 'approve', approvalId: item.id }),
      tableButton('拒绝', 'danger-outline', { approvalAction: 'deny', approvalId: item.id }),
    );
  } else if (item.state === 'pending') {
    root.append(tableButton('由请求者在飞书处理', 'ghost', {}, true));
  } else {
    root.append(element('span', { className: 'muted', text: item.approverOpenId ? `处理人：${item.approverOpenId}` : '已结束' }));
  }
  return root;
}

async function handleApprovalAction(event) {
  const button = event.target.closest('[data-approval-action]');
  if (!button) return;
  const { approvalAction: decision, approvalId: id } = button.dataset;
  const approval = state.approvals.find((item) => item.id === id);
  if (!approval) {
    showNotice('审批状态已变化，请刷新后重试。', 'error');
    return;
  }
  const approving = decision === 'approve';
  const confirmed = await askConfirmation({
    title: `${approving ? '批准' : '拒绝'}管理员审批`,
    description: `${approval.operation}（${approval.effect}）· ${approval.appKey}/${approval.agentId}。${approving ? '批准后运行时会继续执行待审批操作。' : '拒绝后本次待审批操作不会执行。'}`,
    confirmLabel: `确认${approving ? '批准' : '拒绝'}`,
    trigger: button,
    danger: true,
  });
  if (confirmed !== true) return;
  try {
    await withBusy(button, '处理中…', () => api(
      `/api/admin/v1/approvals/${encodeURIComponent(id)}/${decision}`,
      { method: 'POST', body: {} },
    ));
    showNotice(`审批 ${id} 已${approving ? '批准' : '拒绝'}。`);
    markPanelsStale('audit');
    await loadPanel('approvals', true);
  } catch (error) {
    showNotice(friendlyError(error), 'error');
  }
}

async function loadDiagnostics() {
  const { items } = await api('/api/admin/v1/diagnostics/lark-cli');
  const diagnostics = Array.isArray(items) ? items : [];
  fillTable('#diagnostics-body', diagnostics.map((item) => [
    item.appKey,
    cellStack(item.bindingId, item.agentId),
    enabledBadge(item.enabled),
    badge(item.initialized ? '已初始化' : '未初始化', item.initialized ? '' : 'off'),
    cellStack(item.actualVersion || '未检测', `期望 ${item.expectedVersion}`),
    diagnosticReadiness(item),
    item.error || '—',
  ]), '暂无 lark-cli 诊断项', 'Active 配置中没有启用的 Binding，或尚未配置 lark-cli。');
}

function diagnosticReadiness(item) {
  const root = element('div', { className: 'cell-stack' });
  root.append(badge(item.ready ? '运行时就绪' : '未就绪', item.ready ? '' : 'error'));
  root.append(element('small', {
    text: `读 ${item.readOperations ?? '—'} · 写 ${item.writeOperations ?? '—'} · 高风险 ${item.highRiskOperations ?? '—'}`,
  }));
  root.append(element('small', {
    text: `审批回调 ${item.approvalCallbackConfigured ? '已配置 HTTP' : '未配置 HTTP'} · ${item.approvalCallbackReady ? '运行时可用' : '运行时不可用'}`,
  }));
  return root;
}

async function loadAudit() {
  const { items } = await api('/api/admin/v1/audit?limit=200');
  const audit = Array.isArray(items) ? items : [];
  fillTable('#audit-body', audit.map((item) => [
    `#${item.id}`,
    formatTime(item.occurredAt),
    item.actor,
    item.action,
    `${item.entityType}${item.entityId ? ` / ${item.entityId}` : ''}`,
    element('span', { className: 'code-cell', text: JSON.stringify(item.details) }),
  ]), '暂无审计记录', '管理写操作完成后会在这里留下服务端审计记录。');
}

async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (state.csrfToken && !['GET', 'HEAD'].includes(method)) {
    headers['x-csrf-token'] = state.csrfToken;
  }
  const response = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    error.code = data.error;
    throw error;
  }
  return data;
}

function setPanelStatus(name, mode, message = '') {
  const panel = document.querySelector(`[data-panel="${name}"]`);
  const status = document.querySelector(`[data-panel-status="${name}"]`);
  const content = document.querySelector(`[data-panel-content="${name}"]`);
  if (!panel || !status) return;
  panel.setAttribute('aria-busy', mode === 'loading' ? 'true' : 'false');
  status.className = `panel-status${mode === 'ready' ? '' : ` ${mode}`}`;
  if (mode === 'ready') {
    status.hidden = true;
    if (content) content.hidden = false;
    return;
  }
  status.replaceChildren(element('span', { text: message }));
  if (mode === 'error' || mode === 'unsupported') {
    const retry = element('button', { className: 'button ghost', text: '重试', attrs: { type: 'button' } });
    retry.addEventListener('click', () => void loadPanel(name, true));
    status.append(retry);
  }
  status.hidden = false;
  if (content && !state.loadedPanels.has(name)) content.hidden = mode !== 'ready';
}

function markPanelsStale(...names) {
  for (const name of names) state.loadedPanels.delete(name);
}

function fillTable(selector, rows, emptyTitle = '暂无数据', emptyDescription = '') {
  const body = document.querySelector(selector);
  const headers = [...body.closest('table').querySelectorAll('thead th')].map((header) => header.textContent.trim());
  if (!rows.length) {
    const content = element('div', {}, [element('strong', { text: emptyTitle })]);
    if (emptyDescription) content.append(element('span', { text: emptyDescription }));
    const cell = element('td', { className: 'empty-cell' }, [content]);
    cell.colSpan = headers.length;
    body.replaceChildren(element('tr', { className: 'empty-row' }, [cell]));
    return;
  }
  body.replaceChildren(...rows.map((cells) => element('tr', {}, cells.map((cell, index) => {
    const td = document.createElement('td');
    td.dataset.label = headers[index] ?? '';
    if (cell instanceof Node) td.append(cell);
    else td.textContent = String(cell ?? '—');
    return td;
  }))));
}

function actionButton(text, action, kind, id, style = 'ghost') {
  return tableButton(text, style, {
    resourceAction: action,
    kind,
    id,
  });
}

function tableButton(text, style, dataset = {}, disabled = false) {
  return element('button', {
    className: `button ${style}`,
    text,
    attrs: { type: 'button' },
    dataset,
    disabled,
  });
}

function enabledBadge(enabled) {
  return badge(enabled ? '启用' : '停用', enabled ? '' : 'off');
}

function approvalStateBadge(value) {
  const style = value === 'pending' ? 'warn' : value === 'approved' ? '' : value === 'denied' ? 'error' : 'off';
  return badge(value, style);
}

function badge(text, style = '') {
  return element('span', { className: `badge${style ? ` ${style}` : ''}`, text });
}

function cellStack(primary, secondary) {
  return element('span', { className: 'cell-stack' }, [
    element('span', { text: String(primary ?? '—') }),
    element('small', { text: String(secondary ?? '—') }),
  ]);
}

function appendDetail(root, term, description) {
  root.append(element('dt', { text: term }), element('dd', { text: description }));
}

function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) node.setAttribute(name, value);
  }
  if (options.dataset) {
    for (const [name, value] of Object.entries(options.dataset)) node.dataset[name] = value;
  }
  if (options.disabled) node.disabled = true;
  node.append(...children);
  return node;
}

function populateAppKeyOptions(items) {
  const options = items
    .filter((item) => typeof item.id === 'string')
    .map((item) => element('option', { attrs: { value: item.id } }));
  document.querySelector('#app-key-options').replaceChildren(...options);
}

function setLoginStatus(message, type = '') {
  const root = document.querySelector('#login-status');
  root.textContent = message;
  root.classList.toggle('error', type === 'error');
}

function showNotice(message, type = 'success') {
  notice.textContent = message;
  notice.className = `notice${type === 'error' ? ' error' : type === 'warning' ? ' warning' : ''}`;
  notice.hidden = false;
  window.clearTimeout(showNotice.timer);
  showNotice.timer = window.setTimeout(() => { notice.hidden = true; }, 8000);
}

function friendlyError(error) {
  if (error?.message) return error.message;
  return '请求未完成，请检查服务状态后重试。';
}

async function withBusy(button, busyLabel, operation) {
  if (!button) return await operation();
  const original = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = busyLabel;
  try {
    return await operation();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = original;
  }
}

function askConfirmation(options) {
  settleConfirmation(false);
  return new Promise((resolve) => {
    state.confirmation = { ...options, resolve };
    document.querySelector('#confirm-dialog-title').textContent = options.title;
    document.querySelector('#confirm-dialog-description').textContent = options.description;
    const inputWrap = document.querySelector('#confirm-input-wrap');
    const input = document.querySelector('#confirm-input');
    const needsInput = Boolean(options.requiredText || options.requireValue);
    inputWrap.hidden = !needsInput;
    input.required = needsInput;
    input.value = '';
    input.placeholder = options.requiredText ?? '';
    document.querySelector('#confirm-input-label').textContent = options.inputLabel || '确认值';
    document.querySelector('#confirm-error').hidden = true;
    const submit = document.querySelector('#confirm-submit');
    submit.textContent = options.confirmLabel || '确认';
    submit.className = `button ${options.danger === false ? 'primary' : 'danger'}`;
    confirmDialog.showModal();
    window.requestAnimationFrame(() => (needsInput ? input : submit).focus());
  });
}

function submitConfirmation(event) {
  event.preventDefault();
  const pending = state.confirmation;
  if (!pending) return;
  const input = document.querySelector('#confirm-input');
  const value = input.value.trim();
  const error = document.querySelector('#confirm-error');
  if (pending.requiredText && value !== pending.requiredText) {
    error.textContent = `确认值不匹配，请完整输入 ${pending.requiredText}。`;
    error.hidden = false;
    input.focus();
    return;
  }
  if (pending.requireValue && !value) {
    error.textContent = '该字段必填。';
    error.hidden = false;
    input.focus();
    return;
  }
  settleConfirmation(pending.requiredText || pending.requireValue ? value : true);
}

function settleConfirmation(result) {
  const pending = state.confirmation;
  if (!pending) {
    if (confirmDialog.open) confirmDialog.close();
    return;
  }
  state.confirmation = null;
  if (confirmDialog.open) confirmDialog.close();
  pending.resolve(result);
  pending.trigger?.focus();
}

function closeNamedDialog(name) {
  if (name === 'entity-dialog') closeEntityEditor();
  else if (name === 'revision-dialog') closeRevisionDialog();
}

function closeRevisionDialog() {
  const trigger = state.revisionTrigger;
  state.revisionTrigger = null;
  if (revisionDialog.open) revisionDialog.close();
  trigger?.focus();
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value ?? '—') : date.toLocaleString('zh-CN', { hour12: false });
}

function formatEpoch(value) {
  if (typeof value !== 'number') return formatTime(value);
  return formatTime(value < 1_000_000_000_000 ? value * 1000 : value);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
