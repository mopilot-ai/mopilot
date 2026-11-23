// A new chat's menu lists the logins of its harness (Claude Code and Codex), signed-out ones marked; an open chat, an agent without logins and a single login list none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPanelOptions } = require('../electron/app/chromePanelOptions.cjs');

function menus(rows: Record<string, any[]>) {
  const live: any = {
    identity: { instances: (family: string) => rows[family] ?? [], driver: () => ({ perChat: true }) },
    codex: { modelList: async () => ({ data: [] }) },
    chats: { records: new Map(), get: () => ({}) },
    controller: { state: new Map(), ref: () => null },
    acpAdmission: { list: () => [{ id: 'gemini', catalog: { configOptions: [] } }] },
    claudeTurns: { settings: () => null },
    patchPrefs: () => true,
  };
  return createPanelOptions({
    live,
    claude: { probeInfo: () => ({ models: [] }), findBinary: async () => null, probe: async () => ({ models: [] }) },
    prefs: () => ({}),
    kindOf: (id: string) => (id === 'chat' ? 'codex' : null),
    labelOf: (k: string | null) => k,
  });
}
const two = [
  { account: 'a', label: 'a@x.com', status: 'ok' },
  { account: 'b', label: null, status: 'expired' },
];

for (const family of ['claude', 'codex']) {
  test(`${family}: a new chat lists every login, the signed-out one marked`, async () => {
    const m = menus({ [family]: two });
    assert.deepEqual((await m.options({ harness: family })).accounts, [
      { id: 'a', label: 'a@x.com', loggedIn: true, limited: false },
      { id: 'b', label: 'b', loggedIn: false, limited: false },
    ]);
  });
}

test('one login and an agent without logins have no account menu; an open chat on a harness with two reports its own', async () => {
  const m = menus({ claude: [two[0]], codex: two });
  assert.equal('accounts' in (await m.options({ harness: 'claude' })), false);
  // an open chat on a harness with two logins lists them and says it is on the agent's own choice
  const open = await m.options({ chatId: 'chat' });
  assert.equal(open.accounts.length, 2);
  assert.deepEqual(open.account, { id: null, pinned: false, serving: null });
  assert.equal('accounts' in (await m.options({ harness: 'acp:gemini' })), false);
});
