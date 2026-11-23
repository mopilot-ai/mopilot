// An open chat's menu says which login it is pinned to and which serves it, lists the logins to pick from, and says whether its agent can hold a chat on its own login now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chatAccountOf } = require('../electron/app/chromePanelChatAccount.cjs');
const { createPanelOptions } = require('../electron/app/chromePanelOptions.cjs');

const login = (account: string, status = 'ok') => ({ account, label: account.toUpperCase(), status });
function live(o: { meta?: any; pin?: any; claude?: any[]; codex?: any[]; perChat?: boolean } = {}) {
  return {
    identity: {
      instances: (f: string) =>
        f === 'claude' ? (o.claude ?? [login('a'), login('b')]) : (o.codex ?? [login('x'), login('y', 'expired')]),
      driver: () => ({ perChat: o.perChat ?? true }),
    },
    chats: { get: () => ({ meta: { account: o.meta } }), records: new Map() },
    accounts: { pins: new Map(o.pin ? [['t1', o.pin]] : []) },
    controller: { ref: () => ({ key: 't1' }), state: new Map() },
  };
}

test('Claude Code: pinned or following the agent, with the logins to pick from', () => {
  assert.deepEqual(chatAccountOf(live({ meta: { id: 'a', pinned: true } }), 'c', 'claude', 'A'), {
    perChat: true,
    accounts: [
      { id: 'a', label: 'A', loggedIn: true, limited: false },
      { id: 'b', label: 'B', loggedIn: true, limited: false },
    ],
    account: { id: 'a', pinned: true, serving: 'A' },
  });
  // a pick that was only the agent's choice at start is not a pin
  assert.deepEqual(chatAccountOf(live({ meta: { id: 'a', pinned: false } }), 'c', 'claude', 'B').account, {
    id: null,
    pinned: false,
    serving: 'B',
  });
  assert.equal(chatAccountOf(live({ meta: { id: 5, pinned: true } }), 'c', 'claude', null).account.id, null);
});

test('Codex: the pool’s pin on the chat’s thread', () => {
  const pinned = chatAccountOf(live({ pin: { id: 'x', sticky: true } }), 'c', 'codex', 'X');
  assert.deepEqual(pinned.account, { id: 'x', pinned: true, serving: 'X' });
  assert.deepEqual(
    pinned.accounts.map((a: any) => [a.id, a.loggedIn]),
    [
      ['x', true],
      ['y', false],
    ],
  );
  // a pool's own placing is not the person's pin
  assert.equal(chatAccountOf(live({ pin: { id: 'x', sticky: false } }), 'c', 'codex', 'X').account.pinned, false);
});

test('a choice only where there is one: one login and no pin lists nothing but still says whether it could pin; an agent without accounts says nothing', () => {
  const single = chatAccountOf(live({ claude: [login('a')] }), 'c', 'claude', 'A');
  assert.deepEqual(single, { perChat: true });
  // one login with a pin left over is still shown, so the person can release it
  assert.equal(chatAccountOf(live({ claude: [login('a')], meta: { id: 'a', pinned: true } }), 'c', 'claude', 'A').account.pinned, true);
  assert.deepEqual(chatAccountOf(live({ perChat: false }), 'c', 'codex', 'X').perChat, false);
  assert.deepEqual(chatAccountOf(live(), 'c', 'acp:kimi', null), {});
  assert.deepEqual(chatAccountOf(live(), 'c', null, null), {});
  assert.equal(chatAccountOf({ ...live(), identity: undefined }, 'c', 'claude', null).perChat, false);
});

test('options.get for an open chat carries it; for a chat with a switch waiting, and for a new chat, it does not', async () => {
  const l: any = live({ meta: { id: 'a', pinned: true } });
  l.capsService = { accountLabel: () => 'A' };
  l.codex = { modelList: async () => ({ data: [] }) };
  l.acpAdmission = { list: () => [] };
  l.claudeTurns = { settings: () => null };
  l.patchPrefs = () => true;
  l.controller.state = new Map([
    ['c', { pendingSwitch: null }],
    ['p', { pendingSwitch: { harness: 'codex', model: null } }],
  ]);
  const make = () =>
    createPanelOptions({
      live: l,
      claude: { probeInfo: () => ({ models: [] }), findBinary: async () => null, probe: async () => ({ models: [] }) },
      prefs: () => ({}),
      kindOf: () => 'claude',
      labelOf: (k: string | null) => k,
      usable: async () => true,
    });
  const own = await make().options({ chatId: 'c' });
  assert.deepEqual(own.account, { id: 'a', pinned: true, serving: 'A' });
  assert.equal(own.perChat, true);
  const waiting = await make().options({ chatId: 'p' });
  assert.equal('account' in waiting, false);
  const fresh = await make().options({ harness: 'claude' });
  assert.equal('account' in fresh, false);
  l.capsService = undefined;
  assert.equal((await make().options({ chatId: 'c' })).account.serving, null);
});

test('a read of the chat’s login that fails costs that line, never the menu', async () => {
  const l: any = live();
  l.chats.get = () => {
    throw new Error('gone');
  };
  l.codex = { modelList: async () => ({ data: [] }) };
  l.acpAdmission = { list: () => [] };
  l.claudeTurns = { settings: () => null };
  l.patchPrefs = () => true;
  const menus = createPanelOptions({
    live: l,
    claude: { probeInfo: () => ({ models: [] }), findBinary: async () => null, probe: async () => ({ models: [] }) },
    prefs: () => ({}),
    kindOf: () => 'claude',
    labelOf: (k: string | null) => k,
    usable: async () => true,
  });
  const reply = await menus.options({ chatId: 'c' });
  assert.equal('account' in reply, false);
  assert.equal(reply.harnessId, 'claude');
});

test('a login at its limit is listed as such, so a sheet can say so; a login that is not is not', () => {
  const l = live({ claude: [login('a'), { ...login('b'), limited: true }] });
  assert.deepEqual(
    chatAccountOf(l, 'c', 'claude', 'A').accounts.map((a: any) => [a.id, a.limited]),
    [
      ['a', false],
      ['b', true],
    ],
  );
});
