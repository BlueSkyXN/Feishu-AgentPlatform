import type { LoadedBindingConfig, ModelProviderPolicy } from '../config/types.js';

const COMMON_ENV = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'no_proxy',
] as const;

const SECRET_ENV_PATTERN =
  /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|CLOUDFLARE|FEISHU|LARK|ADMIN|OAUTH)/i;

export function assertModelProviderPolicy(
  config: LoadedBindingConfig,
  _policy: ModelProviderPolicy,
): void {
  if (config.agent.provider !== 'host-broker') {
    throw new Error(
      `Binding ${config.id} must use provider host-broker under MODEL_PROVIDER_POLICY=host-broker-only.`,
    );
  }
}

export function buildAgentWorkerEnvironment(
  _config: LoadedBindingConfig,
  home: string,
  temporaryDirectory: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
    NO_COLOR: '1',
    PI_AGENT_ISOLATED: '1',
  };
  for (const name of COMMON_ENV) copyNonSecret(name, env);
  return env;
}

export function exposedWorkerEnvironmentNames(
  _config: LoadedBindingConfig,
): string[] {
  return [
    ...COMMON_ENV,
    'HOME',
    'USERPROFILE',
    'TMPDIR',
    'TMP',
    'TEMP',
    'NO_COLOR',
    'PI_AGENT_ISOLATED',
  ];
}

function copyNonSecret(name: string, target: NodeJS.ProcessEnv): void {
  if (SECRET_ENV_PATTERN.test(name)) return;
  const value = process.env[name];
  if (value !== undefined) target[name] = value;
}
