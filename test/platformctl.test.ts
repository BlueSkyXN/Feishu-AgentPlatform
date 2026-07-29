import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const runFile = promisify(execFile);
const cli = resolve('.test-dist/src/cli/platformctl.js');

test('platformctl imports, exports, backs up and atomically restores configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-platformctl-'));
  const sourceDatabase = join(root, 'source/platform.db');
  const restoredDatabase = join(root, 'restored/platform.db');
  const input = join(root, 'input.json');
  const exported = join(root, 'exported.json');
  const restoredExport = join(root, 'restored-export.json');
  const backup = join(root, 'backup.db');
  const document = { schemaVersion: 1, apps: [], agents: [], bindings: [] };
  await writeFile(input, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  try {
    const sourceEnv = environment(root, sourceDatabase);
    await run('config', ['import', input, '--note=test'], sourceEnv);
    await run('config', ['export', exported, '--slot=draft'], sourceEnv);
    assert.deepEqual(JSON.parse(await readFile(exported, 'utf8')), document);
    await run('config', ['backup', backup], sourceEnv);

    const restoredEnv = environment(root, restoredDatabase);
    const restored = await run('config', ['restore', backup, '--confirm=RESTORE'], restoredEnv);
    assert.equal((restored as { status?: string }).status, 'restored');
    await run('config', ['export', restoredExport, '--slot=draft'], restoredEnv);
    assert.deepEqual(JSON.parse(await readFile(restoredExport, 'utf8')), document);

    await assert.rejects(
      () => run('config', ['restore', restoredDatabase, '--confirm=RESTORE'], restoredEnv),
      /source and destination must be different files/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const result = await runFile(process.execPath, [cli, command, ...args], {
    cwd: process.cwd(),
    env,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(result.stdout) as unknown;
}

function environment(root: string, databasePath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MODEL_BROKER_ENABLED: 'false',
    INTERNAL_HTTP_ENABLED: 'false',
    PLATFORM_MASTER_KEY: 'platformctl-test-master-key-000000000000',
    DATA_ROOT: join(root, 'data'),
    PLATFORM_DATABASE_PATH: databasePath,
  };
}
