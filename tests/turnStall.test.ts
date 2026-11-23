// Waiting, explicit adapter recovery and compaction-loop notices share one behavior on every harness.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { act, createElement } from 'react';
import { turnStall, compactionLoop, COMPACTING_NEXT_STEP } from '../src/lib/turnStall.ts';

const turn = (o: any = {}) => ({ id: 't1', status: 'inProgress', startedAt: 1, items: [], itemTimes: {}, ...o });
const base = { retry: null, asked: false };

test('a quiet turn remains normal work after a minute, an hour, or a reopened window; silence is not a failure', () => {
  for (const elapsed of [60_000, 90_000, 3_600_000]) {
    const input = { ...base, turn: turn(), now: 1000 + elapsed, progressAt: null };
    assert.equal(turnStall(input), null);
  }
  assert.equal(turnStall({ ...base, turn: undefined }), null);
  assert.equal(turnStall({ ...base, turn: null }), null);
});

test('only an explicit adapter retry is recovery; it clears when the adapter clears it', () => {
  for (const status of ['inProgress', 'completed', 'failed', 'interrupted']) {
    assert.equal(turnStall({ ...base, turn: turn({ status }) }), null);
  }
  assert.deepEqual(turnStall({ ...base, turn: undefined, retry: 'Reconnecting… 2/5' }), { kind: 'retry', text: 'Reconnecting… 2/5' });
});

/** opencode's loop (#1575): a compaction after every step, each step one tool call or one reply, its thinking around them. */
const C = (n: number) => ({ id: `c${n}`, type: 'contextCompaction' });
const step = (n: number, type = 'mcpToolCall') => ({ id: `s${n}`, type, status: 'completed' });
const think = (n: number) => ({ id: `r${n}`, type: 'reasoning' });
const loop = [{ id: 'u', type: 'userMessage' }, step(0), step(1), C(1), think(1), step(2), C(2), step(3, 'agentMessage'), step(4), C(3)];

test('a compaction loop: three compactions in a row with at most three steps between them; more work breaks the run', () => {
  assert.equal(compactionLoop(loop), 3);
  assert.equal(compactionLoop([...loop, think(5), step(5), C(4)]), 4);
  // two are not a loop yet, and steps after the last one are allowed up to the same gap
  assert.equal(compactionLoop(loop.slice(0, 7)), 0);
  assert.equal(compactionLoop([...loop, step(6), step(7), step(8)]), 3);
  // opencode's real gaps on this Mac (#1575): one to three steps between compactions
  assert.equal(compactionLoop([C(1), step(1), C(2), step(2), step(3), C(3), step(4), step(5), step(6), C(4)]), 4);
  // the agent got further: four steps after the last compaction, or between two of them, end the run
  assert.equal(compactionLoop([...loop, step(6), step(7), step(8), step(9)]), 0);
  assert.equal(compactionLoop([C(1), step(1), step(2), step(3), step(4), C(2), step(5), C(3)]), 0);
  // a long task that compacts now and then is not a loop
  const work = Array.from({ length: 12 }, (_, i) => step(10 + i));
  assert.equal(compactionLoop([...work, C(1), ...work, C(2), ...work, C(3)]), 0);
  assert.equal(compactionLoop([]), 0);
});

test('a compaction loop waits for a person, but explicit recovery has its own state', () => {
  assert.deepEqual(turnStall({ ...base, turn: turn({ items: loop }) }), { kind: 'compacting', count: 3 });
  assert.equal(turnStall({ ...base, turn: turn({ items: loop }), asked: true }), null);
  assert.equal(turnStall({ ...base, turn: turn({ items: loop, status: 'failed' }) }), null);
  assert.equal(turnStall({ ...base, turn: turn({ items: loop }), retry: 'Retrying…', asked: true })?.kind, 'retry');
});

const f: any = { runtime: {}, pending: [], agentTabs: {}, session: {}, stops: [], toasts: [], stopFails: false };
const session = (o: any = {}) => ({ approvals: [], questions: [], chromeApproval: false, computer: null, ...o });
const boundary = {
  useStore: (sel: any) => sel(f),
  toastFailure: (what: string) => (error: unknown) => f.toasts.push([what, String(error)]),
  interrupt: async (id: string, turnId: string) => {
    f.stops.push([id, turnId]);
    if (f.stopFails) throw new Error('gone');
  },
  nativeOf: (id: string) => id,
  chatOf: (id: string) => id,
  useSession: () => f.session,
  useSessionField: (id: any, pick: any) => pick(((() => f.session) as (id: any) => any)(id)),
  harnessLabelOf: (id: string) => id,
};
for (const rel of ['store/core.ts', 'store/send.ts', 'store/chats.ts', 'store/session/useSession.ts', 'harness/registry.ts']) {
  mock.module(new URL(`../src/${rel}`, import.meta.url).href, { namedExports: boundary });
}
const { TurnStall, CompactionLoopNote } = await import('../src/components/thread/TurnStall.tsx');
const { createRoot } = await import('react-dom/client');
const document = window.document as unknown as Document;

