// HarnessUpdates (electron/harness/harnessUpdates.cjs) over real harness runs with a fake pty and quiet spawner, fake
// readers and timers: what tests/harnessUpdates.test.ts and harnessUpdateAll.test.ts drive.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HarnessUpdates } = require('../../electron/harness/harnessUpdates.cjs');
const { HarnessRuns } = require('../../electron/harness/harnessRuns.cjs');

export const npmMethod = (pkg: string, o: any = {}) => ({
  via: 'npm',
  argv: ['/p/bin/npm', 'install', '-g', '--prefix', '/p', `${pkg}@latest`],
  shown: `npm install -g --prefix /p ${pkg}@latest`,
  pkg,
  cask: false,
  env: { PATH: '/p/bin:/usr/bin' },
  blocked: null,
  from: 'npm (/p)',
  packageJson: `/p/lib/node_modules/${pkg}/package.json`,
  ...o,
});

export function setup(o: any = {}) {
  const sent: any[] = [];
  const ptys: any[] = [];
  const quiet: any[] = [];
  const restarts: string[] = [];
  const timers: { fn: () => void; ms: number; unref: boolean }[] = [];
  let installed = o.installed ?? [
    { kind: 'acp:kimi', bin: '/p/bin/kimi', version: null },
    { kind: 'codex', bin: '/p/bin/codex', version: '0.162.0' },
  ];
  const methods: Record<string, any> = o.methods ?? { 'acp:kimi': npmMethod('@moonshot-ai/kimi-code'), codex: npmMethod('@openai/codex') };
  const latestOf: Record<string, string | null> = o.latest ?? { '@moonshot-ai/kimi-code': '2.2.0', '@openai/codex': '0.170.0' };
  const versions: Record<string, string | null> = o.versions ?? { 'acp:kimi': '1.0.0', codex: null };
  let busy: Record<string, { id: string; title: string }[]> = {};
  let health: (bin: string) => { version: string | null; broken: string | null } = () => ({ version: null, broken: null });
  const forgot: string[] = [];
  const runs = new HarnessRuns({
    pty: { spawn: (id: string, opts: any, h: any) => ptys.push({ id, opts, h }), write() {}, resize() {}, kill() {} },
    spawnQuiet: (argv: string[], q: any, h: any) => (quiet.push({ argv, q, h }), { kill: () => quiet.push('killed') }),
    home: () => '/home/ada',
    broadcast: () => undefined,
    afterExit: async () => undefined,
    defer: (fn: () => void) => fn(),
  });
  let now = 1000;
  const updates = new HarnessUpdates({
    runs,
    installed: async () => installed,
    method: (kind: string) => methods[kind],
    latest: {
      npm: async (pkg: string) => latestOf[pkg] ?? null,
      brew: async (_b: string, name: string) => latestOf[name] ?? null,
      forget: (k: string) => forgot.push(k),
      keyOf: (via: string, pkg: string, cask: boolean) => `${via}:${cask ? 'cask:' : ''}${pkg}`,
    },
    versionStatus: (kind: string, v: string) => (kind === 'codex' ? (v === '0.170.0' && o.knownBad ? 'knownBad' : 'unverified') : null),
    readVersion: async (m: any) => (m.packageJson ? (versions[Object.keys(methods).find((k) => methods[k] === m)!] ?? null) : null),
    health: async (bin: string) => health(bin),
    busyChats: (kind: string) => busy[kind] ?? [],
    restart: (kind: string) => {
      if (o.restartThrows) throw new Error('no server');
      restarts.push(kind);
    },
    broadcast: (ch: string, p: any) => sent.push([ch, structuredClone(p)]),
    now: () => (now += 1),
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const t = { fn, ms, unref: false, unrefFn: undefined as any };
        timers.push(t);
        return Object.assign(t, { unref: () => (t.unref = true) });
      },
      clearTimeout: (t: any) => {
        const i = timers.indexOf(t);
        if (i >= 0) timers.splice(i, 1);
      },
      random: () => 0.5,
    },
  });
  const tick = async () => {
    const list = timers.splice(0);
    for (const t of list) t.fn();
    await flush();
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  /** the pty or quiet run for `n`, ended with `code` */
  const end = async (code: number | null, which = ptys.at(-1)?.h ?? quiet.at(-1)?.h) => {
    which.onExit({ exitCode: code });
    await flush();
    await flush();
  };
  return {
    updates,
    runs,
    sent,
    ptys,
    quiet,
    restarts,
    timers,
    forgot,
    tick,
    end,
    flush,
    info: (k: string) => updates.state().harnesses.find((h: any) => h.harness === k),
    setBusy: (b: typeof busy) => (busy = b),
    setHealth: (fn: typeof health) => (health = fn),
    setInstalled: (l: any[]) => (installed = l),
    versions,
    latestOf,
  };
}
