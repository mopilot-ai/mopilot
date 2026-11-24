// A running Host writes inside its data folder (its config folder is inside it for a Host started with `--data-dir`) and nowhere else (#5617): the Host's own folders are what a sandbox for a remote client's agents would deny, so a file the Host starts keeping somewhere else (a cache in the home folder, a key beside the socket, a state file in the temp folder) is a file that sandbox would leave open. The Host is started as a process, paired, and given a turn on the fake ACP agent, in a home and a temp folder of its own; every file that appears in either (outside the folder the chat ran in) must be inside the data folder.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createPaths } from '../host/src/paths.mjs';
import { line } from './support/host-line.ts';
import { keySafe } from './support/hostKeySafe.ts';

export const GUARDS = ['host/'];

const { loadIdentity, pairWith } = createRequire(import.meta.url)('../electron/host/pairingClient.cjs');
const ROOT = path.join(import.meta.dirname, '..');
const AGENT = path.join(ROOT, 'tests/fixtures/fake-acp-agent.mjs');
// a short path: a unix socket's own path may not pass about a hundred characters
const base = fs.realpathSync(fs.mkdtempSync(path.join(fs.existsSync('/tmp') ? '/tmp' : os.tmpdir(), 'hw-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const until = async (fn: () => any, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
};
/** Every file and folder below a root, as paths. @param {string} root @returns {string[]} */
const walk = (root: string): string[] =>
  fs.readdirSync(root, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(root, e.name);
    return e.isDirectory() ? [p, ...walk(p)] : [p];
  });

test('a Host that serves, pairs a client and runs a turn writes only inside its data folder', async () => {
  const home = path.join(base, 'home');
  const tmp = path.join(base, 'tmp');
  const data = path.join(base, 'data');
  const work = path.join(base, 'work');
  for (const d of [home, tmp, data, work]) fs.mkdirSync(d);
  fs.writeFileSync(
    path.join(data, 'harnesses.json'),
    JSON.stringify({
      fake: { label: 'Fake', bin: process.execPath, args: [AGENT], env: { FAKE_ACP_STATE: path.join(data, 'agent-state') } },
    }),
  );
  const env = {
    ...process.env,
    HOME: home,
    TMPDIR: tmp,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    // the Host does not run Electron: where the electron package is installed without its binary (CI) it would fetch one into the home folder's cache, a file of the machine's tooling and not of the Host, so a fetch is kept inside the data folder, which this test allows
    ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
    electron_config_cache: path.join(data, 'electron-cache'),
  };
  const child = spawn(process.execPath, [path.join(ROOT, 'host/bin/mopilot-host.mjs'), 'serve', '--data-dir', data], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  let printed = '';
  child.stdout.on('data', (c) => (printed += c));
  try {
    await until(() => /Pairing code: \S+/.test(printed));
    const sock = createPaths({ dataDir: data, env: {} }).socketPath;
    const app = loadIdentity(path.join(base, 'app.json'), keySafe);
    const c = line(sock);
    await pairWith(c.request, app, /Pairing code: (\S+)/.exec(printed)![1]);
    const sent: any = await c.request('send', { key: 'acp:fake:a', text: 'hello there', cwd: work });
    await until(async () => ((await c.request('turn', { turnId: sent.turnId })) as any)?.state === 'ended');
    c.close();
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
  }
  const outside = [...walk(home), ...walk(tmp)].map((p) => path.relative(base, p));
  assert.deepEqual(outside, [], 'the Host kept a file outside its data folder');
  assert.ok(walk(data).length > 5, 'and it did keep its files inside it');
});