async function mounted(chatId: string, readOnly = false) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const update = () => act(async () => root.render(createElement(TurnStall, { threadId: chatId, readOnly })));
  await update();
  return {
    host,
    update,
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

for (const chatId of ['Codex', 'Claude Code', 'opencode']) {
  test(`${chatId}: quiet work never gains restart controls; recovery updates in place and clears on fresh output`, async () => {
    f.runtime = { [chatId]: { turns: [turn()], activeTurnId: 't1', retry: null } };
    f.session = session();
    const view = await mounted(chatId);
    try {
      assert.equal(view.host.textContent, '');
      f.runtime[chatId].retry = 'Reconnecting… 2/5';
      await view.update();
      assert.equal(view.host.textContent, 'Reconnecting… 2/5');
      assert.equal(view.host.querySelectorAll('button').length, 0);
      f.runtime[chatId].retry = 'Reconnecting… 3/5';
      await view.update();
      assert.equal(view.host.querySelectorAll('.turn-stall').length, 1);
      assert.equal(view.host.textContent, 'Reconnecting… 3/5');
      f.runtime[chatId].retry = null;
      await view.update();
      assert.equal(view.host.textContent, '');
      for (const status of ['completed', 'failed', 'interrupted']) {
        f.runtime[chatId].turns = [turn({ status })];
        f.runtime[chatId].activeTurnId = null;
        await view.update();
        assert.equal(view.host.textContent, '');
      }
    } finally {
      await view.close();
    }
  });
}

test('recovery can precede a known turn, including in a read-only view; it never offers a restart', async () => {
  f.runtime = { c: { turns: [], activeTurnId: null, retry: 'Recovering the stream…' } };
  f.session = session();
  const view = await mounted('c', true);
  assert.equal(view.host.textContent, 'Recovering the stream…');
  assert.equal(view.host.querySelectorAll('button').length, 0);
  await view.close();
  f.runtime = {};
  const missing = await mounted('missing');
  assert.equal(missing.host.textContent, '');
  await missing.close();
});

test('a diagnosed compaction loop keeps guidance and Stop; a failed Stop reports the failure', async () => {
  f.runtime = { c: { turns: [turn({ items: loop })], activeTurnId: 't1' } };
  f.session = session();
  f.stops = [];
  f.toasts = [];
  const view = await mounted('c');
  try {
    assert.match(view.host.textContent!, /c compacted its context 3 times/);
    assert.ok(view.host.textContent!.includes(COMPACTING_NEXT_STEP));
    assert.deepEqual(
      [...view.host.querySelectorAll('button')].map((b) => b.textContent),
      ['Stop'],
    );
    await act(async () => view.host.querySelector('button')!.click());
    assert.deepEqual(f.stops, [['c', 't1']]);
    f.stopFails = true;
    await act(async () => view.host.querySelector('button')!.click());
    assert.deepEqual(f.toasts, [["Couldn't stop", 'Error: gone']]);
  } finally {
    f.stopFails = false;
    await view.close();
  }
  const readOnly = await mounted('c', true);
  assert.equal(readOnly.host.querySelectorAll('button').length, 0);
  await readOnly.close();
});

test('questions, approvals, browser hand-offs and a person holding the computer come before loop guidance', async () => {
  f.runtime = { c: { turns: [turn({ items: loop })], activeTurnId: 't1' } };
  const view = await mounted('c');
  try {
    for (const hold of [
      { approvals: [{}] },
      { questions: [{}] },
      { chromeApproval: true },
      ...['takeover', 'permission', 'waiting'].map((state) => ({ computer: { state } })),
    ]) {
      f.session = session(hold);
      await view.update();
      assert.equal(view.host.textContent, '');
    }
    f.session = session({ computer: { state: 'active' } });
    f.pending = [{ threadId: 'c' }];
    await view.update();
    assert.equal(view.host.textContent, '');
    f.pending = [];
    f.agentTabs = { c: [{ tabId: 'tab', tabKey: 'tab', signin: { reason: '', credential: false } }] };
    await view.update();
    assert.equal(view.host.textContent, '');
    f.agentTabs = undefined;
    await view.update();
    assert.match(view.host.textContent!, /compacted/);
  } finally {
    f.agentTabs = {};
    await view.close();
  }
});

test('a stopped or failed compaction loop keeps its explanation in history', async () => {
  for (const status of ['inProgress', 'completed', 'interrupted', 'failed']) {
    for (const items of [loop, []]) {
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      await act(async () => root.render(createElement(CompactionLoopNote, { turn: turn({ status, items }) })));
      assert.equal(
        host.textContent,
        ['interrupted', 'failed'].includes(status) && items.length
          ? `The context was compacted 3 times in a row without getting further.${COMPACTING_NEXT_STEP}`
          : '',
      );
      await act(async () => root.unmount());
      host.remove();
    }
  }
});
