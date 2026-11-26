// A chat on a machine starts in the mode a chat here would: the machine's own pick, else this Mac's default permission, else "Ask for approval" (#5403).
// Owners: shared/host/permissions.mjs startingHostMode (one rule, three policies: inherit, capped, remember); store/chatCreation.ts (a new machine chat), composer/useHostPermission.ts (the chip), host/remotePicks.cjs (a chat with no pick: continue, switch, phone).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import './support/dom.ts';
import { loadStore, resetAll, impl } from './support/store-harness.ts';
import { startingHostMode, START_POLICY } from '../shared/host/permissions.mjs';

const require = createRequire(import.meta.url);
const { remotePicks, macDefaultOf } = require('../electron/host/remotePicks.cjs');

test("this Mac's default is read from the app state each time, and is nothing when there is no state or no setting", () => {
  let prefs: any = { permission: 'auto-review' };
  const read = macDefaultOf(() => ({ prefs }));
  assert.equal(read(), 'auto-review');
  prefs = { permission: 'full-access' };
  assert.equal(read(), 'full-access', 'a change in Settings is seen by the next message');
  prefs = undefined;
  assert.equal(read(), undefined);
  assert.equal(macDefaultOf(() => undefined)(), undefined);
  assert.equal(macDefaultOf(undefined)(), undefined);
});

const MODES = ['default', 'read-only', 'auto-review', 'full-access'];
const start = (o: Record<string, unknown>) => startingHostMode({ hostId: 'box', harness: 'claude', ...o } as any);

test('the machine start mode: the pick for that machine and agent wins under every policy', () => {
  const pick = { hostId: 'box', harness: 'claude', value: 'read-only' };
  for (const policy of ['inherit', 'capped', 'remember'])
    assert.equal(start({ pick, macDefault: 'full-access', lastChosen: 'auto-review', policy }), 'read-only', policy);
  assert.equal(start({ pick, hostId: 'other', macDefault: 'full-access' }), 'full-access', 'a pick for another machine is not this one');
  assert.equal(start({ pick, harness: 'codex', macDefault: 'auto-review' }), 'auto-review', 'nor another agent');
});

test('without a pick: inherit takes this Mac default, capped never Full access, remember the last mode chosen there', () => {
  for (const mode of MODES) {
    assert.equal(start({ macDefault: mode, policy: 'inherit' }), mode);
    assert.equal(start({ macDefault: mode, policy: 'capped' }), mode === 'full-access' ? 'auto-review' : mode);
    assert.equal(start({ macDefault: 'full-access', lastChosen: mode, policy: 'remember' }), mode);
  }
  for (const bad of [undefined, null, 'plan', 'bogus', 3]) {
    for (const policy of ['inherit', 'capped']) assert.equal(start({ macDefault: bad, policy }), 'default', `${policy} ${String(bad)}`);
    assert.equal(start({ lastChosen: bad, policy: 'remember' }), 'default', `remember ${String(bad)}`);
  }
  assert.equal(
    start({ macDefault: 'full-access' }),
    start({ macDefault: 'full-access', policy: START_POLICY }),
    'the shipped policy is the default one',
  );
});

test('a message to a chat with no pick and no mode of its own starts in this Mac default, for Claude Code and Codex alike', () => {
  for (const [chatId, kind] of [
    ['acp:host-claude:c', undefined],
    ['acp:host-codex:c', undefined],
    ['claude:native', undefined],
    ['native', 'claude'],
    ['native', 'codex'],
  ])
    for (const userDefault of ['auto-review', 'full-access', 'read-only'])
      assert.deepEqual(
        remotePicks({ chatId, kind, hostId: 'box', opts: {}, userDefault }),
        { hostMode: userDefault },
        `${chatId} ${userDefault}`,
      );
  // nothing said: the plain default as before
  assert.deepEqual(remotePicks({ chatId: 'acp:host-claude:c', hostId: 'box', opts: {} }), { hostMode: 'default' });
});

test("a pick for the machine, and the chat's own mode, come before this Mac default; an ACP agent keeps its own modes", () => {
  const permission = { hostId: 'box', harness: 'claude', value: 'read-only' };
  assert.deepEqual(remotePicks({ chatId: 'acp:host-claude:c', hostId: 'box', opts: {}, permission, userDefault: 'full-access' }), {
    hostMode: 'read-only',
  });
  assert.deepEqual(
    remotePicks({ chatId: 'acp:host-claude:c', hostId: 'box', opts: {}, chat: { permission: 'auto-review' }, userDefault: 'full-access' }),
    { hostMode: 'auto-review' },
  );
  assert.deepEqual(remotePicks({ chatId: 'acp:kimi:c', hostId: 'box', opts: {}, userDefault: 'full-access' }), {});
});

const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const PICK = { id: 'box', name: 'build-box', path: '/home/u/app' };

beforeEach(() => {
  resetState();
  resetAll();
  set({ conn: 'ready', home: '/home/me', route: { name: 'home' } });
});

test('a new chat on a machine starts in this Mac default, and in its own pick when it has one', async () => {
  impl['acp.startHostAcpThread'] = async (o: any) => `acp:host-${o.harness}:${Math.random()}`;
  for (const family of ['claude', 'codex']) {
    for (const mode of ['default', 'auto-review', 'full-access'] as const) {
      set({
        newChatProjectId: null,
        newChatCwd: null,
        newChatHost: PICK,
        // the machine's last agent would win over the default (prefs.hostPicks): each default is tested on a machine with none
        prefs: { ...st().prefs, defaultHarness: family, permission: mode, hostPicks: {} },
      });
      const id = (await S.createChatThread('hello'))!;
      assert.deepEqual(st().chatConfig[id].hostPermission, { hostId: 'box', harness: family, value: mode }, `${family} ${mode}`);
    }
    const picked = { hostId: 'box', harness: family, value: 'read-only' };
    set({
      newChatProjectId: null,
      newChatCwd: null,
      newChatHost: { ...PICK, permission: picked },
      prefs: { ...st().prefs, defaultHarness: family, permission: 'full-access', hostPicks: {} },
    });
    const id = (await S.createChatThread('hello'))!;
    assert.equal(st().chatConfig[id].hostPermission.value, 'read-only', `${family}: the machine pick wins`);
  }
});
