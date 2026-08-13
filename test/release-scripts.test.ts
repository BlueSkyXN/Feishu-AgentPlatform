import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = resolve(process.cwd());

interface PackageResult {
  mode: 'official' | 'preview';
  preview: boolean;
  sourceCommit: string;
  zipPath: string;
  checksumPath: string;
  sha256: string;
}

test('repository check ignores active manifests covered by .gitignore', async () => {
  const ignoredManifest = join(
    root,
    'config',
    'apps',
    'repository-check-ignored.yaml',
  );
  await writeFile(ignoredManifest, 'id: ignored-test\n', 'utf8');
  try {
    const { runRepositoryCheck } = await repositoryModule();
    const { isSensitiveReleasePath } = await releaseUtilsModule();
    const result = await runRepositoryCheck({ root });
    assert.equal(
      result.visibleFiles.includes('config/apps/repository-check-ignored.yaml'),
      false,
    );
    assert.equal(
      result.failures.some((failure: string) =>
        failure.includes('repository-check-ignored.yaml'),
      ),
      false,
    );
    for (const path of [
      '.env',
      '.env.production',
      'local/state.json',
      'data/platform.sqlite',
      'secrets/token.txt',
      'config/private.pem',
    ]) assert.equal(isSensitiveReleasePath(path), true, path);
    assert.equal(isSensitiveReleasePath('.env.example'), false);
  } finally {
    await rm(ignoredManifest, { force: true });
  }
});

