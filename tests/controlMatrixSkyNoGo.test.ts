// The control matrix (docs/control-plane/matrix.md), one no-go list on every executor: Codex Computer Use (Sky) runs
// a native thread's programs itself, and MoPilot stops a turn whose program binds an app computer use never
// controls (the built-in list) or one the user blocked in Settings → Computer use, as its own desktop tools refuse
// them. Case ids (CM-V..) start every title. NativeDesktopHolds, the program reader, the policy match and the
// built-in list are real; the desktop lock, the helper's app lookup and the app-server's messages are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';

export const GUARDS = ['electron/capabilities/', 'scripts/signing.mjs', 'shared/'];

const require = createRequire(import.meta.url);
const { NativeDesktopHolds } = require('../electron/capabilities/nativeDesktopHold.cjs');
const { HOST_BUNDLES, anyMatch } = require('../electron/capabilities/contract/desktopPolicy.cjs');
const { BUILT_IN_DENY } = require('../electron/capabilities/computerContract.cjs');
const { cuaAppQueries } = await import('../shared/cuaProgram.mjs');

/** The holds over a fake lock; `deny` is the user's blocked list, `lookup` the helper's apps.resolve answers by name. */
function rig(o: { deny?: string[]; lookup?: Record<string, string | null> | 'fails' | 'none' } = {}) {
  const busy: any[] = [];
  const resolved: string[][] = [];
  const cu: any = {
    controlling: null,
    app: null,
    closed: false,
    liveHolder: () => cu.controlling,
    onActivity: () => {},
    holder: (c: string) => c,
    epoch: () => 0,
    release: async () => {
      cu.controlling = null;
    },
    grants: o.deny ? { deny: () => o.deny } : undefined,
    helper: {
      acquireControl: async () => ({}),
      ...(o.lookup === 'none'
        ? {}
        : {
            resolveApps: async (queries: string[]) => {
              resolved.push(queries);
              if (o.lookup === 'fails') throw new Error('helper not running');
              const map = (o.lookup ?? {}) as Record<string, string | null>;
              return { apps: queries.map((q) => ({ query: q, app: map[q] ? { bundleId: map[q] } : null })) };
            },
          }),
    },
  };
  const holds = new NativeDesktopHolds({
    cu,
    isNativeThread: () => true,
    chatOf: () => 'chat',
    onBusy: (...a: any[]) => busy.push(a),
  });
  const run = (turnId: string, code: string) =>
    holds.observe({
      method: 'item/started',
      params: { threadId: 'nat', turnId, item: { type: 'mcpToolCall', server: 'cua_repl', tool: 'js', id: turnId, arguments: { code } } },
    });
  return { holds, run, busy, resolved, cu };
}
const program = (app: string) => `const a = await cua.getApp('${app}');\nawait a.click([10, 10]);`;

