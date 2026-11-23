// What a panel read says about the chat's last turn (electron/capabilities/browser/chromePanelLive.cjs turnState, electron/app/chromePanel.cjs read), for the line under the rows: how it ended and when it started, on every harness (#3046, B2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { setup } from './support/controller/fixture.ts';
import { el } from './support/side-panel-page.ts';
import { parseRollout } from './support/rollout.ts';
import { turnFromServer } from '../shared/codexTurns.mjs';
import type { AcpRecord } from '../shared/acpItems/records.d.mts';
import { buildAcpTurns } from '../electron/harness/items/acpTranslator.cjs';
import { buildTurns, ClaudeTranslator } from './support/claude-translate.ts';

const require = createRequire(import.meta.url);
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');
const { lastTurnOf, turnState } = require('../electron/capabilities/browser/chromePanelLive.cjs');
const { PanelThread } = await import('../electron/chrome-extension/src/panelThread.mjs');

test('the last turn is reported by its status; its start only while it can be the running turn; anything else is no turn', () => {
  const now = 10_000;
  assert.deepEqual(
    lastTurnOf(
      [
        { status: 'completed', startedAt: 1 },
        { status: 'inProgress', startedAt: 2.5 },
      ],
      now,
    ),
    { status: 'inProgress', startedAt: 2.5 },
  );
  // Claude's transcript replays the running turn as completed: written to a moment ago, it is still the one running
  assert.deepEqual(lastTurnOf([{ status: 'completed', startedAt: 9_900, completedAt: now - 30 }], now), {
    status: 'completed',
    startedAt: 9_900,
  });
  assert.deepEqual(lastTurnOf([{ status: 'interrupted', startedAt: 9_900, completedAt: now - 120 }], now), {
    status: 'interrupted',
    startedAt: 9_900,
  });
  // one written to long before (or never timed) is the turn before the running one: no start
  assert.deepEqual(lastTurnOf([{ status: 'completed', startedAt: 1, completedAt: now - 121 }], now), { status: 'completed' });
  assert.deepEqual(lastTurnOf([{ status: 'failed', startedAt: 9 }], now), { status: 'failed' });
  assert.deepEqual(lastTurnOf([{ status: 'completed', startedAt: 9, completedAt: 'x' }], now), { status: 'completed' });
  // a start the harness has not written yet (or one that is not a time) is left out
  for (const startedAt of [null, undefined, 0, -1, 'x', Number.NaN])
    assert.deepEqual(lastTurnOf([{ status: 'inProgress', startedAt }], now), { status: 'inProgress' });
  // the clock defaults to now
  assert.deepEqual(lastTurnOf([{ status: 'inProgress', startedAt: 5 }]), { status: 'inProgress', startedAt: 5 });
  // no turn, no status, a status no translator writes
  for (const turns of [[], undefined, null, 'x', [{}], [{ status: 7 }], [{ status: 'cancelled' }], [null]])
    assert.equal(lastTurnOf(turns), null);
});

test('a read says the chat’s state and its last turn together', () => {
  assert.deepEqual(turnState('running', [{ status: 'inProgress', startedAt: 3 }]), {
    state: 'running',
    turn: { status: 'inProgress', startedAt: 3 },
  });
  assert.deepEqual(turnState('awaitingUser', []), { state: 'waiting' });
  assert.deepEqual(turnState(undefined, [{ status: 'failed' }]), { state: 'idle', turn: { status: 'failed' } });
});

/** A read of a chat whose history is `turns`, through main's panel. */
function readOf(t: any, turns: any[]) {
  const h = setup();
  t.after(() => fs.rmSync(h.chats.dir, { recursive: true, force: true }));
  h.chats.records.set('th-1', { id: 'th-1', segments: [{ kind: 'codex', nativeId: 'th-1' }], meta: {} });
  const live: any = { chats: h.chats, controller: h.c, peerRuntime: { readHistory: async () => ({ turns }) } };
  const panel = createChromePanel({
    live,
    sources: {},
    home: h.chats.dir,
    projectsFile: projectsFileOf(h.chats.dir),
    prefs: () => ({}),
    usable: async () => true,
    starter: {},
    send: async () => {},
    open: () => {},
  });
  return new Promise<any>((resolve) => void panel.handle({ id: 1, method: 'read', params: { chatId: 'th-1' } }, resolve));
}

