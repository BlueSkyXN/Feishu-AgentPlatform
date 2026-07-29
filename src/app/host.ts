import { mkdir } from 'node:fs/promises';

import {
  APP_VERSION,
  resolveBindingConfig,
  type HostConfig,
  type LoadedAppAgentBinding,
  type LoadedFeishuApp,
  type PlatformConfig,
} from '../config/types.js';
import { assertDeploymentConstraints } from '../config/validate-deployment.js';
import { Logger, errorFields } from '../core/logger.js';
import { MetricsRegistry } from '../core/metrics.js';
import { Semaphore } from '../core/semaphore.js';
import { belongsToShard } from '../core/sharding.js';
import {
  FeishuAppRuntime,
  type FeishuChannelFactory,
} from '../feishu/app-runtime.js';
import {
  InternalControlServer,
  PublicIngressServer,
  type AppAssignmentSnapshot,
  type ControlPlaneBackend,
  type HostSnapshot,
  type PublicAdminRouter,
} from '../http/control-plane.js';
import { HostModelBroker } from '../model/model-broker.js';
import {
  ConcurrentWorkerStartLimiter,
  GlobalResidentRuntimeCoordinator,
} from '../pi/runtime-capacity.js';
import { assertModelProviderPolicy } from '../pi/model-env.js';
import type { PersistentSessionIndex } from '../storage/session-index.js';
import type { ToolApprovalStore } from '../storage/approval-store.js';
import {
  AppLeaseStore,
  type AppRuntimeLease,
} from '../storage/app-lease-store.js';
import { PlatformDatabase } from '../storage/database.js';

interface AppAssignmentState extends AppAssignmentSnapshot {
  config: LoadedFeishuApp;
}

export interface PlatformHostServices {
  sessionIndex?: PersistentSessionIndex;
  approvalStore?: ToolApprovalStore;
  appLeaseStore?: AppLeaseStore;
  channelFactory?: FeishuChannelFactory;
}

export class PlatformHost implements ControlPlaneBackend {
  private readonly apps = new Map<string, FeishuAppRuntime>();
  private readonly leases = new Map<string, AppRuntimeLease>();
  private readonly desiredApps = new Map<string, LoadedFeishuApp>();
  private readonly assignments = new Map<string, AppAssignmentState>();
  private readonly startingApps = new Set<string>();
  private readonly bindingsByApp = new Map<string, LoadedAppAgentBinding[]>();
  private readonly logger: Logger;
  private readonly metrics = new MetricsRegistry();
  private readonly globalSemaphore: Semaphore;
  private readonly publicServer: PublicIngressServer;
  private readonly internalServer: InternalControlServer;
  private readonly modelBroker: HostModelBroker;
  private readonly workerStartLimiter: ConcurrentWorkerStartLimiter;
  private readonly residentCoordinator: GlobalResidentRuntimeCoordinator;
  private readonly appLeaseStore: AppLeaseStore;
  private readonly ownedLeaseDatabase: PlatformDatabase | undefined;
  private maintenanceTimer: NodeJS.Timeout | undefined;
  private reconcilePromise: Promise<void> | undefined;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private platform: PlatformConfig = { apps: [], agents: [], bindings: [] };
  private activeRevisionId: number | undefined;
  private startedAt = Date.now();
  private skippedByShard = 0;
  private started = false;
  private stopping = false;

  constructor(
    private readonly hostConfig: HostConfig,
    private readonly services: PlatformHostServices = {},
  ) {
    this.logger = new Logger({
      service: 'feishu-agent-platform',
      version: APP_VERSION,
      instanceId: hostConfig.instanceId,
    });
    this.globalSemaphore = new Semaphore(hostConfig.maxConcurrentTurnsGlobal);
    this.publicServer = new PublicIngressServer(
      hostConfig.publicHttp,
      this,
      this.logger,
    );
    this.internalServer = new InternalControlServer(
      hostConfig.internalHttp,
      this,
      this.metrics,
      this.logger,
    );
    this.modelBroker = new HostModelBroker(
      hostConfig.modelBroker,
      this.logger.child({ component: 'host-model-broker' }),
    );
    this.workerStartLimiter = new ConcurrentWorkerStartLimiter(
      hostConfig.maxConcurrentWorkerStarts,
    );
    this.residentCoordinator = new GlobalResidentRuntimeCoordinator(
      hostConfig.maxResidentPiWorkers,
    );
    if (services.appLeaseStore) {
      this.appLeaseStore = services.appLeaseStore;
      this.ownedLeaseDatabase = undefined;
    } else {
      this.ownedLeaseDatabase = new PlatformDatabase(hostConfig.databasePath);
      this.appLeaseStore = new AppLeaseStore(this.ownedLeaseDatabase);
    }
  }

