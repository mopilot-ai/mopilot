// The ACP host as electron/app/sessions.cjs builds it: runtime admission stands in for its sign-in callbacks and takes
// the catalog a new session offers, and a new chat's defaults are read from the saved prefs (no window needed).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain, unloadMain } from './support/electron-main-harness.ts';
after(() => unloadMain());

test('the ACP host gets admission and reads a new chat’s defaults from the saved prefs', async () => {
  const h = await loadMain({ state: { prefs: { basicDefaults: { opencode: { mode: 'mopilot-ask', config: { model: 'p/m' } } } } } });
  await h.ready();
  const host = h.one('AcpHost');
  assert.ok(host.opts.admission);
  assert.deepEqual(host.opts.defaults('opencode'), { mode: 'mopilot-ask', config: { model: 'p/m' } });
  assert.equal(host.opts.defaults('kimi'), null);
  h.writeState({ prefs: {} });
  assert.equal(host.opts.defaults('opencode'), null);
});

test('the ACP host sends the person’s name for a chat to its machine through main’s remote service, and with none a chat runs here', async () => {
  const h = await loadMain();
  await h.ready();
  // no Host service in this app (access is off): nothing to tell
  assert.equal(h.one('AcpHost').opts.remoteRename('acp:host-claude:c1', 'Mine'), null);
});

test("acp:recordedSettings: a chat's last mode and each option's last value, read from its transcript", async () => {
  const h = await loadMain();
  await h.ready();
  const read: string[] = [];
  const recs: Record<string, any[]> = {
    'acp:opencode:a': [
      { t: 'mode', modeId: 'ask' },
      { t: 'config', configId: 'model', value: 'a' },
      { t: 'mode', modeId: 'plan' },
      { t: 'config', configId: 'model', value: 'b' },
      { t: 'mode', modeId: 3 },
      { t: 'config', configId: 4 },
    ],
  };
  h.one('AcpHost').items = { readAsync: async (key: string) => (read.push(key), recs[key] ?? []) };
  assert.deepEqual(await h.invoke('acp:recordedSettings', 'acp:opencode:a'), { mode: 'plan', config: { model: 'b' } });
  assert.deepEqual(await h.invoke('acp:recordedSettings', 'acp:opencode:none'), { config: {} });
  assert.deepEqual(read, ['acp:opencode:a', 'acp:opencode:none']);
});

test('the ACP host lists the #1320 spike harnesses only in an unpackaged build', async () => {
  // what the host's harness list is built from (quirks/index.cjs ids, tested in acpSpikeQuirks.test.ts)
  const asked = async (cfg: Parameters<typeof loadMain>[0]) => {
    unloadMain();
    const h = await loadMain(cfg);
    await h.ready();
    return h.mod('harness/quirks/index.cjs').ids.mock.calls.map((c: any) => c.arguments[0]);
  };
  assert.deepEqual(await asked({}), [{ packaged: false }]);
  assert.deepEqual(await asked({ packaged: true }), [{ packaged: true }]);
});

test("the user's own MCP servers: the host asks the app's choice for each start's layer, and acp:ownMcp reads it", async () => {
  // the harness's quirks here are stand-ins without an mcp capability (the real opencode one: tests/acpOwnMcp.test.ts)
  const h = await loadMain({ state: { prefs: { acpMcp: { gemini: { load: false } } } } });
  await h.ready();
  const host = h.one('AcpHost');
  assert.deepEqual(host.opts.mcpEnv('gemini', { HOME: '/nowhere' }), {}, "a harness that can't turn them off starts as it is");
  assert.deepEqual(await h.invoke('acp:ownMcp', 'gemini'), {
    harness: 'gemini',
    label: 'gemini',
    supported: false,
    load: false,
    servers: [],
    pending: false,
  });
});
