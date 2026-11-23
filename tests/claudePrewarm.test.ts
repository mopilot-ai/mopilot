// Claude Code's prewarm hook (electron/harness/claude/prewarm.cjs, #1664) over the real ClaudeAdapter: the CLI it starts
// is the one the chat's first turn would start, its key follows every setting that turn depends on, and a model picked
// after the warm is applied to the warmed CLI in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../electron/session/state.cjs');
const { ClaudeAdapter } = require('../electron/harness/claude/adapter.cjs');
const { claudePrewarm } = require('../electron/harness/claude/prewarm.cjs');

const ref = (chatId: string) => ({ kind: 'claude', id: chatId.replace(/^claude:/, ''), instance: null, key: chatId });

function setup() {
  let prefs: any = { permission: 'default', claudeSelection: { model: 'sonnet', effort: 'low', fast: false }, claudeBin: '/bin/claude' };
  let accounts: any = { active: 'default', accounts: [{ id: 'default', loggedIn: true }] };
  let billing = 'subscription';
  let chrome = false;
  let artifacts = true;
  const live = new Set<string>();
  const sent: any[] = [];
  const controls: any[] = [];
  const titles: any[] = [];
  const prewarmed: any[] = [];
  const taken: string[] = [];
  const dropped: string[] = [];
  const adapter = new ClaudeAdapter({
    api: {
      isLive: (k: string) => live.has(k),
      control: async (k: string, m: string, a?: unknown) => {
        if (m === 'generateTitle') {
          titles.push([k, a]);
          return 'A title';
        }
        controls.push([k, m, a]);
      },
      // the login's warm title CLI (o.helper), never the warmed chat CLI, writes a new chat's title (#3413)
      title: async (...args: any[]) => (args[5]?.helper && titles.push(['helper', args[0]]), 'A title'),
      rename: async () => {},
      userTitle: async () => null,
      goalStatus: async () => null,
      sessionCwd: () => null,
      accounts: () => accounts,
      metered: () => false,
    },
    probeInfo: () => ({ models: [{ value: 'sonnet' }, { value: 'opus' }], fastBlocked: null }),
    state: new SessionStore(),
    prefs: () => prefs,
    send: async (chatId: string, key: string, opts: any) => {
      sent.push({ ...opts, chatId });
      live.add(key);
      return { elsewhere: [] };
    },
    enqueue: () => {},
    chatOf: (key: string) => key,
    ref,
    emit: () => true,
    setGoal: () => false,
    graceMs: 0,
    now: () => 1_000_000,
  });
  const hook = claudePrewarm({
    adapter,
    api: {
      prewarm: async (key: string, opts: any) => {
        prewarmed.push({ key, opts });
        live.add(key);
      },
      prewarmTaken: (key: string) => void taken.push(key),
      prewarmDrop: async (key: string) => {
        dropped.push(key);
        live.delete(key);
      },
      billingSig: () => billing,
      nativeChromeFor: () => chrome,
      artifactsOf: () => ({ on: artifacts }),
      isLive: (key: string) => live.has(key),
    },
  });
  return {
    adapter,
    hook,
    live,
    sent,
    controls,
    titles,
    prewarmed,
    taken,
    dropped,
    setPrefs: (p: any) => (prefs = { ...prefs, ...p }),
    setAccounts: (a: any) => (accounts = a),
    setBilling: (b: string) => (billing = b),
    setChrome: (on: boolean) => (chrome = on),
    setArtifacts: (on: boolean) => (artifacts = on),
  };
}

test('nothing is warmed for a chat whose folder the send makes, or for a temporary chat', () => {
  const { hook } = setup();
  assert.equal(hook.key({ kind: 'claude' }), null);
  assert.equal(hook.key({ kind: 'claude', cwd: '' }), null);
  assert.equal(hook.key({ kind: 'claude', cwd: '/w', ephemeral: true }), null);
  assert.equal(typeof hook.key({ kind: 'claude', cwd: '/w' }), 'string');
});

test('I2: the key changes with the folder, the login a new chat runs on, billing, Claude in Chrome, the Artifact switch, model, effort, permission and binary', () => {
  const t = setup();
  const k = () => t.hook.key({ kind: 'claude', cwd: '/w' });
  const seen = new Set([k()]);
  const change = (fn: () => void) => {
    fn();
    assert.ok(!seen.has(k()), 'a new key');
    seen.add(k());
  };
  assert.notEqual(t.hook.key({ kind: 'claude', cwd: '/other' }), k());
  change(() => t.setAccounts({ active: 'b1', accounts: [{ id: 'b1', loggedIn: true }] }));
  change(() => t.setBilling('api-key'));
  change(() => t.setChrome(true));
  change(() => t.setArtifacts(false));
  change(() => t.setPrefs({ claudeSelection: { model: 'opus', effort: 'low', fast: false } }));
  change(() => t.setPrefs({ claudeSelection: { model: 'opus', effort: 'high', fast: false } }));
  change(() => t.setPrefs({ permission: 'full-access' }));
  change(() => t.setPrefs({ claudeBin: '/other/claude' }));
});

test("I5: the warmed CLI starts with exactly what the chat's first turn hands send(), and that turn sends only its prompt", async () => {
  const t = setup();
  const h = await t.hook.warm({ kind: 'claude', cwd: '/w' });
  assert.match(h.id, /^[0-9a-f-]{36}$/);
  assert.equal(h.key, `claude:${h.id}`);
  assert.equal(t.hook.valid?.(h), true);
  assert.deepEqual(t.hook.claim?.(h), { id: h.id });
  assert.deepEqual(t.taken, [h.key]);
  // the chat the window then creates under that id, and its first message
  t.adapter.registerSession(h.key, { cwd: '/w' });
  const r = await t.adapter.startTurn(h.key, ref(h.key), { text: 'hi', opts: {} });
  assert.equal(r.started, true);
  assert.deepEqual(t.prewarmed[0].opts, t.sent[0], 'the same options, so send() keeps the warmed CLI');
  assert.deepEqual(t.controls, [], 'nothing to change in place');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(t.titles, [['helper', 'hi']], 'the title is written beside the warmed process, which nothing reconfigures');
});

test('a model and permission picked after the warm are applied to the warmed CLI in place', async () => {
  const t = setup();
  const h = await t.hook.warm({ kind: 'claude', cwd: '/w' });
  t.hook.claim?.(h);
  t.setPrefs({ claudeSelection: { model: 'opus', effort: 'low', fast: false }, permission: 'full-access' });
  t.adapter.registerSession(h.key, { cwd: '/w' });
  await t.adapter.startTurn(h.key, ref(h.key), { text: 'hi', opts: {} });
  assert.deepEqual(
    t.controls.map(([, m]) => m),
    ['setModel', 'setPermissionMode'],
  );
});

test('a warmed CLI no chat took is dropped and forgotten; one that quit meanwhile is not valid', async () => {
  const t = setup();
  const h = await t.hook.warm({ kind: 'claude', cwd: '/w' });
  assert.ok(t.adapter.live.has(h.key));
  await t.hook.dispose(h);
  assert.deepEqual(t.dropped, [h.key]);
  assert.equal(t.adapter.live.has(h.key), false);
  assert.equal(t.hook.valid?.(h), false);
});