  async start(platform: PlatformConfig, activeRevisionId?: number): Promise<void> {
    if (this.started || this.desiredApps.size > 0) {
      throw new Error('Platform Host is already started or starting.');
    }
    this.platform = platform;
    this.activeRevisionId = activeRevisionId;
    this.stopping = false;
    this.startedAt = Date.now();
    this.skippedByShard = 0;
    assertDeploymentConstraints(platform, this.hostConfig);
    await mkdir(this.hostConfig.dataRoot, { recursive: true, mode: 0o700 });

    for (const binding of platform.bindings) {
      assertModelProviderPolicy(
        resolveBindingConfig(binding),
        this.hostConfig.modelProviderPolicy,
      );
      const current = this.bindingsByApp.get(binding.app) ?? [];
      current.push(binding);
      this.bindingsByApp.set(binding.app, current);
    }
    for (const app of platform.apps) {
      if (
        !belongsToShard(
          app.id,
          this.hostConfig.shard.index,
          this.hostConfig.shard.count,
        )
      ) {
        this.skippedByShard += 1;
        continue;
      }
      this.desiredApps.set(app.id, app);
      this.assignments.set(app.id, {
        id: app.id,
        state: 'pending',
        changedAt: Date.now(),
        config: app,
      });
    }

    this.metrics.setGauge(
      'feishu_agent_platform_info',
      'Static Host identity metric.',
      {
        instance: this.hostConfig.instanceId,
        version: APP_VERSION,
        shard_index: this.hostConfig.shard.index,
        shard_count: this.hostConfig.shard.count,
      },
      1,
    );
    try {
      await this.modelBroker.start(this.desiredApps.size > 0);
      await Promise.all([this.publicServer.start(), this.internalServer.start()]);
      await this.reconcileApps();
      this.started = true;
      this.maintenanceTimer = setInterval(() => {
        void this.runMaintenance().catch((error: unknown) => {
          this.logger.error('Host maintenance failed', errorFields(error));
        });
      }, this.hostConfig.maintenanceIntervalMs);
      this.maintenanceTimer.unref();
      this.updateHostMetrics();
    } catch (error) {
      await this.stopAfterFailedStart();
      throw error;
    }
    this.logger.info('Feishu Agent Platform started', {
      activeApps: this.apps.size,
      assignedApps: this.desiredApps.size,
      configuredApps: platform.apps.length,
      configuredAgents: platform.agents.length,
      configuredBindings: platform.bindings.length,
      skippedByShard: this.skippedByShard,
      modelBroker: this.modelBroker.snapshot(),
    });
  }

  mountAdmin(router: PublicAdminRouter): void {
    if (this.started) throw new Error('Admin router must be mounted before Host startup.');
    this.publicServer.mountAdmin(router);
  }

  async applyPlatformConfig(
    platform: PlatformConfig,
    activeRevisionId?: number,
  ): Promise<void> {
    return await this.runLifecycleOperation(
      () => this.doApplyPlatformConfig(platform, activeRevisionId),
    );
  }