test('CM-V16: a Codex Computer Use program that binds an app on the built-in no-go list stops its turn, with the reason', async () => {
  // a bundle id names itself: stopped at once, no lookup
  const id = rig();
  id.run('t1', program('com.apple.keychainaccess'));
  // the refusal names the app: a bundle id reads as the built-in list's name for it (#1724)
  assert.deepEqual(id.busy, [
    [
      'nat',
      't1',
      'chat',
      null,
      'computer use never controls com.apple.keychainaccess (Keychain Access)',
      { reason: 'builtIn', app: 'com.apple.keychainaccess', name: 'Keychain Access' },
    ],
  ]);
  assert.equal(id.resolved.length, 0);
  // a name is looked up once through the helper, then known
  const named = rig({ lookup: { '1Password': 'com.1password.1password' } });
  named.run('t1', program('1Password'));
  await tick();
  await tick();
  // a name stays the name; the list's reason ("password manager") never replaces it
  assert.deepEqual(named.busy, [
    [
      'nat',
      't1',
      'chat',
      null,
      'computer use never controls 1Password (password manager)',
      { reason: 'builtIn', app: '1Password', name: '1Password' },
    ],
  ]);
  named.run('t2', program('1Password'));
  assert.equal(named.busy.length, 2, 'a known name stops at once');
  assert.deepEqual(named.resolved, [['1Password']]);
  // "Name.app" is a name, looked up like one
  const dotted = rig({
    lookup: { 'Keychain Access.app': 'com.apple.keychainaccess', 'Notes.app': 'com.apple.Notes' },
    deny: ['com.apple.Notes'],
  });
  dotted.run('t1', program('Notes.app'));
  await tick();
  await tick();
  assert.deepEqual(dotted.resolved, [['Notes.app']]);
  assert.match(dotted.busy[0][4], /Notes.app is blocked/);
  // a turn that ended while the helper answered is not stopped
  const late = rig({ lookup: { Passwords: 'com.apple.Passwords' } });
  late.run('t1', program('Passwords'));
  late.holds.observe({ method: 'turn/completed', params: { threadId: 'nat', turn: { id: 't1' } } });
  await tick();
  await tick();
  assert.equal(late.busy.length, 0);
  assert.equal(late.holds.refused.size, 0);
  // the stopped turn never takes the desktop again; a second program on it is not stopped twice
  named.run('t2', program('1Password'));
  assert.equal(named.busy.length, 2);
});

test('CM-V17: an app the user blocked in Settings → Computer use stops the turn; an allowed app keeps the lock', async () => {
  const r = rig({ deny: ['com.apple.Notes'], lookup: { Notes: 'com.apple.Notes', Calendar: 'com.apple.iCal' } });
  r.run('t1', program('Notes'));
  await tick();
  await tick();
  assert.deepEqual(r.busy, [
    ['nat', 't1', 'chat', null, 'Notes is blocked in Settings → Computer use', { reason: 'blocked', app: 'Notes', name: 'Notes' }],
  ]);
  r.run('t2', program('Calendar'));
  await tick();
  await tick();
  assert.equal(r.busy.length, 1, 'Calendar is not blocked');
  assert.equal(r.cu.controlling, 'chat', 'the allowed program holds the desktop');
});

test('CM-V18: an app the helper can’t find, a lookup that fails or an older helper leave the turn running (Sky refuses unknown apps itself)', async () => {
  for (const lookup of [{}, 'fails', 'none'] as const) {
    const r = rig({ lookup });
    r.run('t1', program('Nowhere'));
    await tick();
    await tick();
    assert.equal(r.busy.length, 0, String(lookup));
  }
  // an app the helper didn't find is remembered as not found: the next program isn't looked up again
  const twice = rig({ lookup: {} });
  twice.run('t1', program('Nowhere'));
  await tick();
  await tick();
  twice.run('t2', program('Nowhere'));
  assert.deepEqual(twice.resolved, [['Nowhere']]);
  assert.equal(twice.busy.length, 0);
  // a program that names no app binds nothing to check
  const r = rig();
  r.run('t1', 'await sky.screenshot();');
  assert.equal(r.busy.length, 0);
  assert.equal(r.resolved.length, 0);
});

