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
  const uncommitted = join(root, 'release-preview-test.txt');
  try {
    const { packageRelease } = await packageModule();
    const { gitTrackedFiles, isCleanGitTree } = await releaseUtilsModule();
    if (await isCleanGitTree(root)) {
      const official = await packageRelease({
        root,
        outputDir: join(temporary, 'clean-official'),
        mode: 'official',
        sourceDateEpoch: 1_800_000_000,
      });
      assert.equal(official.mode, 'official');
      assert.equal(official.preview, false);
      const officialEntries = (
        await commandOutput('unzip', ['-Z', '-1', official.zipPath], root)
      ).split(/\r?\n/u).filter(Boolean);
      const prefix = `${basename(official.zipPath, '.zip')}/`;
      assert.deepEqual(
        officialEntries.map((path) => path.slice(prefix.length)),
        [...await gitTrackedFiles(root, 'HEAD'), 'RELEASE_MANIFEST.txt'].sort(),
      );
    }

    await writeFile(uncommitted, 'uncommitted preview fixture\n', 'utf8');
    await assert.rejects(
      () => packageRelease({
        root,
        outputDir: join(temporary, 'official'),
        mode: 'official',
        sourceDateEpoch: 1_800_000_000,
      }),
      /clean exact Git tree/,
    );

    const first = await packageRelease({
      root,
      outputDir: join(temporary, 'first'),
      mode: 'auto',
      sourceDateEpoch: 1_800_000_000,
    });
    const second = await packageRelease({
      root,
      outputDir: join(temporary, 'second'),
      mode: 'preview',
      sourceDateEpoch: 1_800_000_000,
    });
    assert.equal(first.mode, 'preview');
    assert.equal(first.preview, true);
    assert.match(basename(first.zipPath), /-uncommitted-preview\.zip$/u);
    assert.equal(first.sha256, second.sha256);
    assert.equal(await sha256(first.zipPath), await sha256(second.zipPath));

    const entries = await commandOutput('unzip', ['-Z', '-1', first.zipPath], root);
    const paths = entries.split(/\r?\n/u).filter(Boolean);
    assert.ok(paths.some((path) => path.endsWith('/RELEASE_PREVIEW.txt')));
    assert.ok(paths.some((path) => path.endsWith('/release-preview-test.txt')));
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
    await rm(uncommitted, { force: true });
    await rm(temporary, { recursive: true, force: true });
  }
});

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
  assert.match(hf, /git archive --format=tar "\$SOURCE_SHA"/u);
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
