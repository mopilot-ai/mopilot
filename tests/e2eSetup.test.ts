// E2E setup prepares Electron's Linux terminal before any renderer reuse or harness starts, and preserves build failures.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const calls: unknown[][] = [];
let failure: Error | undefined;
let warm = true;
mock.module('node:child_process', {
  namedExports: {
    execFileSync: (...args: unknown[]) => {
      calls.push(args);
      if (failure) throw failure;
    },
  },
});
mock.module('node:fs', {
  defaultExport: {
    existsSync: () => true,
    statSync: (file: string) => ({ mtimeMs: file.endsWith('dist/index.html') ? (warm ? 2 : 0) : 1, isDirectory: () => false }),
  },
});
// Playwright supplies __dirname to this setup module; Node's ESM unit runner needs the same value.
(globalThis as any).__dirname = path.join(import.meta.dirname, 'e2e');
const { default: globalSetup } = await import('./e2e/global-setup.ts');
delete (globalThis as any).__dirname;

test('a warm Linux renderer compiles its terminal through native ESM before other setup or reuse', async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  calls.length = 0;
  await globalSetup();
  assert.equal(calls.length, 3);
  const [command, args, options] = calls[0] as [string, string[], unknown];
  assert.equal(command, process.execPath);
  assert.deepEqual(options, { cwd: path.resolve(import.meta.dirname, '..'), stdio: 'inherit' });
  // Execute the actual bootstrap with an isolated compiler stand-in, without rebuilding a native addon or launching an app.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mopilot-e2e-pty-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'));
  await writeFile(path.join(root, 'scripts/pty-worker.mjs'), 'process.exit(0);');
  await writeFile(
    path.join(root, 'scripts/linux-pty.mjs'),
    `import { fork } from 'node:child_process';
     export async function rebuildLinuxPty(options) {
       await new Promise((resolve, reject) => {
         const child = fork(new URL('./pty-worker.mjs', import.meta.url), { stdio: 'pipe' });
         let stderr = '';
         child.stderr.on('data', chunk => stderr += chunk);
         child.on('error', reject);
         child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
       });
       if (process.env.MOPILOT_TEST_PTY_COMPILER_FAIL) throw new Error('terminal compiler refused');
       console.log(JSON.stringify(options));
     }`,
  );
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, MOPILOT_TEST_PTY_COMPILER_FAIL: '' },
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { buildPath: root, arch: process.arch, prune: false });
  const refused = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, MOPILOT_TEST_PTY_COMPILER_FAIL: '1' },
  });
  assert.equal(refused.status, 1, refused.error?.message ?? refused.stderr);
  assert.match(refused.stderr, /terminal compiler refused/);
  assert.match(String(calls[1][1]), /build-sage-mcp\.mjs,--ensure$/);
  assert.match(String(calls[2][1]), /build-core\.mjs,--ensure$/);
});

test('a terminal compiler failure aborts Linux setup before any app build or tests', async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  calls.length = 0;
  failure = new Error('terminal compiler failed');
  t.after(() => {
    failure = undefined;
  });
  await assert.rejects(async () => globalSetup(), failure);
  assert.equal(calls.length, 1);
});

test('macOS keeps its prebuilt terminal and can still build a cold renderer', async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  calls.length = 0;
  warm = false;
  t.after(() => {
    warm = true;
  });
  await globalSetup();
  assert.equal(calls.length, 3);
  // vite's script under this Node, not `npx`, which Windows cannot start without a shell
  assert.equal(calls[2][0], process.execPath);
  assert.deepEqual(calls[2][1], [
    path.join(path.resolve(import.meta.dirname, '..'), 'node_modules/vite/bin/vite.js'),
    'build',
    '--logLevel',
    'warn',
  ]);
});

test('Windows runs the core and sage-mcp setup with no terminal rebuild, and builds a cold renderer without npx', async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  calls.length = 0;
  warm = false;
  t.after(() => {
    warm = true;
  });
  await globalSetup();
  assert.equal(calls.length, 3);
  assert.match(String(calls[0][1]), /build-sage-mcp\.mjs,--ensure$/);
  assert.match(String(calls[1][1]), /build-core\.mjs,--ensure$/);
  assert.ok(calls.every(([command]) => command === process.execPath));
});