test('release preview is marked, excludes ignored and sensitive paths, and is deterministic', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'release-script-test-'));
  try {
    const { packageRelease } = await packageModule();
    const { gitTrackedFiles, isCleanGitTree } = await releaseUtilsModule();
    const fixtureRoot = join(temporary, 'repository');
    await createReleaseFixtureRepository(root, fixtureRoot);
    if (await isCleanGitTree(fixtureRoot)) {
      const official = await packageRelease({
        root: fixtureRoot,
        outputDir: join(temporary, 'clean-official'),
        mode: 'official',
        sourceDateEpoch: 1_800_000_000,
      });
      assert.equal(official.mode, 'official');
      assert.equal(official.preview, false);
      const officialEntries = (
        await commandOutput('unzip', ['-Z', '-1', official.zipPath], fixtureRoot)
      ).split(/\r?\n/u).filter(Boolean);
      const prefix = `${basename(official.zipPath, '.zip')}/`;
      assert.deepEqual(
        officialEntries.map((path) => path.slice(prefix.length)),
        [...await gitTrackedFiles(fixtureRoot, 'HEAD'), 'RELEASE_MANIFEST.txt'].sort(),
      );
    }

    const uncommitted = join(fixtureRoot, 'release-preview-test.txt');
    await writeFile(uncommitted, 'uncommitted preview fixture\n', 'utf8');
    await writeFile(join(fixtureRoot, '.env'), 'SECRET=preview-only\n', 'utf8');
    for (const path of ['data/runtime.db', 'local/note.txt', 'secrets/token.txt']) {
      const destination = join(fixtureRoot, path);
      await mkdir(resolve(destination, '..'), { recursive: true });
      await writeFile(destination, 'sensitive preview fixture\n', 'utf8');
    }
    await assert.rejects(
      () => packageRelease({
        root: fixtureRoot,
        outputDir: join(temporary, 'official'),
        mode: 'official',
        sourceDateEpoch: 1_800_000_000,
      }),
      /clean exact Git tree/,
    );

    const first = await packageRelease({
      root: fixtureRoot,
      outputDir: join(temporary, 'first'),
      mode: 'auto',
      sourceDateEpoch: 1_800_000_000,
    });
    const second = await packageRelease({
      root: fixtureRoot,
      outputDir: join(temporary, 'second'),
      mode: 'preview',
      sourceDateEpoch: 1_800_000_000,
    });
    assert.equal(first.mode, 'preview');
    assert.equal(first.preview, true);
    assert.match(basename(first.zipPath), /-uncommitted-preview\.zip$/u);
    assert.equal(first.sha256, second.sha256);
    assert.equal(await sha256(first.zipPath), await sha256(second.zipPath));

    const entries = await commandOutput('unzip', ['-Z', '-1', first.zipPath], fixtureRoot);
    const paths = entries.split(/\r?\n/u).filter(Boolean);
    assert.ok(paths.some((path) => path.endsWith('/RELEASE_PREVIEW.txt')));
    assert.ok(paths.some((path) => path.endsWith('/release-preview-test.txt')));
    assert.equal(paths.some((path) => path.includes('/ignored/')), false);
    assert.equal(
      paths.some((path) =>
        /\/(?:local|data|secrets)\//u.test(path) ||
        /\/\.env$/u.test(path) ||
        /\/\.env\.(?!example$)/u.test(path),
      ),
      false,
    );
    assert.deepEqual(paths, [...paths].sort());

    const checksum = await readFile(first.checksumPath, 'utf8');
    assert.equal(checksum, `${first.sha256}  ${basename(first.zipPath)}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

async function createReleaseFixtureRepository(
  sourceRoot: string,
  fixtureRoot: string,
): Promise<void> {
  await mkdir(fixtureRoot, { recursive: true });
  for (const path of [
    'package.json',
    'README.md',
    'scripts/package-release.mjs',
    'scripts/release-utils.mjs',
  ]) {
    const destination = join(fixtureRoot, path);
    await mkdir(resolve(destination, '..'), { recursive: true });
    await writeFile(destination, await readFile(join(sourceRoot, path)));
  }
  await writeFile(join(fixtureRoot, '.gitignore'), '/ignored/\n', 'utf8');
  await commandOutput('git', ['init', '-q'], fixtureRoot);
  await commandOutput('git', ['config', 'user.name', 'Release Test'], fixtureRoot);
  await commandOutput('git', ['config', 'user.email', 'release-test@example.invalid'], fixtureRoot);
  await commandOutput('git', ['add', '.'], fixtureRoot);
  await commandOutput('git', ['commit', '-q', '-m', 'fixture'], fixtureRoot);
  await mkdir(join(fixtureRoot, 'ignored'), { recursive: true });
  await writeFile(join(fixtureRoot, 'ignored/runtime.txt'), 'ignored fixture\n', 'utf8');
}

test('workflows pin Actions and gate release and HF deployment on resolved commit SHAs', async () => {
  const workflowRoot = join(root, '.github', 'workflows');
  const names = (await readdir(workflowRoot)).filter((name) => /\.ya?ml$/u.test(name));
  for (const name of names) {
    const value = await readFile(join(workflowRoot, name), 'utf8');
    for (const match of value.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+).*$/gmu)) {
      const reference = match[1] as string;
      if (reference.startsWith('./') || reference.startsWith('docker://')) continue;
      assert.match(reference, /^[^@\s]+@[0-9a-f]{40}$/u, `${name}: ${reference}`);
    }
    if (/actions\/checkout@/u.test(value)) {
      assert.match(value, /git rev-parse (?:--verify )?["']?HEAD/u, name);
    }
  }

  const release = await readFile(join(workflowRoot, 'release.yml'), 'utf8');
  assert.match(release, /git rev-list -n 1 "refs\/tags\/\$\{RELEASE_TAG\}"/u);
  assert.match(release, /package -- --official/u);
  assert.match(release, /HEAD_SHA.*TAG_SHA|TAG_SHA.*HEAD_SHA/su);

  const ci = await readFile(join(workflowRoot, 'ci.yml'), 'utf8');
  const hf = await readFile(join(workflowRoot, 'hf-space.yml'), 'utf8');
  const container = await readFile(join(workflowRoot, 'container.yml'), 'utf8');
  assert.match(ci, /REQUESTED_REF/u);
  assert.match(
    ci,
    /git rev-parse --verify --end-of-options "\$\{REQUESTED_REF\}\^\{commit\}"/u,
  );
  assert.match(hf, /SOURCE_SHA/u);
  assert.match(hf, /git archive --format=tar "\$SOURCE_SHA" hfs/u);
  assert.doesNotMatch(hf, /REQUESTED_REF/u);

  const quality = await readFile(join(workflowRoot, 'quality-gate.yml'), 'utf8');
  for (const workflow of [release, ci]) {
    assert.match(workflow, /uses: \.\/\.github\/workflows\/quality-gate\.yml/u);
  }
  for (const publisher of [hf, container]) {
    assert.doesNotMatch(publisher, /uses: \.\/\.github\/workflows\/quality-gate\.yml/u);
  }
  assert.match(quality, /npm run check/u);
  assert.match(quality, /npm run build/u);
  assert.match(quality, /Build production image/u);
  assert.match(quality, /setup_required/u);
  assert.doesNotMatch(release, /--clobber/u);
});

test('HF SDK adapter emits stable JSON without serializing credentials', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hf-space-info-test-'));
  const packageDirectory = join(temporary, 'huggingface_hub');
  const output = join(temporary, 'space-info.json');
  await mkdir(packageDirectory);
  await writeFile(
    join(packageDirectory, '__init__.py'),
    [
      'class Runtime:',
      "    stage = 'PAUSED'",
      "    raw = {'stage': 'PAUSED', 'sha': 'runtime-sha', 'domains': [{'stage': 'READY'}]}",
      '',
      'class Info:',
      "    id = 'owner/space'",
      "    sha = 'repository-sha'",
      '    private = True',
      "    sdk = 'docker'",
      "    subdomain = 'owner-space'",
      '    runtime = Runtime()',
      '',
      'class HfApi:',
      '    def __init__(self, token):',
      "        assert token == 'test-secret-token'",
      '    def space_info(self, repo_id, timeout, expand):',
      "        assert repo_id == 'owner/space'",
      '        assert timeout == 30',
      "        assert expand == ['sha', 'runtime', 'private', 'sdk', 'subdomain']",
      '        return Info()',
      '',
    ].join('\n'),
    'utf8',
  );

  try {
    await commandOutput(
      'python3',
      ['scripts/hf-space-info.py', output],
      root,
      {
        PYTHONPATH: temporary,
        HF_SPACE_ID: 'owner/space',
        HF_TOKEN: 'test-secret-token',
      },
    );
    const raw = await readFile(output, 'utf8');
    const document = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(document.id, 'owner/space');
    assert.equal(document.sha, 'repository-sha');
    assert.deepEqual(document.runtime, {
      stage: 'PAUSED',
      raw: {
        stage: 'PAUSED',
        sha: 'runtime-sha',
        domains: [{ stage: 'READY' }],
      },
    });
    assert.doesNotMatch(raw, /test-secret-token/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('HF settings adapter writes and reads back variables before restart', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hf-space-settings-test-'));
  const packageDirectory = join(temporary, 'huggingface_hub');
  await mkdir(packageDirectory);
  await writeFile(
    join(packageDirectory, '__init__.py'),
    [
      'import os',
      '',
      'EXPECTED = {',
      "    'FAP_ARTIFACT_MANIFEST_HF_URI': os.environ['FAP_ARTIFACT_MANIFEST_HF_URI'],",
      "    'FAP_ARTIFACT_EXPECTED_SOURCE_REF': os.environ['FAP_ARTIFACT_EXPECTED_SOURCE_REF'],",
      "    'FAP_ARTIFACT_MAX_BYTES': os.environ['FAP_ARTIFACT_MAX_BYTES'],",
      '}',
      '',
      'class Variable:',
      '    def __init__(self, value):',
      '        self.value = value',
      '',
      'class HfApi:',
      '    def __init__(self, token):',
      "        assert token == 'test-secret-token'",
      '        self.variables = {}',
      '        self.restarted = False',
      '    def add_space_variable(self, repo_id, key, value):',
      "        assert repo_id == 'owner/space'",
      '        assert EXPECTED[key] == value',
      '        self.variables[key] = Variable(value)',
      '    def get_space_variables(self, repo_id):',
      "        assert repo_id == 'owner/space'",
      "        if os.environ.get('CORRUPT_READBACK') == '1':",
      "            self.variables['FAP_ARTIFACT_MAX_BYTES'] = Variable('1')",
      '        return self.variables',
      '    def restart_space(self, repo_id):',
      "        assert repo_id == 'owner/space'",
      '        assert not self.restarted',
      '        assert {key: item.value for key, item in self.variables.items()} == EXPECTED',
      '        self.restarted = True',
      '        return object()',
      '',
    ].join('\n'),
    'utf8',
  );

  const sourceSha = 'a'.repeat(40);
  const environment = {
    PYTHONPATH: temporary,
    HF_SPACE_ID: 'owner/space',
    HF_TOKEN: 'test-secret-token',
    FAP_ARTIFACT_MANIFEST_HF_URI:
      `hf://buckets/owner/hfs-dist/feishu-agent-platform/edge/${sourceSha}/manifest.json`,
    FAP_ARTIFACT_EXPECTED_SOURCE_REF: sourceSha,
    FAP_ARTIFACT_MAX_BYTES: '268435456',
  };

  try {
    const output = await commandOutput(
      'python3',
      ['scripts/hf-space-settings.py'],
      root,
      environment,
    );
    assert.equal(output, 'space_variables_verified=3\nspace_restart_requested=true\n');
    assert.doesNotMatch(output, /test-secret-token/u);
    await assert.rejects(
      commandOutput(
        'python3',
        ['scripts/hf-space-settings.py'],
        root,
        { ...environment, CORRUPT_READBACK: '1' },
      ),
      /Space variable readback mismatch: FAP_ARTIFACT_MAX_BYTES/u,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('HF runtime evaluator fails closed and measures only continuous PAUSED time', async () => {
  const url = pathToFileURL(join(root, 'scripts', 'hf-space-runtime-state.mjs')).href;
  const { evaluateSpaceRuntime } = await import(url) as {
    evaluateSpaceRuntime(
      info: Record<string, unknown>,
      expectedSha: string,
      pausedSince?: number,
      now?: number,
      pausedGraceMs?: number,
    ): {
      disposition: string;
      reason: string;
      pausedSince: number;
      pausedForMs: number;
      runtimeSha: string;
    };
  };
  const expectedSha = 'a'.repeat(40);
  const runtime = (
    stage: string,
    options: { sha?: string; domain?: string; abuse?: boolean; errorMessage?: string } = {},
  ): Record<string, unknown> => ({
    id: 'owner/space',
    sha: expectedSha,
    subdomain: 'owner-space',
    runtime: {
      stage,
      raw: {
        stage,
        sha: options.sha,
        domains: [{ stage: options.domain ?? 'READY' }],
        abuse: options.abuse,
        errorMessage: options.errorMessage,
      },
    },
  });

  assert.deepEqual(
    evaluateSpaceRuntime(runtime('RUNNING', { sha: expectedSha }), expectedSha),
    {
      disposition: 'ready',
      reason: 'ready',
      repoSha: expectedSha,
      runtimeSha: expectedSha,
      stage: 'RUNNING',
      domainStage: 'READY',
      subdomain: 'owner-space',
      subdomainValid: true,
      blocked: false,
      pausedSince: 0,
      pausedForMs: 0,
    },
  );
  assert.equal(
    evaluateSpaceRuntime(runtime('RUNNING'), expectedSha).runtimeSha,
    'pending',
  );
  assert.equal(
    evaluateSpaceRuntime(runtime('RUNNING', { sha: expectedSha, abuse: true }), expectedSha)
      .reason,
    'platform_abuse',
  );
  assert.equal(
    evaluateSpaceRuntime(
      runtime('RUNNING', { sha: expectedSha, errorMessage: 'blocked' }),
      expectedSha,
    ).reason,
    'platform_error',
  );
  assert.equal(
    evaluateSpaceRuntime(runtime('BUILD_ERROR'), expectedSha).reason,
    'runtime_error',
  );
  assert.equal(
    evaluateSpaceRuntime(runtime('FUTURE_ERROR'), expectedSha).reason,
    'runtime_error',
  );
  const invalidSubdomain = runtime('RUNNING', { sha: expectedSha });
  invalidSubdomain.subdomain = '../credential-host';
  assert.equal(
    evaluateSpaceRuntime(invalidSubdomain, expectedSha).reason,
    'invalid_subdomain',
  );

  const firstPause = evaluateSpaceRuntime(runtime('PAUSED'), expectedSha, 0, 1_000, 120_000);
  assert.equal(firstPause.disposition, 'wait');
  assert.equal(firstPause.pausedSince, 1_000);
  const resetPause = evaluateSpaceRuntime(runtime('BUILDING'), expectedSha, 1_000, 61_000, 120_000);
  assert.equal(resetPause.pausedSince, 0);
  const secondPause = evaluateSpaceRuntime(runtime('PAUSED'), expectedSha, 1_000, 121_000, 120_000);
  assert.equal(secondPause.disposition, 'terminal');
  assert.equal(secondPause.reason, 'paused_timeout');

  const stale = runtime('RUNTIME_ERROR');
  stale.sha = 'b'.repeat(40);
  assert.equal(evaluateSpaceRuntime(stale, expectedSha).disposition, 'wait');
});

test('release ZIP bytes are produced by the repository-owned deterministic writer', async () => {
  const source = await readFile(join(root, 'scripts', 'package-release.mjs'), 'utf8');
  assert.match(source, /writeDeterministicZip/u);
  assert.match(source, /0x04034b50/u);
  assert.match(source, /0x02014b50/u);
  assert.match(source, /0x06054b50/u);
  assert.doesNotMatch(source, /run\(\s*['"]zip['"]/u);
});

async function packageModule(): Promise<{
  packageRelease(options: Record<string, unknown>): Promise<PackageResult>;
}> {
  const url = pathToFileURL(join(root, 'scripts', 'package-release.mjs')).href;
  return await import(url) as {
    packageRelease(options: Record<string, unknown>): Promise<PackageResult>;
  };
}

async function repositoryModule(): Promise<{
  runRepositoryCheck(options: { root: string }): Promise<{
    failures: string[];
    visibleFiles: string[];
  }>;
}> {
  const url = pathToFileURL(join(root, 'scripts', 'check-repository.mjs')).href;
  return await import(url) as {
    runRepositoryCheck(options: { root: string }): Promise<{
      failures: string[];
      visibleFiles: string[];
    }>;
  };
}

async function releaseUtilsModule(): Promise<{
  gitTrackedFiles(root: string, revision?: string): Promise<string[]>;
  isCleanGitTree(root: string): Promise<boolean>;
  isSensitiveReleasePath(path: string): boolean;
}> {
  const url = pathToFileURL(join(root, 'scripts', 'release-utils.mjs')).href;
  return await import(url) as {
    gitTrackedFiles(root: string, revision?: string): Promise<string[]>;
    isCleanGitTree(root: string): Promise<boolean>;
    isSensitiveReleasePath(path: string): boolean;
  };
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function commandOutput(
  command: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = {},
): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolvePromise(Buffer.concat(stdout).toString('utf8'));
      else reject(new Error(Buffer.concat(stderr).toString('utf8')));
    });
  });
}