  private async doApplyPlatformConfig(
    platform: PlatformConfig,
    activeRevisionId?: number,
  ): Promise<void> {
    if (!this.started || this.stopping) {
      throw new Error('Platform Host must be running before configuration can be applied.');
    }
    assertDeploymentConstraints(platform, this.hostConfig);
    for (const binding of platform.bindings) {
      assertModelProviderPolicy(
        resolveBindingConfig(binding),
        this.hostConfig.modelProviderPolicy,
      );
    }

    const nextBindingsByApp = groupBindingsByApp(platform.bindings);
    const nextDesired = new Map<string, LoadedFeishuApp>();
    for (const app of platform.apps) {
      if (
        belongsToShard(
          app.id,
          this.hostConfig.shard.index,
          this.hostConfig.shard.count,
        )
      ) {
        nextDesired.set(app.id, app);
      }
    }
    const changed = new Set<string>();
    for (const appKey of new Set([...this.desiredApps.keys(), ...nextDesired.keys()])) {
      const currentApp = this.desiredApps.get(appKey);
      const nextApp = nextDesired.get(appKey);
      if (
        !currentApp ||
        !nextApp ||
        runtimeSignature(currentApp, this.bindingsByApp.get(appKey) ?? []) !==
          runtimeSignature(nextApp, nextBindingsByApp.get(appKey) ?? [])
      ) {
        changed.add(appKey);
      }
    }

    await Promise.all(
      [...changed].map(async (appKey) => {
        const runtime = this.apps.get(appKey);
        const lease = this.leases.get(appKey);
        this.apps.delete(appKey);
        this.leases.delete(appKey);
        try {
          await runtime?.stop();
        } finally {
          await lease?.release();
        }
      }),
    );

    this.platform = platform;
    this.activeRevisionId = activeRevisionId;
    this.skippedByShard = platform.apps.length - nextDesired.size;
    this.bindingsByApp.clear();
    for (const [appKey, bindings] of nextBindingsByApp) {
      this.bindingsByApp.set(appKey, bindings);
    }
    this.desiredApps.clear();
    for (const [appKey, app] of nextDesired) this.desiredApps.set(appKey, app);
    for (const appKey of [...this.assignments.keys()]) {
      if (!nextDesired.has(appKey)) this.assignments.delete(appKey);
    }
    for (const [appKey, app] of nextDesired) {
      if (!changed.has(appKey) && this.assignments.has(appKey)) continue;
      this.assignments.set(appKey, {
        id: appKey,
        state: 'pending',
        changedAt: Date.now(),
        config: app,
      });
    }
    await this.modelBroker.start(nextDesired.size > 0);
    await this.reconcileApps();
    this.updateHostMetrics();
    const failedChangedApps = [...changed]
      .filter((appKey) => this.assignments.get(appKey)?.state === 'failed')
      .sort();
    if (failedChangedApps.length > 0) {
      throw new Error(
        `Published configuration could not start changed App runtimes: ${failedChangedApps.join(', ')}`,
      );
    }
    this.logger.info('Published platform configuration applied', {
      activeRevisionId,
      changedApps: [...changed].sort(),
      configuredApps: platform.apps.length,
      configuredAgents: platform.agents.length,
      configuredBindings: platform.bindings.length,
    });
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.started = false;
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = undefined;
    await this.lifecycleTail.catch(() => undefined);
    await this.reconcilePromise?.catch(() => undefined);
    await Promise.allSettled([this.publicServer.stop(), this.internalServer.stop()]);
    const runtimes = [...this.apps.values()];
    this.apps.clear();
    await Promise.allSettled(runtimes.map((runtime) => runtime.stop()));
    await this.modelBroker.stop();
    await this.releaseAllLeases();
    this.startingApps.clear();
    this.desiredApps.clear();
    this.assignments.clear();
    this.bindingsByApp.clear();
    this.stopping = false;
    this.updateHostMetrics();
    this.ownedLeaseDatabase?.close();
    this.logger.info('Feishu Agent Platform stopped');
  }

