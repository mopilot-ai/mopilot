// src/store/actions.ts forkThread from a message ("Fork chat from here"): the turn the button showed is read at the
// click; one no longer in the chat, or not named by its harness yet, is refused with a line instead of forking the
// whole chat (#1988). On every harness the fork from a turn that is there goes to the chat's harness with that turn.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, impl, resetAll } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const { MESSAGE_GONE } = await import('../src/store/liveAction.ts');
const { noteOwner } = await import('../src/harness/ownership.ts');
noteOwner('claude:c', 'claude');

let ran: string[][] = [];
beforeEach(() => {
  resetState();
  resetAll();
  ran = [];
  impl['run.runSemantic'] = async (chat: string, sem: string, args: string) => (
    ran.push([chat, sem, args]), { ok: true, value: `fork:${args}` }
  );
});

test('a fork from a turn the chat still shows goes to its harness from that turn, on Codex and Claude Code', async () => {
  for (const chat of ['c', 'claude:c']) {
    set({ runtime: { [chat]: { turns: [{ id: 'T1', items: [] }] } as any } });
    assert.equal(await S.forkThread(chat, 'T1'), 'fork:T1');
  }
  assert.deepEqual(ran, [
    ['c', 'fork', 'T1'],
    ['claude:c', 'fork', 'T1'],
  ]);
  assert.deepEqual(st().toasts, []);
});

test('a fork from a turn no longer in the chat, not named yet, or in a chat not loaded is refused with a line', async () => {
  set({
    runtime: {
      c: {
        turns: [
          { id: 'T1', items: [] },
          { id: 'pending-x', items: [] },
        ],
      } as any,
    },
  });
  // rewound or reloaded without it
  assert.equal(await S.forkThread('c', 'T-rewound'), undefined);
  // its harness has not named it: no turn to fork from yet
  assert.equal(await S.forkThread('c', 'pending-x'), undefined);
  assert.equal(await S.forkThread('gone', 'T1'), undefined);
  // a switched chat takes the same check before forking its segments
  set({
    segments: {
      c: [
        { nativeId: 'c', harness: 'codex', start: 0, count: 1 },
        { nativeId: 'claude:c', harness: 'claude', start: 1 },
      ] as any,
    },
  });
  assert.equal(await S.forkThread('c', 'T-rewound'), undefined);
  assert.deepEqual(ran, []);
  assert.deepEqual(
    st().toasts.map((t) => t.text),
    [MESSAGE_GONE, MESSAGE_GONE, MESSAGE_GONE, MESSAGE_GONE],
  );
});
