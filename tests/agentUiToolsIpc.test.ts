// The wiring of the sidebar, settings, connector and registry tools (electron/app/ipc/agentUiTools.cjs): they write through
// main's chat store and prefs writer, ask in a consent card of the calling chat, and reach each harness's own MCP calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { register } = require('../electron/app/ipc/agentUiTools.cjs');

function fixture(t: any, over: { broker?: boolean; patched?: boolean; changed?: boolean; noState?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify({ projects: [{ id: 'p1', name: 'Alpha', path: '/w/alpha' }] }));
  const records = new Map<string, any>([
    ['me', { segments: [{ kind: 'codex', nativeId: 'me' }], meta: {} }],
    ['other', { segments: [{ kind: 'codex', nativeId: 'other' }], meta: {} }],
  ]);
  const sent: any[] = [];
  const broadcasts: any[] = [];
  const asked: any[] = [];
  const prefsWritten: any[] = [];
  const kinds: Record<string, string> = { me: 'claude' };
  const live: any = {
    capabilities: new Registry(),
    chats: {
      records,
      patchMeta: (id: string, patch: any) => (sent.push([id, patch]), over.changed !== false),
      get: (id: string) => ({ id }),
    },
    patchPrefs: over.patched === false ? undefined : (set: any) => (prefsWritten.push(set), true),
    computerUse: over.broker === false ? null : { broker: { ask: async (...a: any[]) => (asked.push(a), { decision: 'allow' }) } },
    controller: { ref: (id: string) => ({ kind: kinds[id], key: `key-${id}` }) },
    codex: {
      request: async (method: string) => (method === 'mcpServerStatus/list' ? { data: [{ name: 'cx', runtimeStatus: 'connected' }] } : {}),
    },
    acpOwnMcp: { status: () => ({ supported: true, load: true, servers: [{ name: 'm', off: false }] }) },
  };
  const controls: any[] = [];
  const deps: any = {
    live,
    app: { getPath: () => dir },
    readState: over.noState ? undefined : () => ({ prefs: { theme: 'light' } }),
    broadcastExcept: (...a: any[]) => broadcasts.push(a),
    claude: {
      turnApi: {
        control: async (key: string, method: string, arg: unknown) => (
          controls.push([key, method, arg]), method === 'mcpStatus' ? [{ name: 'cl', status: 'connected' }] : true
        ),
      },
    },
  };
  register(null, deps);
  const call = async (tool: string, args: any = {}) => {
    const res = await live.capabilities.invoke('me', 'me', tool, args);
    return res.ok ? JSON.parse(res.content[0].text) : { error: res.error };
  };
  return { live, call, sent, broadcasts, asked, prefsWritten, controls, kinds };
}

test('nothing is registered without a tool registry', () => {
  register(null, { live: { capabilities: null } });
});

test('a pin is saved through the chat store and every window hears it', async (t) => {
  const f = fixture(t);
  assert.equal((await f.call('set_pinned', { session_id: 'self', pinned: true })).changed, true);
  assert.deepEqual(f.sent, [['me', { pinned: true }]]);
  assert.deepEqual(f.broadcasts, [['chats:changed', null, { id: 'me', chat: { id: 'me' } }]]);
  const same = fixture(t, { changed: false });
  assert.equal((await same.call('set_pinned', { session_id: 'self', pinned: true })).changed, false);
  assert.deepEqual(same.broadcasts, []);
});

test('sections and settings go to main’s prefs writer; a change asks in the chat’s own card', async (t) => {
  const f = fixture(t);
  assert.deepEqual((await f.call('list_sections')).unsectioned, ['Alpha']);
  assert.equal((await f.call('create_section', { name: 'Work' })).created, true);
  assert.equal((await f.call('get_settings', { keys: ['theme'] })).settings[0].value, 'light');
  assert.equal((await f.call('set_setting', { key: 'theme', value: 'dark' })).changed, true);
  assert.equal(f.prefsWritten.length, 2);
  assert.deepEqual(f.asked, [['me', 'consent', { harness: 'claude', summary: 'set Theme to “dark”' }, { signal: f.asked[0][3].signal }]]);
});

test('without a card broker, or before the prefs writer is up, a change is not made', async (t) => {
  const bare = fixture(t, { broker: false });
  assert.equal((await bare.call('set_setting', { key: 'theme', value: 'dark' })).error.code, 'denied');
  const early = fixture(t, { patched: false });
  assert.equal((await early.call('create_section', { name: 'Work' })).error.code, 'save_failed');
});

test('connectors reach each harness’s own calls; the registry search is registered', async (t) => {
  const f = fixture(t);
  assert.deepEqual((await f.call('list_connectors')).connectors, [{ name: 'cl', status: 'connected', enabled: true }]);
  assert.equal((await f.call('reconnect_session_connector', { name: 'cl' })).reconnected, true);
  assert.deepEqual(f.controls.at(-1), ['key-me', 'reconnectMcp', { name: 'cl' }]);
  f.kinds.me = 'codex';
  assert.deepEqual((await f.call('list_connectors')).connectors, [{ name: 'cx', status: 'connected', enabled: true }]);
  f.kinds.me = 'acp:kimi';
  assert.deepEqual((await f.call('list_connectors')).connectors, [{ name: 'm', status: 'unknown', enabled: true }]);
  assert.equal(f.live.capabilities.has('search_mcp_registry'), true);
  delete f.kinds.me;
  assert.equal((await f.call('list_connectors')).error.code, 'unavailable');
});

test('another chat’s pin is found in main’s chat records and asks first; without a saved state the settings read as unset', async (t) => {
  const f = fixture(t);
  assert.equal((await f.call('set_pinned', { session_id: 'other', pinned: true })).changed, true);
  assert.deepEqual(f.sent, [['other', { pinned: true }]]);
  assert.equal(f.asked.length, 1);
  const bare = fixture(t, { noState: true });
  assert.equal((await bare.call('get_settings', { keys: ['theme'] })).settings[0].value, null);
});
