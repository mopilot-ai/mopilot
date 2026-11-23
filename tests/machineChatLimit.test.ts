// What a chat on a machine offers at its usage limit (#4278): the limit is that machine's account's, so the way on is its row in Settings, never this Mac's harnesses (src/store/chats.ts limit note). Its sign-in errors: tests/harnessChatActions.test.ts.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, impl, resetAll, flush } from './support/store-harness.ts';

let allowed = true;
mock.module(new URL('../src/lib/host.ts', import.meta.url).href, {
  namedExports: { hostAllowedNow: () => allowed, useHostAccess: () => allowed, useHostAnswered: () => true },
});
const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const { reloadHostChats, resetHostChats } = await import('../src/lib/hostChats.ts');

const REMOTE = 'acp:host-claude:m1';
const LOCAL = 'acp:kimi:l1';
beforeEach(async () => {
  resetState();
  resetAll();
  resetHostChats();
  allowed = true;
  impl['host.remoteChats'] = async () => [{ chatId: REMOTE, hostId: 'box' }];
  await reloadHostChats();
});

test('a usage limit of a chat on a machine names the machine and opens its row: no harness of this Mac is offered, and nothing says it goes on by itself', async () => {
  const way = S.limitNoteWay(REMOTE);
  assert.match(way.text, / limit reached on this chat's machine\.$/);
  assert.equal(way.canAutoSwitch, undefined);
  assert.equal(way.action.label, 'Machines');
  way.action.run();
  await flush();
  await flush();
  assert.deepEqual([st().route.name, (st().route as any).section], ['settings', 'connections']);
  assert.notEqual(S.limitNoteWay(LOCAL).action.label, 'Machines');
  // Host switched off: the chat is this Mac's to continue
  allowed = false;
  assert.notEqual(S.limitNoteWay(REMOTE).action.label, 'Machines');
});

test('the note and the toast of a machine chat at its limit: said once, with Machines, and never as going on by itself', () => {
  S.useStore.setState({
    runtime: { [REMOTE]: { turns: [{ id: 't', items: [] }] } as any },
    prefs: { ...st().prefs, autoContinueOnLimit: true, autoSwitchHarnessOnLimit: true },
  });
  S.suggestOtherHarness(REMOTE, 'acp');
  S.suggestOtherHarness(REMOTE, 'acp');
  const notes = (st().runtime[REMOTE].turns[0].items as any[]).filter((i) => i.kind === 'limit');
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, / limit reached on this chat's machine\.$/);
  assert.ok(st().toasts.length > 0);
  assert.ok(st().toasts.every((t) => t.action?.label === 'Machines'));
});

test('while the chats on machines are not read yet, a chat at its limit is offered nothing of this Mac’s, and is not said to be on a machine', () => {
  resetHostChats();
  for (const id of [REMOTE, LOCAL]) {
    const way = S.limitNoteWay(id);
    assert.match(way.text, / limit reached\.$/);
    assert.equal(way.canAutoSwitch, undefined);
    assert.equal(way.action.label, 'Machines');
  }
});
