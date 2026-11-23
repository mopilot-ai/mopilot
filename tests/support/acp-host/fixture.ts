// electron/harness/acp.cjs beyond tests/acp.test.ts, against an in-process fake agent
// (tests/support/electron-acp-fake.ts): the JSON-RPC peer's edges, the agent process, sage_ tool
// permissions, fs/* and terminal/*, starting harnesses that can't start, reopening sessions,
// reapplied settings, Stop that the agent ignores, unattended work, extensions, sign-in, listing
// and searching chats, closing them, and the acp:* IPC.
import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSpawn } from '../electron-acp-fake.ts';
import { transcriptFixture } from '../transcript-fixture.ts';
export { fakeSpawn, fakeProc, INIT, NO_REPLY } from '../electron-acp-fake.ts';

const require = createRequire(import.meta.url);
export const acp = require('../../../electron/harness/acp.cjs');
const { ItemsLog } = require('../../../electron/platform/chats.cjs');
export const { recentIgnored, clearIgnored } = require('../../../electron/ignored.cjs');

export const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sage-acp-cov-')));
const fixture = transcriptFixture(dir);
export const cleanup = () => fixture.cleanup();
after(cleanup);
export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
export const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
export const until = async (fn: () => any, ms = 2000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await tick(2);
  }
};
export const NOW = 1_700_000_000_000;
export const KEY = 'acp:fake:c1';
export const CWD = '/work';

export function fakePty() {
  const spawned: any[] = [];
  const killed: string[] = [];
  return {
    spawned,
    killed,
    spawn: (id: string, opts: any, cb: any) => spawned.push({ id, opts, cb }),
    kill: (id: string) => void killed.push(id),
  };
}

export function setup(o: any = {}) {
  const items = fixture.own(new ItemsLog(fs.mkdtempSync(path.join(dir, 'items-'))));
  const sp = fakeSpawn(o.handlers ?? {}, o.spawnOpts ?? {});
  const pty = fakePty();
  const notified: any[] = [];
  const ended: string[] = [];
  const prepared: any[] = [];
  const tools =
    o.tools === null
      ? undefined
      : {
          prepare: async (key: string, opts: any) => (
            prepared.push(opts), { serverName: 'sage_0123456789ab', mcpServers: [{ name: 'sage_0123456789ab' }], key }
          ),
          admission: async () => o.admit !== false,
          end: (key: string) => void ended.push(key),
        };
  const host = new acp.AcpHost({
    items,
    quirks: (id: string) => (o.quirks ? o.quirks(id) : id === 'fake' ? { label: 'Fake', args: ['acp'] } : null),
    ids: ['fake'],
    resolveBin: o.resolveBin ?? (() => '/bin/fake'),
    env: () => ({ BASE: '1' }),
    tools,
    plugins: o.plugins,
    pty,
    notify: (...a: any[]) => notified.push(a),
    cwd: '/home',
    spawnFn: sp.spawnFn,
    admitted: o.admitted,
    admission: o.admission,
    defaults: o.defaults,
    mcpEnv: o.mcpEnv,
    remoteRename: o.remoteRename,
    dataDir: '/data',
    now: () => NOW,
    cancelRetryMs: 5,
    cancelForceMs: o.cancelForceMs ?? 15,
  });
  fixture.stopWith(() => host.closeAll());
  const events: any[] = [];
  host.on('event', (e: any) => events.push(e));
  const kinds = () => events.map((e) => e.kind);
  return { host, items, sp, pty, events, kinds, notified, ended, prepared };
}
