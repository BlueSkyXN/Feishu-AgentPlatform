import assert from 'node:assert/strict';
import test from 'node:test';

import type { HostConfig, PlatformConfig } from '../src/config/types.js';
import { assertDeploymentConstraints } from '../src/config/validate-deployment.js';

test('deployment validation requires the Host broker and compatible public ingress', () => {
  const platform = {
    apps: [
      {
        events: { transport: 'websocket' },
        callbacks: { transport: 'http' },
        oauth: { enabled: false },
      },
    ],
    agents: [{ id: 'general', runtime: { isolation: 'process' } }],
    bindings: [{}],
  } as unknown as PlatformConfig;
  const host = {
    publicHttp: { enabled: true, host: '0.0.0.0' },
    modelBroker: { enabled: true },
    isHuggingFaceSpace: false,
  } as unknown as HostConfig;

  assert.doesNotThrow(() => assertDeploymentConstraints(platform, host));
  assert.throws(
    () =>
      assertDeploymentConstraints(platform, {
        ...host,
        modelBroker: { ...host.modelBroker, enabled: false },
      }),
    /MODEL_BROKER_ENABLED=true/,
  );
  assert.throws(
    () =>
      assertDeploymentConstraints(platform, {
        ...host,
        publicHttp: { ...host.publicHttp, enabled: false },
      }),
    /PUBLIC_HTTP_ENABLED=false/,
  );
});

test('Hugging Face deployment requires process-isolated Agents', () => {
  const platform = {
    apps: [
      {
        events: { transport: 'websocket' },
        callbacks: { transport: 'disabled' },
        oauth: { enabled: false },
      },
    ],
    agents: [{ id: 'inline', runtime: { isolation: 'in-process' } }],
    bindings: [{}],
  } as unknown as PlatformConfig;
  const host = {
    publicHttp: { enabled: true, host: '0.0.0.0' },
    modelBroker: { enabled: true },
    isHuggingFaceSpace: true,
  } as unknown as HostConfig;

  assert.throws(
    () => assertDeploymentConstraints(platform, host),
    /runtime\.isolation=process/,
  );
});
