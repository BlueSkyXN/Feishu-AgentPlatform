import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

import {
  AdminAuthService,
  StaticFeishuAdminAllowlist,
} from './admin/auth-service.js';
import { AdminServer } from './admin/admin-server.js';
import { PlatformAdminBackend } from './admin/platform-backend.js';
import { PlatformHost } from './app/host.js';
import {
  loadPlatformConfig,
  loadPlatformConfigDocument,
  toPlatformConfigDocument,
  validatePlatformConfigDocument,
} from './config/load-platform.js';
import { loadHostConfig } from './config/load-host.js';
import type { LoadedFeishuApp, PlatformConfig, PlatformConfigDocument } from './config/types.js';
import { Logger, errorFields } from './core/logger.js';
import { assertSupportedNode } from './runtime/node-version.js';
import { ConfigDocumentStore } from './storage/config-store.js';
import { CredentialVault } from './storage/credential-vault.js';
import { PlatformDatabase } from './storage/database.js';
import { PersistentSessionIndex } from './storage/session-index.js';
import { ToolApprovalStore } from './storage/approval-store.js';
import { AppLeaseStore } from './storage/app-lease-store.js';

const logger = new Logger({ service: 'feishu-agent-platform' });

async function main(): Promise<void> {
  assertSupportedNode();
  if (existsSync('.env')) loadEnvFile('.env');

  const hostConfig = loadHostConfig(process.cwd());
  if (!hostConfig.platformMasterKey) {
    throw new Error('PLATFORM_MASTER_KEY is required for the encrypted credential vault.');
  }
  const database = new PlatformDatabase(hostConfig.databasePath);
  const vault = new CredentialVault(database, hostConfig.platformMasterKey);
  const sessionIndex = new PersistentSessionIndex(database);
  const approvalStore = new ToolApprovalStore(database);
  const appLeaseStore = new AppLeaseStore(database);
  const configStore = new ConfigDocumentStore<PlatformConfigDocument>(
    database,
    validatePlatformConfigDocument,
  );
  let active = configStore.getState().active;
  if (!active && await hasYamlSeed(hostConfig.configRoot, hostConfig.projectRoot)) {
    const yamlPlatform = await loadPlatformConfig(
      hostConfig.configRoot,
      hostConfig.projectRoot,
      hostConfig.dataRoot,
    );
    importYamlCredentials(yamlPlatform.apps, vault);
    active = configStore.importSeed(toPlatformConfigDocument(yamlPlatform), {
      actor: 'system:yaml-seed',
      note: 'Initial import from YAML configuration.',
    });
  }
  const platform: PlatformConfig = active
    ? await loadPlatformConfigDocument(
        active.document,
        hostConfig.projectRoot,
        hostConfig.dataRoot,
        (name) => vault.resolveForInternalUse(name),
      )
    : { apps: [], agents: [], bindings: [] };
  const host = new PlatformHost(hostConfig, {
    sessionIndex,
    approvalStore,
    appLeaseStore,
  });
  const auth = AdminAuthService.fromEnvironment({
    audit: (event) => {
      database.recordAudit({
        actor: event.actor ?? 'anonymous',
        action: `admin.${event.action}`,
        entityType: 'admin_session',
        ...(event.clientKey ? { details: { clientKey: event.clientKey } } : {}),
      });
    },
  });
  const adminBackend = new PlatformAdminBackend(
    host,
    hostConfig,
    database,
    configStore,
    vault,
  );
  const adminServer = new AdminServer({
    host: hostConfig.publicHttp.host,
    port: hostConfig.publicHttp.port,
    bodyLimitBytes: hostConfig.publicHttp.bodyLimitBytes,
    staticRoot: resolve(hostConfig.projectRoot, 'web'),
    trustedProxyAddresses: hostConfig.adminTrustedProxyAddresses ?? [],
    auth,
    ...(hostConfig.adminOpenIds.length > 0
      ? {
          ssoAllowlist: new StaticFeishuAdminAllowlist({
            openIds: hostConfig.adminOpenIds,
          }),
        }
      : {}),
    backend: adminBackend,
    logger,
  });
  host.mountAdmin(adminServer);
  await host.start(platform, active?.id);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('Shutdown requested', { signal });
    await host.stop();
    database.close();
  };

  const handleSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
    void shutdown(signal).then(
      () => {
        process.exitCode = 0;
      },
      (error: unknown) => {
        logger.error('Shutdown failed', { signal, ...errorFields(error) });
        process.exitCode = 1;
      },
    );
  };

  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));
  process.once('uncaughtException', (error) => {
    logger.error('Uncaught exception', errorFields(error));
    void shutdown('uncaughtException').finally(() => {
      process.exitCode = 1;
    });
  });
  process.once('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', errorFields(reason));
    void shutdown('unhandledRejection').finally(() => {
      process.exitCode = 1;
    });
  });
}

async function hasYamlSeed(configRoot: string, projectRoot: string): Promise<boolean> {
  const root = resolve(projectRoot, configRoot);
  for (const directory of ['apps', 'agents', 'bindings']) {
    let names: string[];
    try {
      names = await readdir(resolve(root, directory));
    } catch {
      return false;
    }
    if (
      !names.some(
        (name) => /\.ya?ml$/iu.test(name) && !/\.example\.ya?ml$/iu.test(name),
      )
    ) {
      return false;
    }
  }
  return true;
}

function importYamlCredentials(
  apps: LoadedFeishuApp[],
  vault: CredentialVault,
): void {
  for (const app of apps) {
    const credentials: Array<{ name: string; kind: string; value: string | undefined }> = [
      { name: app.appIdEnv, kind: 'feishu-app-id', value: app.appId },
      { name: app.appSecretEnv, kind: 'feishu-app-secret', value: app.appSecret },
      ...(app.verificationTokenEnv
        ? [{ name: app.verificationTokenEnv, kind: 'feishu-verification-token', value: app.verificationToken }]
        : []),
      ...(app.encryptKeyEnv
        ? [{ name: app.encryptKeyEnv, kind: 'feishu-encrypt-key', value: app.encryptKey }]
        : []),
      ...(app.oauth.enabled
        ? [
            {
              name: app.oauth.publicBaseUrlEnv,
              kind: 'public-base-url',
              value: app.oauthPublicBaseUrl,
            },
            {
              name: app.oauth.encryptionKeyEnv,
              kind: 'oauth-encryption-key',
              value: app.oauthEncryptionKey,
            },
          ]
        : []),
    ];
    for (const credential of credentials) {
      if (!credential.value || vault.getStatus(credential.name).configured) continue;
      vault.setCredential({
        name: credential.name,
        kind: credential.kind,
        value: credential.value,
        actor: 'system:yaml-seed',
      });
    }
  }
}


main().catch((error: unknown) => {
  logger.error('Fatal startup error', errorFields(error));
  process.exitCode = 1;
});
