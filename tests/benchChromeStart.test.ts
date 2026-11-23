// The VM-only bench-chrome entrypoint pins the profile, waits for its own launch and forwards only a fixture URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let runId = 0;
const start = async (
  t: any,
  {
    url,
    extra = [],
    outcome = 'runs',
    state = 'on',
    defaultEnv = false,
    missingProfile = false,
    defaultWait = false,
  }: {
    url?: string;
    extra?: string[];
    outcome?: 'runs' | 'handed' | 'failed' | 'silent';
    state?: string;
    defaultEnv?: boolean;
    missingProfile?: boolean;
    defaultWait?: boolean;
  } = {},
) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench Chrome start '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'scratch-chrome.log');
  fs.writeFileSync(log, "old MoPilot's extension old-id runs\n");
  const saved = { argv: process.argv, env: process.env };
  process.argv = [
    process.execPath,
    'bench/bench-chrome.mjs',
    ...(missingProfile ? [] : [dir, ...(defaultWait ? [] : ['0']), ...(url === undefined ? [] : [url]), ...extra]),
  ];
  process.env = { ...process.env };
  for (const key of ['MOPILOT_SCRATCH_CHROME_REAL', 'MOPILOT_SCRATCH_CHROME_EXTENSION', 'MOPILOT_SCRATCH_CHROME_PAIR'])
    delete process.env[key];
  if (!defaultEnv) {
    process.env.MOPILOT_SCRATCH_CHROME_REAL = '/fake/Chrome';
    process.env.MOPILOT_SCRATCH_CHROME_EXTENSION = '/fixture/extension with spaces';
  }
  process.env.MOPILOT_SCRATCH_CHROME_PAIR = '0';
  t.after(() => {
    process.argv = saved.argv;
    process.env = saved.env;
  });
  const seen: any[] = [];
  const reads: any[] = [];
  const errors: string[] = [];
  t.mock.method(process, 'exit', (code: number) => {
    throw new Error(`exit ${code}`);
  });
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args.join(' ')));
  t.mock.module('../bench/lib/guard.mjs', { namedExports: { requireVm: (entry: string) => seen.push({ guard: entry }) } });
  t.mock.module('node:module', {
    namedExports: {
      createRequire: (base: string) => (name: string) => {
        if (name.endsWith('/userChrome.cjs')) return { chromeExecutable: () => '/default/Chrome' };
        if (name.endsWith('/chromeProfileExtension.cjs'))
          return {
            extensionInProfile: (id: string, options: any) => {
              reads.push({ id, options });
              return state;
            },
          };
        return createRequire(base)(name);
      },
    },
  });
  t.mock.module('node:child_process', {
    namedExports: {
      ...childProcess,
      spawn: (cmd: string, args: string[], options: any) => {
        seen.push({ cmd, args, options });
        const line =
          outcome === 'runs'
            ? "now MoPilot's extension fixture-id runs"
            : outcome === 'handed'
              ? 'now handing the start over'
              : outcome === 'failed'
                ? 'now extension failed. Quitting this Chrome'
                : '';
        if (line) fs.appendFileSync(log, `${line}\n`);
        return { unref: () => seen.push({ unref: true }) };
      },
    },
  });
  let error: unknown;
  try {
    await import(`../bench/bench-chrome.mjs?test=${++runId}`);
  } catch (e) {
    error = e;
  }
  return { dir, seen, reads, errors, error };
};

test('windowless pre-launch uses the pinned profile and existing extension/pair switches after the VM guard', async (t) => {
  const r = await start(t);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.seen[0], { guard: 'bench/bench-chrome.mjs' });
  const call = r.seen[1];
  assert.equal(call.cmd, process.execPath);
  assert.deepEqual(call.args, [
    path.resolve(import.meta.dirname, '../bench/scratch-chrome.mjs'),
    `--user-data-dir=${r.dir}`,
    '--no-first-run',
    '--no-startup-window',
  ]);
  assert.equal(call.options.env.MOPILOT_SCRATCH_CHROME_REAL, '/fake/Chrome');
  assert.equal(call.options.env.MOPILOT_SCRATCH_CHROME_EXTENSION, '/fixture/extension with spaces');
  assert.equal(call.options.env.MOPILOT_SCRATCH_CHROME_PAIR, '1');
  assert.equal(call.options.detached, true);
  assert.equal(call.options.stdio, 'ignore');
  assert.deepEqual(r.reads, [{ id: 'jhnfobeoiefjfneilcdkljfnapchmoej', options: { userData: r.dir } }]);
});

test('fixture URLs, including punctuation, are one argv element on cold and handed-over starts', async (t) => {
  const url = 'http://account.localhost:8820/link?code=space%20%22&next=mail';
  const r = await start(t, { url, outcome: 'handed', defaultEnv: true });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.seen[1].args.slice(1), [`--user-data-dir=${r.dir}`, '--no-first-run', url]);
  assert.equal(r.seen[1].options.env.MOPILOT_SCRATCH_CHROME_REAL, '/default/Chrome');
  assert.equal(r.seen[1].options.env.MOPILOT_SCRATCH_CHROME_EXTENSION, path.resolve(import.meta.dirname, '../electron/chrome-extension'));
});

for (const [url, extra] of [
  ['--user-data-dir=/other', []],
  ['file:///other', []],
  ['http://fixture/', ['--user-data-dir=/other']],
] as [string, string[]][]) {
  test(`unsupported URL/extra argument never overrides the checked profile: ${url} ${extra}`, async (t) => {
    const r = await start(t, { url, extra });
    assert.match(String(r.error), /exit 2/);
    assert.equal(
      r.seen.some((v) => v.cmd),
      false,
    );
    assert.equal(r.reads.length, 0);
  });
}

for (const outcome of ['failed', 'silent'] as const) {
  test(`a ${outcome} current start cannot borrow the old log or stale on preference`, async (t) => {
    const r = await start(t, { outcome });
    assert.match(String(r.error), /exit 1/);
    assert.equal(r.reads.length, 0);
    assert.match(r.errors.join('\n'), outcome === 'failed' ? /Quitting this Chrome/ : /wrapper said nothing/);
  });
}

test('the current startup outcome alone is insufficient when the profile no longer shows the extension on', async (t) => {
  const r = await start(t, { state: 'off' });
  assert.match(String(r.error), /exit 1/);
  assert.match(r.errors.join('\n'), /profile does not show.*extension on/);
});

test('the default wait stays compatible and a missing profile starts nothing', async (t) => {
  const r = await start(t, { defaultWait: true });
  assert.equal(r.error, undefined);
});

test('a missing profile starts nothing', async (t) => {
  const r = await start(t, { missingProfile: true });
  assert.match(String(r.error), /exit 2/);
  assert.equal(
    r.seen.some((v) => v.cmd),
    false,
  );
});

test('a cold start forwards an HTTPS fixture URL through the extension wrapper', async (t) => {
  const url = 'https://fixture.localhost/path?value=one%20two';
  const r = await start(t, { url });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.seen[1].args.slice(1), [`--user-data-dir=${r.dir}`, '--no-first-run', url]);
});
