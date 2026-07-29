import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { AdminAuthService } from '../src/admin/auth-service.js';
import { AdminServer } from '../src/admin/admin-server.js';
import type { AdminBackend } from '../src/admin/contracts.js';
import { Logger } from '../src/core/logger.js';
import {
  PublicIngressServer,
  type ControlPlaneBackend,
  type HostSnapshot,
} from '../src/http/control-plane.js';

test('public ingress mounts setup Admin UI and reports setup_required as ready', async () => {
  const backend: ControlPlaneBackend = {
    snapshot: () => setupSnapshot(),
    getApp: () => undefined,
    listApps: () => [],
  };
  const publicServer = new PublicIngressServer(
    { enabled: true, host: '127.0.0.1', port: 0, bodyLimitBytes: 64 * 1024 },
    backend,
    new Logger({ service: 'public-admin-test' }),
  );
  const admin = new AdminServer({
    host: '127.0.0.1',
    port: 0,
    bodyLimitBytes: 64 * 1024,
    staticRoot: resolve('web'),
    auth: new AdminAuthService({
      bootstrapToken: 'admin-token-at-least-sixteen-characters',
    }),
    backend: {} as AdminBackend,
  });
  publicServer.mountAdmin(admin);
  await publicServer.start();
  const baseUrl = `http://127.0.0.1:${publicServer.address().port}`;
  try {
    const page = await fetch(`${baseUrl}/admin`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /平台控制台/);
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    const ready = await fetch(`${baseUrl}/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), {
      status: 'setup_required',
      activeApps: 0,
      failedApps: 0,
    });
  } finally {
    await publicServer.stop();
  }
});

function setupSnapshot(): HostSnapshot {
  return {
    version: '0.1.0',
    instanceId: 'test',
    startedAt: Date.now(),
    ready: true,
    setupRequired: true,
    configuredApps: 0,
    configuredAgents: 0,
    configuredBindings: 0,
    assignedApps: 0,
    activeApps: 0,
    skippedByShard: 0,
    waitingForLease: 0,
    failedApps: 0,
    shard: { index: 0, count: 1 },
    globalConcurrency: { capacity: 16, inUse: 0, waiting: 0 },
    runtimeCapacity: {
      residentWorkers: 0,
      residentWorkerLimit: 24,
      pendingResidentWorkers: 0,
      workerStartsInUse: 0,
      workerStartLimit: 4,
      workerStartsWaiting: 0,
    },
    modelBroker: {
      enabled: false,
      started: false,
      activeCapabilities: 0,
      upstreamConfigured: false,
    },
    assignments: [],
    apps: [],
    agents: [],
    bindings: [],
  };
}
