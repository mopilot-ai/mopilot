// electron/app/ipc/chats.cjs onPrefs: a saved pref change reaches the services that read prefs live; a new cap on linked
// sessions starts what waits at once (live.orchestrator.pump), and an app without linked sessions is unaffected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/chats.cjs');

const events: { menus: number; sent: unknown[][] } = { menus: 0, sent: [] };

function prefsHook(live: any, zoom: any = { set: () => false }) {
  let onPrefs: (prefs: any) => void = () => {};
  register(
    { handle: () => {} },
    {
      readState: () => ({}),
      registerChats: (_ipc: any, o: any) => {
        onPrefs = o.onPrefs;
        return { patchPrefs: () => true };
      },
      STATE_FILE: () => '/nonexistent/ui-state.json',
      broadcastExcept: () => {},
      buildMenu: () => events.menus++,
      broadcastAll: (...args: unknown[]) => events.sent.push(args),
      zoom,
      live: { chats: { records: new Map() }, menuKeybindings: {}, ...live },
    },
  );
  return (prefs: any) => onPrefs(prefs);
}

test('a pref change starts what waits for a free slot, with or without linked sessions running', () => {
  let pumps = 0;
  prefsHook({ orchestrator: { pump: () => pumps++ } })({ maxParallelChildren: 5 });
  assert.equal(pumps, 1);
  assert.doesNotThrow(() => prefsHook({})({ maxParallelChildren: 5 }));
});

test('a pref change carries the zoom level its prefs ask for to every window (app/zoom.cjs)', () => {
  const levels: number[] = [];
  const hook = prefsHook({}, { set: (l: number) => levels.push(l) });
  hook({ zoomLevel: 1.5 });
  // an old font size not yet moved asks for its zoom too
  hook({ fontSize: 17 });
  hook({});
  assert.deepEqual(levels, [1.5, 1, 0]);
});

test("a pref change reaches the basic harnesses' own-MCP choice (harness/acp/ownMcp.cjs), with or without one", () => {
  let changed = 0;
  prefsHook({ acpOwnMcp: { changed: () => changed++ } })({ acpMcp: { opencode: { off: ['rea'] } } });
  assert.equal(changed, 1);
  assert.doesNotThrow(() => prefsHook({})({ acpMcp: {} }));
});

test("main's own prefs change (Chrome's side panel picks) is registerChats' patch function, on live", () => {
  const patch = () => true;
  const live: any = { chats: { records: new Map() }, menuKeybindings: {} };
  register(
    { handle: () => {} },
    {
      readState: () => ({}),
      registerChats: () => ({ patchPrefs: patch }),
      STATE_FILE: () => '/nonexistent/ui-state.json',
      broadcastExcept: () => {},
      buildMenu: () => events.menus++,
      broadcastAll: (...args: unknown[]) => events.sent.push(args),
      live,
    },
  );
  assert.equal(live.patchPrefs, patch);
});

test("a change to the default permission or extra folders reaches running Codex goals; other pref changes don't", async () => {
  const calls: any[] = [];
  const hook = prefsHook({
    codex: {
      permissionChanged: async (...a: any[]) => {
        calls.push(a);
        throw new Error('refused');
      },
    },
  });
  hook({ permission: 'full-access' });
  hook({ permission: 'full-access', zoomLevel: 1 });
  hook({ permission: 'full-access', additionalDirectories: ['/extra'] });
  // the rejection is noted, never thrown into the prefs callback
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [[], []]);
  assert.doesNotThrow(() => prefsHook({})({ permission: 'read-only' }));
});

test('registering with no saved state yet (a fake or a first start) reads no default permission and still hears the first one', () => {
  const calls: any[] = [];
  let onPrefs: (prefs: any) => void = () => {};
  register(
    { handle: () => {} },
    {
      readState: () => undefined,
      registerChats: (_ipc: any, o: any) => ((onPrefs = o.onPrefs), { patchPrefs: () => true }),
      STATE_FILE: () => '/nonexistent/ui-state.json',
      broadcastExcept: () => {},
      buildMenu: () => events.menus++,
      broadcastAll: (...args: unknown[]) => events.sent.push(args),
      zoom: { set: () => false },
      live: { chats: { records: new Map() }, menuKeybindings: {}, codex: { permissionChanged: async () => calls.push('changed') } },
    },
  );
  onPrefs({ permission: 'full-access' });
  assert.deepEqual(calls, ['changed']);
});

test("a pref change reaches MoMo's phone layer (remote/momoOps.cjs prefsChanged), with or without one", () => {
  const seen: any[] = [];
  const prefs = { momo: { paused: true } };
  prefsHook({ momoRemote: { prefsChanged: (p: any) => seen.push(p) } })(prefs);
  assert.deepEqual(seen, [prefs]);
  assert.doesNotThrow(() => prefsHook({})(prefs));
});

test('a new language renames the menus and leaves every window as it is, and the same language does nothing', () => {
  let changed = true;
  const hook = prefsHook({ language: { refresh: () => changed } });
  events.menus = 0;
  events.sent.length = 0;
  hook({ interfaceLanguage: 'ja' });
  assert.equal(events.menus, 1);
  assert.deepEqual(events.sent, []);
  changed = false;
  hook({ interfaceLanguage: 'ja' });
  assert.equal(events.menus, 1);
});