test("CM-V19: a Codex Computer Use program that binds MoPilot itself, a development build's Electron too, stops its turn and points at the browser tools (#1362)", async () => {
  const self = (name: string) =>
    `computer use never controls ${name} (MoPilot itself). Its projects and chats are listed by the list_sidebar tool, and its browser pane is reached through the browser tools (browser_*, or the Browser plugin's "iab" browser), never through computer use.`;
  // by bundle id (the packaged app, a development build's Electron) and by name, at once: no helper lookup, so a helper
  // that is missing, fails or was never built can't let a program act on MoPilot (the #1362 real-app run had none)
  for (const lookup of ['none', 'fails', {}] as const) {
    const r = rig({ lookup });
    const apps = ['ai.mopilot.code', 'com.github.Electron', 'MoPilot', 'mopilot.app', 'MoPilot Computer Use', 'Electron'];
    apps.forEach((app, n) => r.run(`t${n}`, program(app)));
    assert.deepEqual(
      r.busy.map((b) => [b[1], b[4]]),
      apps.map((app, n) => [`t${n}`, self(app)]),
      String(lookup),
    );
    // the chat's note names MoPilot, however the program named it
    assert.deepEqual(
      r.busy.map((b) => b[5]),
      apps.map((app) => ({ reason: 'self', app, name: 'MoPilot' })),
    );
    assert.deepEqual(r.resolved, [], 'never looked up');
  }
  // a getApp never bound to a variable acts all the same (the #1362 run's own form), as does an { id } object's
  for (const code of [
    'await cua.getApp("MoPilot");',
    'await (await cua.getApp("MoPilot")).click(343);',
    "const s = await (await cua.getApp({ id: 'ai.mopilot.code' })).getAXState();",
  ]) {
    const r = rig({ lookup: 'fails' });
    r.run('t1', code);
    assert.equal(r.busy.length, 1, code);
    assert.match(r.busy[0][4], /\(MoPilot itself\)\. Its projects and chats are listed by the list_sidebar tool/, code);
    assert.deepEqual(r.busy[0][5].reason, 'self', code);
  }
  // the user's blocked list and the built-in one reach an unbound getApp too; two names in one program are both read
  const unbound = rig({ deny: ['com.apple.Notes'] });
  unbound.run('t1', "await (await cua.getApp('com.apple.Notes')).click([1, 1]);");
  assert.match(unbound.busy[0][4], /com.apple.Notes is blocked in Settings/);
  const both = rig({ lookup: 'none' });
  both.run('t1', "const a = await cua.getApp('Calendar'); await (await cua.getApp('com.apple.keychainaccess')).click([1, 1]);");
  assert.match(both.busy[0][4], /Keychain Access/);
  // a name that only starts like it is an ordinary app, looked up as any other
  const near = rig({ lookup: { MoPilotish: 'com.example.mopilotish' } });
  near.run('t1', program('MoPilotish'));
  await tick();
  await tick();
  assert.deepEqual(near.resolved, [['MoPilotish']]);
  assert.equal(near.busy.length, 0);
  // the user's blocked list and the built-in one still answer for every other app
  const other = rig({ deny: ['com.apple.Notes'] });
  other.run('t1', program('com.apple.Notes'));
  assert.match(other.busy[0][4], /is blocked in Settings/);
});

test('CM-V20: the bundle id the app is packaged and signed under is MoPilot itself on every no-go list', async () => {
  const { APP_BUNDLE_ID } = await import('../scripts/signing.mjs');
  assert.ok(anyMatch(HOST_BUNDLES, APP_BUNDLE_ID), 'desktop_* and Codex Computer Use');
  assert.ok(anyMatch(HOST_BUNDLES, `${APP_BUNDLE_ID}.helper`), 'its helpers');
  assert.ok(
    BUILT_IN_DENY.some((d: any) => anyMatch([d.pattern], APP_BUNDLE_ID)),
    "the helper's own floor",
  );
});

test('CM-V19: the apps a program names in getApp are read from every call, bound or not, never from elsewhere', () => {
  assert.deepEqual(
    cuaAppQueries(
      `const a = await cua.getApp('Notes'); await (await cua.getApp("MoPilot")).click(1); cua.getApp({ id: 'x.y' }); cua.getApp('Notes');`,
    ),
    ['Notes', 'MoPilot', 'x.y'],
  );
  // strings outside a getApp call, comments, an empty name, a method of another object, a call left open
  assert.deepEqual(
    cuaAppQueries(`await app.typeText('MoPilot'); // cua.getApp('Mail')\nfoo.cua.getApp('Mail'); cua.getApp(''); cua.getApp(n)`),
    [],
  );
  assert.deepEqual(cuaAppQueries("cua.getApp('Open"), ['Open']);
  assert.deepEqual(cuaAppQueries(null), []);
});
