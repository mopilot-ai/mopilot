// Which browser a Host runs (host/src/browserService.mjs, status.mjs; package 2.6): a Chrome it has, else the pinned headless shell, downloaded in the background on the first open; and whether the Host reports it can run one (`iab`).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createHostBrowser } from '../host/src/browserService.mjs';
// @ts-ignore
import { ChromiumError } from '../host/src/chromium.mjs';
// @ts-ignore
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore
import { hostStatus } from '../host/src/status.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';
import { deferred, tick } from './support/async-scenarios.ts';
import { FakeChromium } from './support/fake-chromium.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-fallback-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;

/** A Host browser whose machine has `system` (a Chrome), `shell` (an installed headless shell) or neither. */
function setup(o: { system?: string | null; env?: Record<string, string>; platform?: NodeJS.Platform; arch?: string } = {}) {
  const dataDir = fs.mkdtempSync(path.join(dir, `d${++n}-`));
  const epochs = createEpochStore(path.join(dataDir, 'e.json'), { report: () => undefined });
  const chromium = new FakeChromium();
  const state = { shell: null as string | null, installs: [] as any[], launches: [] as any[] };
  let finish = deferred<void>();
  const svc = createHostBrowser({
    dataDir,
    env: o.env ?? {},
    epochs,
    platform: o.platform ?? 'linux',
    arch: o.arch ?? 'x64',
    find: () => o.system ?? null,
    installed: () => state.shell,
    install: (async (opts: any) => (state.installs.push(opts), finish.promise)) as any,
    launch: (async (opts: any) => (state.launches.push(opts), chromium.launch())) as any,
  });
  const conn = svc.protocol.connection(() => undefined);
  const open = async () => {
    await conn.call('host.hello', helloParams()).catch(() => undefined);
    return conn.call('browser.open', { chatId: 'c', epoch: 1 });
  };
  return { svc, dataDir, state, open, finish: () => finish, reset: () => (finish = deferred<void>()), chromium };
}
const refused = (code: string) => (e: any) => e instanceof ChromiumError && e.code === code;

test('a Host with a Chrome uses it and never downloads', async () => {
  const w = setup({ system: '/usr/bin/google-chrome' });
  await w.open();
  assert.deepEqual(w.state.launches, [{ executable: '/usr/bin/google-chrome', userDataDir: path.join(w.dataDir, 'browser') }]);
  assert.deepEqual(w.state.installs, []);
  assert.equal(w.svc.available(), true);
  w.svc.dispose();
});

test('A1/B5: with none, the first open starts the download and answers at once; opens meanwhile do not start another; the one after it launches the browser', async () => {
  const w = setup();
  await assert.rejects(w.open(), refused('downloading'));
  await assert.rejects(w.open(), (e: any) => refused('downloading')(e) && /about 100 MB/.test(e.message));
  assert.equal(w.state.installs.length, 1);
  assert.deepEqual(w.state.installs[0], { dir: path.join(w.dataDir, 'browser-bin'), platform: 'linux', arch: 'x64' });
  w.state.shell = '/data/browser-bin/chrome-headless-shell';
  w.finish().resolve();
  await tick();
  await w.open();
  assert.equal(w.state.launches[0].executable, '/data/browser-bin/chrome-headless-shell');
  assert.equal(w.state.installs.length, 1);
  w.svc.dispose();
});

test('B2: a download that failed is told once to the next open, and the open after that tries again', async () => {
  const w = setup();
  await assert.rejects(w.open(), refused('downloading'));
  w.finish().reject(new Error('Could not download the headless browser: offline.'));
  await tick();
  w.reset();
  await assert.rejects(
    w.open(),
    (e: any) => refused('download_failed')(e) && /offline/.test(e.message) && /Install Chrome/.test(e.message),
  );
  assert.equal(w.state.installs.length, 1);
  await assert.rejects(w.open(), refused('downloading'));
  assert.equal(w.state.installs.length, 2);
  w.finish().resolve();
  await tick();
  w.svc.dispose();
});

test('a Host that may not or cannot download says it has no Chrome; one that has the shell installed runs it', async () => {
  const off = setup({ env: { MOPILOT_HOST_BROWSER_DOWNLOAD: '0' } });
  await assert.rejects(off.open(), (e: any) => refused('no_chromium')(e) && /MOPILOT_HOST_CHROME/.test(e.message));
  assert.deepEqual(off.state.installs, []);
  assert.equal(off.svc.available(), false);
  off.state.shell = '/data/shell';
  assert.equal(off.svc.available(), true);
  await off.open();
  assert.equal(off.state.launches[0].executable, '/data/shell');
  off.svc.dispose();
  const odd = setup({ platform: 'win32', arch: 'x64' });
  await assert.rejects(odd.open(), refused('no_chromium'));
  assert.equal(odd.svc.available(), false);
  const can = setup();
  assert.equal(can.svc.available(), true);
});

test('status reports the in-app browser only for a Host that can run one', () => {
  assert.equal(hostStatus({ running: true }).capabilities.iab, false);
  assert.deepEqual(hostStatus({ running: true, browser: true }).capabilities, {
    iab: true,
    cu: false,
    desktop: false,
    bu: false,
    shell: false,
  });
});
