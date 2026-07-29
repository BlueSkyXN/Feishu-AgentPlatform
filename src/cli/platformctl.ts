#!/usr/bin/env node

import { randomUUID } from 'node:crypto';

import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { DatabaseSync } from 'node:sqlite';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { loadHostConfig } from '../config/load-host.js';
import {
  loadPlatformConfig,
  loadPlatformConfigDocument,
  validatePlatformConfigDocument,
} from '../config/load-platform.js';
import { resolveBindingConfig, type PlatformConfigDocument } from '../config/types.js';
import { assertDeploymentConstraints } from '../config/validate-deployment.js';
import { assertModelProviderPolicy } from '../pi/model-env.js';
import { assertSupportedNode } from '../runtime/node-version.js';
import { ConfigDocumentStore } from '../storage/config-store.js';
import { CredentialVault } from '../storage/credential-vault.js';
import { PlatformDatabase } from '../storage/database.js';

async function main(): Promise<void> {
  if (existsSync('.env')) loadEnvFile('.env');
  const command = process.argv[2] ?? 'help';
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  if (command === 'doctor') {
    assertSupportedNode();
    const host = loadHostConfig(process.cwd());
    print({
      status: 'ok',
      node: process.version,
      configRoot: host.configRoot,
      dataRoot: host.dataRoot,
      publicHttp: host.publicHttp,
      internalHttp: {
        ...host.internalHttp,
        adminToken: host.internalHttp.adminToken ? '[configured]' : undefined,
      },
      modelBroker: {
        ...host.modelBroker,
        upstreamApiKey: host.modelBroker.upstreamApiKey ? '[configured]' : undefined,
      },
    });
    return;
  }
  if (command === 'config') {
    await configCommand(process.argv[3] ?? 'help', process.argv.slice(4));
    return;
  }
  if (command === 'validate' || command === 'list') {
    assertSupportedNode();
    const host = loadHostConfig(process.cwd());
    const platform = await loadPlatformConfig(
      host.configRoot,
      host.projectRoot,
      host.dataRoot,
    );
    for (const binding of platform.bindings) {
      assertModelProviderPolicy(
        resolveBindingConfig(binding),
        host.modelProviderPolicy,
      );
    }
    assertDeploymentConstraints(platform, host);
    if (command === 'validate') {
      print({
        status: 'ok',
        apps: platform.apps.length,
        agents: platform.agents.length,
        bindings: platform.bindings.length,
      });
      return;
    }
    print({
      apps: platform.apps.map((app) => ({
        id: app.id,
        domain: app.domain,
        events: app.events,
        callbacks: app.callbacks,
        oauthEnabled: app.oauth.enabled,
      })),
      agents: platform.agents.map((agent) => ({
        id: agent.id,
        provider: agent.provider,
        model: agent.model,
        modelApi: agent.modelApi,
        workspaceMode: agent.workspace.mode,
        tools: agent.tools,
      })),
      bindings: platform.bindings.map((binding) => ({
        id: binding.id,
        app: binding.app,
        agent: binding.agent,
        route: binding.route,
        conversation: binding.conversation,
      })),
    });
    return;
  }
  throw new Error(`Unknown command: ${command}. Run platformctl help.`);
}

