import type { HostConfig, PlatformConfig } from './types.js';

export function assertDeploymentConstraints(
  platform: PlatformConfig,
  host: HostConfig,
): void {
  if (platform.apps.length === 0) {
    if (!host.publicHttp.enabled) {
      throw new Error('Setup mode requires PUBLIC_HTTP_ENABLED=true for the management console.');
    }
    return;
  }
  const needsPublicIngress = platform.apps.some(
    (app) =>
      app.events.transport === 'http' ||
      app.callbacks.transport === 'http' ||
      app.oauth.enabled,
  );
  if (needsPublicIngress && !host.publicHttp.enabled) {
    throw new Error(
      'PUBLIC_HTTP_ENABLED=false is incompatible with HTTP Feishu ingress or OAuth callbacks.',
    );
  }
  if (
    host.isHuggingFaceSpace &&
    needsPublicIngress &&
    isLoopback(host.publicHttp.host)
  ) {
    throw new Error('Hugging Face public ingress must listen on a non-loopback host.');
  }
  if (host.isHuggingFaceSpace) {
    const inProcessAgents = platform.agents
      .filter((agent) => agent.runtime.isolation !== 'process')
      .map((agent) => agent.id);
    if (inProcessAgents.length > 0) {
      throw new Error(
        `Hugging Face Space requires runtime.isolation=process: ${inProcessAgents.join(', ')}.`,
      );
    }
  }
  if (!host.modelBroker.enabled) {
    throw new Error(
      'MODEL_PROVIDER_POLICY=host-broker-only requires MODEL_BROKER_ENABLED=true.',
    );
  }
}

function isLoopback(host: string): boolean {
  return ['127.0.0.1', '::1', 'localhost'].includes(host.toLowerCase());
}
