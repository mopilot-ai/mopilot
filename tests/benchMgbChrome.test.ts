// MGB's Chrome starts, marks and sign-in use the extension pre-launch in the GUI session on the pinned profile.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const profile = path.join(os.tmpdir(), 'MGB profile with spaces');
process.env.MGB_CHROME_PROFILE = profile;
process.env.BENCH_GUI_UID = '777';
const calls: { cmd: string; args: string[]; options: any }[] = [];
let fail = false;
mock.module('node:child_process', {
  namedExports: {
    ...childProcess,
    execFileSync(cmd: string, args: string[], options: any) {
      calls.push({ cmd, args, options });
      if (fail) throw Object.assign(new Error('extension did not start'), { code: 'ETIMEDOUT' });
      return '';
    },
  },
});
let turns = 0;
mock.module('../bench/drivers/edge.mjs', {
  namedExports: {
    edgeTurn: () => {
      turns++;
      throw new Error('unexpected model turn');
    },
  },
});
const { startBenchChrome, markChrome, setupSources, mgbTurn } = await import('../bench/drivers/mgb.mjs');
const helper = path.resolve(import.meta.dirname, '../bench/bench-chrome.mjs');
const expected = (url?: string) => ['asuser', '777', process.execPath, helper, profile, '40', ...(url ? [url] : [])];

test('every windowless start rechecks the extension through bench-chrome, without a raw Chrome launch', () => {
  calls.length = 0;
  startBenchChrome();
  startBenchChrome();
  assert.equal(calls.length, 2, 'a cold restart never reuses an earlier readiness result');
  for (const call of calls) {
    assert.equal(call.cmd, 'launchctl');
    assert.deepEqual(call.args, expected());
    assert.equal(call.options.timeout, 120_000, 'two bounded 40-second helper waits fit inside the GUI timeout');
  }
});

test('a failed pre-launch propagates its diagnostic and a later start retries', () => {
  fail = true;
  assert.throws(startBenchChrome, /extension did not start/);
  fail = false;
  startBenchChrome();
});

test('mark and sign-in URLs use the same helper so an intervening Chrome exit cannot cold-start without the extension', async (t) => {
  calls.length = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const url = 'http://account.localhost:8820/__mgb/mark?k=quote%22&next=mail';
  const marked = markChrome({ marks: async () => ['account'] } as any, url, 1);
  assert.deepEqual(calls[0].args, expected(url));
  t.mock.timers.tick(1000);
  assert.deepEqual(await marked, ['account']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-chrome-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const signed = setupSources({
    task: { surfaces: ['bu'] } as any,
    fixtures: { account: { secret: 'fixture-secret' } },
    env: { files: dir, urls: { account: 'http://account.localhost:8820/' } } as any,
    server: { load: async () => {}, state: async () => ({ account: { sessions: [{ how: 'link' }] } }) } as any,
  });
  await Promise.resolve();
  assert.equal(calls[1].cmd, 'launchctl');
  assert.deepEqual(calls[1].args.slice(0, -1), expected());
  assert.match(calls[1].args.at(-1)!, /^http:\/\/account\.localhost:8820\//);
  t.mock.timers.tick(1000);
  await signed;
});

test('a mark launcher failure performs no fixture polling', async () => {
  fail = true;
  let polls = 0;
  try {
    await assert.rejects(
      markChrome(
        {
          marks: async () => {
            polls++;
            return [];
          },
        } as any,
        'http://mail.localhost:8820/',
        1,
      ),
      /extension did not start/,
    );
    assert.equal(polls, 0);
  } finally {
    fail = false;
  }
});

test('an account sign-in launcher failure rejects the real MoPilot turn before fixture polling or any peer/model turn', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-signin-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let polls = 0;
  fail = true;
  try {
    await assert.rejects(
      mgbTurn({
        task: { surfaces: ['bu'], peers: [{ name: 'peer', prompt: () => 'never sent' }] },
        fixtures: { account: { secret: 'fixture-secret' } },
        env: { files: dir, urls: { account: 'http://account.localhost:8820/' } },
        server: {
          load: async () => {},
          state: async () => {
            polls++;
            return {};
          },
        },
      } as any),
      /extension did not start/,
    );
    assert.equal(polls, 0);
    assert.equal(turns, 0);
  } finally {
    fail = false;
  }
});

test('the default bench profile expands in the GUI launcher instead of falling back to Chrome defaults', async () => {
  const saved = process.env.MGB_CHROME_PROFILE;
  delete process.env.MGB_CHROME_PROFILE;
  try {
    const fresh = '../bench/drivers/mgb.mjs?default-profile';
    const driver = await import(fresh);
    calls.length = 0;
    driver.startBenchChrome();
    assert.deepEqual(calls[0].args, ['asuser', '777', process.execPath, helper, path.join(os.homedir(), 'mgb-scratch-chrome'), '40']);
  } finally {
    process.env.MGB_CHROME_PROFILE = saved;
  }
});