test('the panel read carries the last history turn, whatever its harness', async (t) => {
  const items = [{ type: 'agentMessage', id: 'a', text: 'Hi' }];
  const r = await readOf(t, [
    { id: 't1', status: 'completed', startedAt: 1, items },
    { id: 't2', status: 'interrupted', startedAt: 7, items },
  ]);
  assert.equal(r.error, undefined);
  // an old turn: its status, no start
  assert.deepEqual([r.result.state, r.result.turn], ['idle', { status: 'interrupted' }]);
  const now = Date.now() / 1000;
  const recent = await readOf(t, [{ id: 't3', status: 'completed', startedAt: now - 20, completedAt: now - 1, items }]);
  assert.equal(Math.round(recent.result.turn.startedAt), Math.round(now - 20));
  const none = await readOf(t, []);
  assert.deepEqual([none.result.state, 'turn' in none.result], ['idle', false]);
});

/** The line the panel draws for an idle chat whose history is `turns`, from main's read of them. */
async function lineFor(t: any, turns: any[]) {
  const answer = await readOf(t, turns);
  const els: Record<string, any> = {};
  const document = {
    getElementById: (id: string) => (els[id] ??= el()),
    createElement: (tag: string) => el(tag),
    createTextNode: (text: string) => ({ textContent: text }),
  };
  const thread = new PanelThread({
    document,
    request: async () => ({ ...answer.result, rows: [{ role: 'user', text: 'Go' }] }),
    onError: () => undefined,
    onOpen: () => undefined,
  });
  await thread.open('th-1', {});
  return els['progress-text'].textContent;
}

const claudeLine = (text: string) => ({ type: 'user', uuid: 'u1', message: { role: 'user', content: text }, parent_tool_use_id: null });
const rolloutEnd = (type: string, extra: object = {}) =>
  [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'x', started_at: 100 } },
    { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'x', item: { type: 'ContextCompaction', id: 'c' } } },
    { type: 'event_msg', payload: { type, turn_id: 'x', ...extra } },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n');
const acpRecords = (stopReason: string): AcpRecord[] => [
  {
    t: 'user',
    turnId: 'a1',
    user: { id: 'u', clientId: 'a1', content: [{ type: 'text', text: 'go', text_elements: [] }] },
    at: 1000,
  } as AcpRecord,
  {
    t: 'update',
    turnId: 'a1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } },
    at: 2000,
  } as AcpRecord,
  { t: 'end', turnId: 'a1', stopReason, at: 3000 } as AcpRecord,
];

test('Claude Code, Codex and ACP each end a stopped turn "Stopped" and a failed one "Failed"; a finished turn stays "Done"', async (t) => {
  // Claude Code: the transcript's "[Request interrupted by user]"; a failed result from the live translator
  const claude = buildTurns([claudeLine('go'), claudeLine('[Request interrupted by user]')], 'claude:x', '/repo');
  assert.equal(await lineFor(t, claude), 'Stopped');
  const events: [string, any][] = [];
  const tr = new ClaudeTranslator('t1', '/repo', (m: string, p: any) => events.push([m, p]));
  tr.beginTurn('t1');
  tr.onMessage({ type: 'result', subtype: 'error_during_execution', errors: ['boom'] });
  assert.equal(await lineFor(t, [events.find(([m]) => m === 'turn/completed')![1].turn]), 'Failed');
  tr.beginTurn('t2');
  tr.onMessage({ type: 'result', subtype: 'success' });
  assert.equal(await lineFor(t, [events.filter(([m]) => m === 'turn/completed').at(-1)![1].turn]), 'Done');
  // Codex: the app-server's turns, and a rollout read back from disk
  for (const [status, line] of [
    ['interrupted', 'Stopped'],
    ['failed', 'Failed'],
    ['completed', 'Done'],
  ])
    assert.equal(
      await lineFor(t, [
        turnFromServer({ id: 'c1', status: status as any, items: [], startedAt: 5, completedAt: 6, durationMs: 1000, error: null }),
      ]),
      line,
    );
  assert.equal(await lineFor(t, parseRollout(rolloutEnd('turn_aborted')).turns), 'Stopped');
  assert.equal(await lineFor(t, parseRollout(rolloutEnd('task_complete', { error: { message: 'bad' } })).turns), 'Failed');
  assert.equal(await lineFor(t, parseRollout(rolloutEnd('task_complete')).turns), 'Done');
  // ACP: a cancelled prompt, a failed one, one that ended
  assert.equal(await lineFor(t, buildAcpTurns(acpRecords('cancelled'), 'c', '/')), 'Stopped');
  assert.equal(await lineFor(t, buildAcpTurns(acpRecords('error'), 'c', '/')), 'Failed');
  assert.equal(await lineFor(t, buildAcpTurns(acpRecords('end_turn'), 'c', '/')), 'Done');
});
