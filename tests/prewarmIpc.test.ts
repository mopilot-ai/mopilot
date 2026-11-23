// The prewarm IPC (electron/app/ipc/prewarm.cjs, #1664): a window's hint warms through its family's hook, made on first
// use from main's late-bound adapters; that window's take gets it; the window closing, the app quitting and the
// shared.prewarm kill switch let it go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { tick as settle } from './support/async-scenarios.ts';

const { register } = createRequire(import.meta.url)('../electron/app/ipc/prewarm.cjs');

function rig(on = true, o: { takeThrows?: boolean } = {}) {
  const log: any[] = [];
  const ons = new Map<string, (...a: any[]) => any>();
  const handles = new Map<string, (...a: any[]) => any>();
  const app = new EventEmitter();
  const live = new Set<string>();
  const deps: any = {
    app,
    isFlagEnabled: (k: string) => (k === 'shared.prewarm' ? on : false),
    claude: {
      prewarm: async (key: string) => void (log.push(['claude.prewarm', key]), live.add(key)),
      prewarmTaken: (key: string) => {
        if (o.takeThrows) throw new Error('the CLI went away');
        log.push(['claude.taken', key]);
      },
      prewarmDrop: async (key: string) => void (log.push(['claude.drop', key]), live.delete(key)),
      billingSig: () => 'subscription',
      artifactsOf: () => ({ on: true }),
      nativeChromeFor: () => false,
      turnApi: { isLive: (key: string) => live.has(key) },
    },
    live: {
      claudeTurns: {
        live: new Map(),
        settings: () => ({ account: 'default', model: 'sonnet', effort: null, permission: 'default', fast: false, prefs: {} }),
      },
      codex: {
        provider: () => null,
        initialize: async () => log.push(['codex.initialize']),
        defaults: async () => ({}),
        readyAt: 1,
      },
      acpHost: { agents: new Map(), chats: new Map(), starting: new Map(), agent: async () => log.push(['acp.agent']) },
    },
  };
  register({ on: (c: string, fn: any) => ons.set(c, fn), handle: (c: string, fn: any) => handles.set(c, fn) }, deps);
  const window = (id: number) => Object.assign(new EventEmitter(), { id });
  const hint = (w: any, spec: any) => ons.get('session:prewarm')!({ sender: w }, spec);
  const take = (w: any, spec: any) => handles.get('session:prewarmTake')!({ sender: w }, spec);
  return { log, app, window, hint, take };
}

test("a window's hint warms through its family's hook, and that window's take gets it", async () => {
  const { log, window, hint, take } = rig();
  const w = window(1);
  hint(w, { kind: 'claude', cwd: '/w' });
  await settle();
  const key = log.find((x) => x[0] === 'claude.prewarm')?.[1];
  assert.match(key, /^claude:/);
  assert.equal(await take(window(2), { kind: 'claude', cwd: '/w' }), null, "another window's take");
  assert.deepEqual(await take(w, { kind: 'claude', cwd: '/w' }), { id: key.slice('claude:'.length) });
  assert.equal(await take(w, undefined), null);
});

test('A5: the window closing and the app quitting let go of what it warmed, on every family', async () => {
  const { log, app, window, hint } = rig();
  const a = window(1);
  const b = window(2);
  hint(a, { kind: 'claude', cwd: '/w' });
  hint(a, { kind: 'claude', cwd: '/w' });
  hint(b, { kind: 'codex', params: null });
  hint(window(3), { kind: 'acp:opencode' });
  hint(window(4), undefined);
  await settle();
  assert.ok(log.some((x) => x[0] === 'codex.initialize'));
  assert.ok(log.some((x) => x[0] === 'acp.agent'));
  a.emit('destroyed');
  await settle();
  assert.equal(log.filter((x) => x[0] === 'claude.drop').length, 1);
  hint(a, { kind: 'claude', cwd: '/w' });
  await settle();
  app.emit('will-quit');
  await settle();
  assert.equal(log.filter((x) => x[0] === 'claude.drop').length, 2);
});

test('with shared.prewarm switched off nothing starts', async () => {
  const { log, window, hint } = rig(false);
  hint(window(1), { kind: 'claude', cwd: '/w' });
  hint(window(1), { kind: 'codex', params: null });
  await settle();
  assert.deepEqual(log, []);
});

test('a take that fails answers null, so the send starts cold', async () => {
  const { window, hint, take } = rig(true, { takeThrows: true });
  const w = window(1);
  hint(w, { kind: 'claude', cwd: '/w' });
  await settle();
  assert.equal(await take(w, { kind: 'claude', cwd: '/w' }), null);
});