  snapshot(): HostSnapshot {
    const appSnapshots = this.listApps().map((app) => app.snapshot());
    return {
      version: APP_VERSION,
      instanceId: this.hostConfig.instanceId,
      startedAt: this.startedAt,
      setupRequired: this.platform.apps.length === 0,
      ...(this.activeRevisionId === undefined
        ? {}
        : { activeRevisionId: this.activeRevisionId }),
      ready:
        this.started &&
        !this.stopping &&
        this.failedAppCount() === 0 &&
        appSnapshots.every((app) => app.ready) &&
        (!this.hostConfig.modelBroker.enabled || this.modelBroker.snapshot().started),
      configuredApps: this.platform.apps.length,
      configuredAgents: this.platform.agents.length,
      configuredBindings: this.platform.bindings.length,
      assignedApps: this.desiredApps.size,
      activeApps: this.apps.size,
      skippedByShard: this.skippedByShard,
      waitingForLease: this.waitingForLeaseCount(),
      failedApps: this.failedAppCount(),
      shard: { ...this.hostConfig.shard },
      globalConcurrency: {
        capacity: this.globalSemaphore.capacity,
        inUse: this.globalSemaphore.inUse,
        waiting: this.globalSemaphore.waiting,
      },
      runtimeCapacity: {
        residentWorkers: this.residentCoordinator.residentCount,
        residentWorkerLimit: this.residentCoordinator.capacity,
        pendingResidentWorkers: this.residentCoordinator.waitingCount,
        workerStartsInUse: this.workerStartLimiter.inUse,
        workerStartLimit: this.workerStartLimiter.capacity,
        workerStartsWaiting: this.workerStartLimiter.waiting,
      },
      modelBroker: this.modelBroker.snapshot(),
      assignments: [...this.assignments.values()]
        .map(({ config: _config, ...state }) => ({ ...state }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      apps: appSnapshots,
      agents: this.platform.agents.map((agent) => ({
        id: agent.id,
        provider: agent.provider,
        model: agent.model,
        modelApi: agent.modelApi,
        runtimeIsolation: agent.runtime.isolation,
        workspaceMode: agent.workspace.mode,
        feishuTools: [...agent.tools.feishu],
        workspaceTools: [...agent.tools.workspace],
      })),
      bindings: this.platform.bindings.map((binding) => ({
        id: binding.id,
        app: binding.app,
        agent: binding.agent,
        route: { ...binding.route },
        conversationScope: binding.conversation.scope,
      })),
    };
  }

  getApp(id: string): FeishuAppRuntime | undefined {
    return this.apps.get(id);
  }

  listApps(): FeishuAppRuntime[] {
    return [...this.apps.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  private runMaintenance(): Promise<void> {
    return this.runLifecycleOperation(() => this.doRunMaintenance());
  }

  private async doRunMaintenance(): Promise<void> {
    if (this.stopping || !this.started) return;
    for (const [appKey, runtime] of [...this.apps.entries()]) {
      const lease = this.leases.get(appKey);
      if (!lease?.isAcquired) {
        this.logger.error('App lease was lost; stopping runtime', { appKey });
        this.apps.delete(appKey);
        this.leases.delete(appKey);
        this.setAssignment(appKey, 'pending', 'Lease ownership was lost.');
        await Promise.allSettled([
          runtime.stop(),
          lease?.release() ?? Promise.resolve(),
        ]);
        continue;
      }
      await runtime.maintenance().catch((error: unknown) => {
        this.logger.warn('AppRuntime maintenance failed', {
          appKey,
          ...errorFields(error),
        });
      });
    }
    await this.reconcileApps();
    this.updateHostMetrics();
  }

  private runLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async reconcileApps(): Promise<void> {
    if (this.stopping) return;
    if (this.reconcilePromise) return await this.reconcilePromise;
    const operation = this.doReconcileApps();
    this.reconcilePromise = operation;
    try {
      await operation;
    } finally {
      if (this.reconcilePromise === operation) this.reconcilePromise = undefined;
    }
  }

  private async doReconcileApps(): Promise<void> {
    const candidates = [...this.desiredApps.values()].filter(
      (app) => !this.apps.has(app.id) && !this.startingApps.has(app.id),
    );
    await Promise.allSettled(candidates.map((app) => this.tryStartApp(app)));
  }

  private async tryStartApp(app: LoadedFeishuApp): Promise<void> {
    this.startingApps.add(app.id);
    const lease = this.appLeaseStore.create({
      key: `feishu-app:${app.appId}`,
      ownerId: this.hostConfig.instanceId,
      ttlMs: this.hostConfig.lease.ttlMs,
      heartbeatMs: this.hostConfig.lease.heartbeatMs,
    });
    try {
      if (!(await lease.acquire())) {
        this.setAssignment(app.id, 'standby', 'Another instance owns the App lease.');
        return;
      }
      if (this.stopping) {
        await lease.release();
        return;
      }
      const runtime = new FeishuAppRuntime(
        app,
        this.bindingsByApp.get(app.id) ?? [],
        this.logger,
        this.metrics,
        this.globalSemaphore,
        this.modelBroker,
        {
          adminOpenIds: this.hostConfig.adminOpenIds,
          approvalTtlMs: this.hostConfig.approvalTtlMs,
          workerStartLimiter: this.workerStartLimiter,
          residentCoordinator: this.residentCoordinator,
          ...(this.services.sessionIndex
            ? { sessionIndex: this.services.sessionIndex }
            : {}),
          ...(this.services.approvalStore
            ? { approvalStore: this.services.approvalStore }
            : {}),
          ...(this.services.channelFactory
            ? { channelFactory: this.services.channelFactory }
            : {}),
        },
      );
      try {
        await runtime.start();
      } catch (error) {
        await lease.release();
        throw error;
      }
      this.leases.set(app.id, lease);
      this.apps.set(app.id, runtime);
      this.setAssignment(app.id, 'running');
    } catch (error) {
      this.setAssignment(app.id, 'failed', errorText(error));
      this.logger.error('Failed to start Feishu AppRuntime', {
        appKey: app.id,
        ...errorFields(error),
      });
    } finally {
      this.startingApps.delete(app.id);
    }
  }

  private setAssignment(
    appKey: string,
    state: AppAssignmentSnapshot['state'],
    reason?: string,
  ): void {
    const config = this.desiredApps.get(appKey);
    if (!config) return;
    this.assignments.set(appKey, {
      id: appKey,
      state,
      ...(reason ? { reason } : {}),
      changedAt: Date.now(),
      config,
    });
  }

  private waitingForLeaseCount(): number {
    return [...this.assignments.values()].filter((item) => item.state === 'standby')
      .length;
  }

  private failedAppCount(): number {
    return [...this.assignments.values()].filter((item) => item.state === 'failed')
      .length;
  }

  private async releaseAllLeases(): Promise<void> {
    const leases = [...this.leases.values()];
    this.leases.clear();
    await Promise.allSettled(leases.map((lease) => lease.release()));
  }

  private updateHostMetrics(): void {
    this.metrics.setGauge(
      'feishu_agent_active_apps',
      'Active Feishu AppRuntime instances.',
      {},
      this.apps.size,
    );
    this.metrics.setGauge(
      'feishu_agent_failed_apps',
      'App runtimes in failed assignment state.',
      {},
      this.failedAppCount(),
    );
    this.metrics.setGauge(
      'feishu_agent_global_turns_active',
      'Global turn concurrency slots currently in use.',
      {},
      this.globalSemaphore.inUse,
    );
  }

  private async stopAfterFailedStart(): Promise<void> {
    await Promise.allSettled([this.publicServer.stop(), this.internalServer.stop()]);
    const runtimes = [...this.apps.values()];
    this.apps.clear();
    await Promise.allSettled(runtimes.map((runtime) => runtime.stop()));
    await this.modelBroker.stop();
    await this.releaseAllLeases();
    this.desiredApps.clear();
    this.assignments.clear();
    this.bindingsByApp.clear();
    this.ownedLeaseDatabase?.close();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function groupBindingsByApp(
  bindings: LoadedAppAgentBinding[],
): Map<string, LoadedAppAgentBinding[]> {
  const grouped = new Map<string, LoadedAppAgentBinding[]>();
  for (const binding of bindings) {
    const current = grouped.get(binding.app) ?? [];
    current.push(binding);
    grouped.set(binding.app, current);
  }
  return grouped;
}

function runtimeSignature(
  app: LoadedFeishuApp,
  bindings: LoadedAppAgentBinding[],
): string {
  return JSON.stringify({
    app,
    bindings: [...bindings]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((binding) => ({
        id: binding.id,
        route: binding.route,
        conversation: binding.conversation,
        agent: binding.agentDefinition,
      })),
  });
}
