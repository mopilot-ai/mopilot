// A chat's move to another agent can carry the login it goes on there (or the agent's own choice), as the app's switch sheet does: recorded on the pending switch, checked like a new chat's login, and changeable while the move waits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPanelOptions } = require('../electron/app/chromePanelOptions.cjs');

function world(o: { perChat?: boolean } = {}) {
  const sessions = new Map<string, any>([['c', {}]]);
  const patches: any[] = [];
  const live: any = {
    identity: {
      instances: () => [
        { account: 'a', label: 'A', status: 'ok' },
        { account: 'b', label: 'B', status: 'signedOut' },
      ],
      driver: () => ({ perChat: o.perChat ?? true }),
    },
    codex: {
      modelList: async () => ({
        data: [{ model: 'sol', displayName: 'sol', supportedReasoningEfforts: [], defaultReasoningEffort: null, isDefault: true }],
      }),
    },
    chats: { records: new Map(), patchMeta: () => true },
    controller: {
      state: {
        get: (id: string) => sessions.get(id),
        patch: (id: string, p: any) => {
          patches.push(p);
          sessions.set(id, { ...sessions.get(id), ...p });
        },
      },
      ref: () => ({ key: 'k' }),
    },
    acpAdmission: { list: () => [] },
    claudeTurns: { settings: () => null, pickOf: () => null, setOwn: () => undefined },
    patchPrefs: () => true,
  };
  const menus = createPanelOptions({
    live,
    claude: { probeInfo: () => ({ models: [] }), findBinary: async () => null, probe: async () => ({ models: [] }) },
    prefs: () => ({}),
    kindOf: () => 'claude',
    labelOf: (k: string | null) => (k === 'codex' ? 'Codex' : k),
    usable: async () => true,
  });
  return { menus, patches, pending: () => sessions.get('c').pendingSwitch };
}

test('the login rides on the pending switch; Automatic is its own flag; leaving it out is the old behaviour', async () => {
  const w = world();
  await w.menus.switchTo({ chatId: 'c', harness: 'codex', account: 'a' });
  assert.deepEqual([w.pending().account, w.pending().automaticAccount], ['a', false]);
  const auto = world();
  await auto.menus.switchTo({ chatId: 'c', harness: 'codex', account: null });
  assert.deepEqual([auto.pending().account, auto.pending().automaticAccount], [null, true]);
  const plain = world();
  await plain.menus.switchTo({ chatId: 'c', harness: 'codex' });
  assert.deepEqual([plain.pending().account, 'automaticAccount' in plain.pending()], [null, false]);
});

test('refused before anything is recorded: a signed-out or unknown login, an agent that cannot pin now', async () => {
  const w = world();
  for (const account of ['b', 'nobody'])
    await assert.rejects(w.menus.switchTo({ chatId: 'c', harness: 'codex', account }), /isn't available for this agent/);
  const nopin = world({ perChat: false });
  await assert.rejects(
    nopin.menus.switchTo({ chatId: 'c', harness: 'codex', account: 'a' }),
    /Codex can't put a chat on its own account now/,
  );
  assert.deepEqual([...w.patches, ...nopin.patches], []);
});

test('while the move waits, a login picked now is put on it and nothing else of it changes; asking again with none changes nothing', async () => {
  const w = world();
  await w.menus.switchTo({ chatId: 'c', harness: 'codex' });
  const before = { ...w.pending() };
  await w.menus.switchTo({ chatId: 'c', harness: 'codex', account: 'a' });
  assert.deepEqual(w.pending(), { ...before, account: 'a', automaticAccount: false });
  const count = w.patches.length;
  await w.menus.switchTo({ chatId: 'c', harness: 'codex' });
  assert.equal(w.patches.length, count);
});
