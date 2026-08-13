#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const failures = [];
const text = async (path) => await readFile(resolve(root, path), 'utf8');

for (const path of [
  'src/sandbox/code-runner',
  'src/sandbox/remote-http.ts',
  'native',
  'scripts/build-sandbox-rootfs.sh',
  'scripts/test-installed-code-runner.sh',
]) await mustBeMissing(path);

const pkg = JSON.parse(await text('package.json'));
const lock = JSON.parse(await text('package-lock.json'));
if (pkg.scripts?.postinstall !== undefined) {
  failures.push('Dependency security fixes must not rely on a root postinstall patch.');
}
if (pkg.dependencies?.['@earendil-works/pi-ai'] !== '0.84.1') {
  failures.push('Pi AI must remain pinned to the audited 0.84.1 release.');
}
if (pkg.dependencies?.['@earendil-works/pi-coding-agent'] !== '0.84.1') {
  failures.push('Pi coding agent must remain pinned to the audited 0.84.1 release.');
}
const piBraceExpansion =
  lock.packages?.['node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion'];
if (piBraceExpansion?.version !== '5.0.9') {
  failures.push('package-lock.json must resolve the Pi brace-expansion dependency to 5.0.9.');
}
const piUndici = lock.packages?.['node_modules/@earendil-works/pi-coding-agent/node_modules/undici'];
if (piUndici?.version !== '8.9.0') {
  failures.push('package-lock.json must resolve the Pi undici dependency to 8.9.0.');
}
const dependencies = {
  ...(pkg.dependencies ?? {}),
  ...(pkg.devDependencies ?? {}),
  ...(pkg.optionalDependencies ?? {}),
};
for (const name of Object.keys(dependencies)) {
  if (/^(?:ssh2|node-ssh|simple-ssh|tunnel-ssh|ssh2-sftp-client|node-pty)$/i.test(name)) {
    failures.push(`Forbidden remote-login or PTY dependency: ${name}`);
  }
}

const sourceFiles = await walk(resolve(root, 'src'));
const source = (await Promise.all(sourceFiles.map((path) => readFile(path, 'utf8')))).join('\n');
reject(source, /shell\s*:\s*true/i, 'Runtime must never spawn a shell.');
reject(source, /\bcode\.run\b|CODE_RUNNER_|EmbeddedCodeRunner/i, 'Code Runner surface must not exist.');
reject(
  source,
  /(?:spawn|exec|execFile|fork)\s*\(\s*['"](?:ssh|sshd|scp|sftp|dropbear|autossh)/i,
  'Runtime must not launch remote-login commands.',
);

const larkCli = await text('src/tools/lark-cli.ts');
requirePattern(larkCli, /shell:\s*false/, 'lark-cli must run with shell=false.');
requirePattern(larkCli, /larkCli\.operations\.find/, 'lark-cli must resolve an exact structured operation ID.');
requirePattern(larkCli, /--app-secret-stdin/, 'lark-cli App secrets must be passed through stdin.');
requirePattern(larkCli, /--as=bot/, 'lark-cli identity must be fixed by the Host.');
requirePattern(larkCli, /XDG_CONFIG_HOME/, 'lark-cli must use an isolated configuration directory.');
requirePattern(larkCli, /XDG_CACHE_HOME/, 'lark-cli must use an isolated cache directory.');
const modelEnv = await text('src/pi/model-env.ts');
reject(modelEnv, /copyNonSecret\(['"](?:CLOUDFLARE|OPENAI|ANTHROPIC|FEISHU)/, 'Pi worker environment must not copy credentials.');
requirePattern(modelEnv, /PI_OFFLINE:\s*['"]1['"]/, 'Pi worker must disable Pi startup network operations.');
requirePattern(modelEnv, /PI_TELEMETRY:\s*['"]0['"]/, 'Pi worker must disable Pi install telemetry.');
const sessionCore = await text('src/pi/session-core.ts');
requirePattern(sessionCore, /process\.env\.PI_OFFLINE\s*=\s*['"]1['"]/, 'Pi SDK sessions must enforce offline mode even in process.');
requirePattern(sessionCore, /process\.env\.PI_TELEMETRY\s*=\s*['"]0['"]/, 'Pi SDK sessions must override Host telemetry opt-in.');
requirePattern(sessionCore, /enableInstallTelemetry:\s*false/, 'Pi SDK sessions must disable install telemetry and provider attribution.');
requirePattern(sessionCore, /allowModelNetwork:\s*false/, 'Pi SDK sessions must not allow create-time model catalog network access.');
requirePattern(sessionCore, /refreshOnCreate:\s*false/, 'Pi SDK sessions must skip create-time model catalog refresh.');
const modelBroker = await text('src/model/model-broker.ts');
requirePattern(modelBroker, /cf-aig-authorization/, 'Host Model Broker must inject Cloudflare authentication.');
requirePattern(modelBroker, /capabilities\.get/, 'Host Model Broker must authenticate worker capabilities.');
requirePattern(modelBroker, /blocked = new Set\(\[/, 'Host Model Broker must filter inbound headers.');

const workspace = await text('src/sandbox/types.ts');
reject(workspace, /\bexec\s*\(/, 'WorkspaceGuard must not expose command execution.');
const dockerfile = await text('Dockerfile');
requirePattern(dockerfile, /USER\s+node/, 'Docker runtime must be non-root.');
requirePattern(dockerfile, /EXPOSE\s+7860\b/, 'Docker runtime must expose only the HF port.');
reject(dockerfile, /EXPOSE\s+(?:22|8788|8790)\b/, 'Internal ports must not be exposed.');
reject(dockerfile, /setuid|chroot|seccomp|libseccomp|openssh|dropbear|autossh/i, 'Docker image must not contain native sandbox or SSH components.');

if (failures.length > 0) {
  for (const failure of failures) console.error(`SECURITY-SCAN: ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Security contract scan passed.');
}

async function mustBeMissing(path) {
  try {
    await stat(resolve(root, path));
    failures.push(`${path} must not exist.`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (entry.isFile() && path.endsWith('.ts')) result.push(path);
  }
  return result;
}

function reject(value, pattern, message) {
  if (pattern.test(value)) failures.push(message);
}

function requirePattern(value, pattern, message) {
  if (!pattern.test(value)) failures.push(message);
}