function printHelp(): void {
  process.stdout.write(`Feishu Agent Platform CLI\n\n用法:\n  platformctl doctor\n  platformctl validate\n  platformctl list\n  platformctl config import <file> [--publish] [--note=<text>]\n  platformctl config export <file> [--slot=active|draft]\n  platformctl config backup [file]\n  platformctl config restore <file> --confirm=RESTORE\n`);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function configCommand(subcommand: string, args: string[]): Promise<void> {
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    printHelp();
    return;
  }
  assertSupportedNode();
  const host = loadHostConfig(process.cwd());
  if (subcommand === 'restore') {
    const source = resolve(positional(args, 0, 'restore source file'));
    if (flag(args, 'confirm') !== 'RESTORE') {
      throw new Error('config restore requires --confirm=RESTORE.');
    }
    const destination = resolve(host.databasePath);
    if (source === destination || await sameFile(source, destination)) {
      throw new Error('Restore source and destination must be different files.');
    }
    if (existsSync(`${destination}-wal`) || existsSync(`${destination}-shm`)) {
      throw new Error('Database appears to be active; stop the Host before restore.');
    }
    await validateSqliteBackup(source);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.restore-${randomUUID()}.tmp`;
    const safety = existsSync(destination)
      ? `${destination}.pre-restore-${Date.now()}`
      : undefined;
    try {
      await copyFile(source, temporary);
      await chmod(temporary, 0o600);
      await validateSqliteBackup(temporary);
      const handle = await open(temporary, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (safety) await rename(destination, safety);
      try {
        await rename(temporary, destination);
      } catch (error) {
        if (safety && !existsSync(destination) && existsSync(safety)) {
          await rename(safety, destination);
        }
        throw error;
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    print({
      status: 'restored',
      databasePath: destination,
      ...(safety ? { previousDatabase: safety } : {}),
    });
    return;
  }

  const database = new PlatformDatabase(host.databasePath);
  try {
    const store = new ConfigDocumentStore<PlatformConfigDocument>(
      database,
      validatePlatformConfigDocument,
    );
    if (subcommand === 'backup') {
      const destination = resolve(
        args.find((value) => !value.startsWith('--')) ??
          resolve(host.dataRoot, 'backups', `platform-${new Date().toISOString().replace(/[:.]/gu, '-')}.db`),
      );
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const pages = await database.backupTo(destination);
      print({ status: 'backed_up', databasePath: host.databasePath, destination, pages });
      return;
    }
    if (subcommand === 'export') {
      const destination = positional(args, 0, 'export destination file');
      const slot = flag(args, 'slot') ?? 'active';
      if (slot !== 'active' && slot !== 'draft') {
        throw new Error('--slot must be active or draft.');
      }
      const revision = store.getState()[slot];
      if (!revision) throw new Error(`No ${slot} configuration revision exists.`);
      await mkdir(dirname(resolve(destination)), { recursive: true, mode: 0o700 });
      const content = ['.yaml', '.yml'].includes(extname(destination).toLowerCase())
        ? stringifyYaml(revision.document)
        : `${JSON.stringify(revision.document, null, 2)}\n`;
      await writeFile(resolve(destination), content, { mode: 0o600 });
      print({ status: 'exported', slot, revisionId: revision.id, destination: resolve(destination) });
      return;
    }
    if (subcommand === 'import') {
      const source = positional(args, 0, 'import source file');
      const document = await readConfigDocument(source);
      const note = flag(args, 'note') ?? `Imported from ${resolve(source)}`;
      const state = store.getState();
      const draft = store.saveDraft(document, {
        actor: 'platformctl',
        note,
        expectedDraftRevisionId: state.draft?.id ?? null,
      });
      if (!hasSwitch(args, 'publish')) {
        print({ status: 'draft_imported', revisionId: draft.id });
        return;
      }
      if (!host.platformMasterKey) {
        throw new Error('PLATFORM_MASTER_KEY is required to validate and publish imported configuration.');
      }
      const vault = new CredentialVault(database, host.platformMasterKey);
      await loadPlatformConfigDocument(
        draft.document,
        host.projectRoot,
        host.dataRoot,
        (name) => vault.resolveForInternalUse(name),
      );
      const active = store.publishDraft({
        actor: 'platformctl',
        expectedDraftRevisionId: draft.id,
        note,
      });
      print({ status: 'published', revisionId: active.id });
      return;
    }
    throw new Error(`Unknown config command: ${subcommand}.`);
  } finally {
    database.close();
  }
}

async function readConfigDocument(path: string): Promise<PlatformConfigDocument> {
  const text = await readFile(resolve(path), 'utf8');
  let parsed: unknown;
  try {
    parsed = ['.yaml', '.yml'].includes(extname(path).toLowerCase())
      ? parseYaml(text)
      : JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Invalid configuration document: ${path}.`, { cause: error });
  }
  return validatePlatformConfigDocument(parsed);
}

async function validateSqliteBackup(path: string): Promise<void> {
  const header = (await readFile(resolve(path))).subarray(0, 16).toString('utf8');
  if (header !== 'SQLite format 3\u0000') throw new Error('Restore source is not a SQLite database.');
  const database = new DatabaseSync(resolve(path), { readOnly: true, allowExtension: false });
  try {
    const integrity = database.prepare('PRAGMA integrity_check').get() as {
      integrity_check?: unknown;
    } | undefined;
    if (integrity?.integrity_check !== 'ok') {
      throw new Error('Restore source failed SQLite integrity_check.');
    }
    const migration = database.prepare(
      'SELECT MAX(version) AS version FROM schema_migrations',
    ).get() as { version?: number | bigint | null } | undefined;
    if (!migration?.version) throw new Error('Restore source has no platform schema migrations.');
    database.prepare('SELECT COUNT(*) AS count FROM config_revisions').get();
  } finally {
    database.close();
  }
}

async function sameFile(left: string, right: string): Promise<boolean> {
  if (!existsSync(left) || !existsSync(right)) return false;
  const [leftInfo, rightInfo] = await Promise.all([stat(left), stat(right)]);
  return leftInfo.dev === rightInfo.dev && leftInfo.ino === rightInfo.ino;
}

function positional(args: string[], index: number, label: string): string {
  const values = args.filter((value) => !value.startsWith('--'));
  const value = values[index];
  if (!value) throw new Error(`Missing ${label}.`);
  return value;
}

function flag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function hasSwitch(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
