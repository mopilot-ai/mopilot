// R1 with X4's invariant, one layer up: for a recorded Host stream of each harness the items the phone makes from the Host's rows (shared/host/threadRows.mjs through the thread fold) are the same list, field for field, as the items made from the Mac's own translator (electron/harness/remoteItemFeed.cjs), for the fields both carry.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { createFold } from '../shared/host/fold.mjs';
import { createThreadRows } from '../shared/host/threadRows.mjs';
import { displayRows, keyedRows, snapshot } from '../mobile/src/presentation/thread.ts';
import { fold } from '../mobile/src/presentation/toolRuns.ts';
import { itemsFromBlocks, type Item } from '../mobile/src/ui/items';

const require = createRequire(import.meta.url);
const { createItemFeed } = require('../electron/harness/remoteItemFeed.cjs');

const fam = (family: string, event: object) => ({ t: 'event', family, event });
const said = (turnId: string, text: string) => ({ t: 'user', turnId, text });
const chunk = (family: string, turnId: string, text: string) =>
  fam(family, {
    kind: 'update',
    turnId,
    update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text } },
  });
const tool = (family: string, turnId: string, id: string, status: string, kind: string, title: string) =>
  fam(family, { kind: 'update', turnId, update: { sessionUpdate: 'tool_call', toolCallId: id, title, kind, status } });
const stop = (family: string, turnId: string, stopReason: string) => fam(family, { kind: 'turnEnd', turnId, stopReason });

function exchange(family: string, withUser: boolean) {
  const start = (t: string, text: string) =>
    withUser
      ? [
          fam(family, {
            kind: 'turnStart',
            turnId: t,
            user: { id: `u-${t}`, clientId: t, content: [{ type: 'text', text, text_elements: [] }] },
          }),
        ]
      : [fam(family, { kind: 'turnStart', turnId: t }), said(t, text)];
  return [
    ...start('t1', 'list files'),
    chunk(family, 't1', 'Looking'),
    chunk(family, 't1', ' now. '),
    tool(family, 't1', 'c1', 'in_progress', 'execute', 'ls'),
    tool(family, 't1', 'c1', 'completed', 'execute', 'ls'),
    tool(family, 't1', 'c2', 'failed', 'read', 'a.txt'),
    chunk(family, 't1', 'Two files.'),
    stop(family, 't1', 'end_turn'),
    ...start('t2', 'again'),
    tool(family, 't2', 'c3', 'in_progress', 'search', 'grep x'),
    stop(family, 't2', 'cancelled'),
  ];
}
const STREAMS: Record<string, any[]> = { acp: exchange('acp', true), codex: exchange('codex', false), claude: exchange('claude', false) };

/** What both paths carry of an item: its kind, who said it, its words, and for a step what it was and how it went. */
const read = (i: Item): unknown[] =>
  i.kind === 'message'
    ? ['message', i.from, i.text]
    : i.kind === 'tool-call'
      ? ['tool-call', i.text, i.tool, i.state]
      : i.kind === 'tool-run'
        ? ['tool-run', i.summary, i.steps.map((s) => [s.text, s.tool, s.state])]
        : [i.kind];

const itemsOf = (rows: any[]) => itemsFromBlocks(fold(keyedRows(rows), { running: false, foldedTurn: null }).blocks);

for (const [family, stream] of Object.entries(STREAMS)) {
  test(`${family}: the Host's items and the Mac's items read the same`, () => {
    const hostFold = createFold({ hostId: 'h'.repeat(64) });
    const phone = createThreadRows();
    const mac = createItemFeed({ emit: () => undefined, batcher: { timers: { setTimeout: () => 0, clearTimeout: () => undefined } } });
    for (const item of stream) {
      const out = hostFold.push(item);
      for (const ev of out.events) mac.push('c', 'acp', ev);
      for (const rec of out.records) phone.push(rec);
    }
    const base = snapshot({ items: [], itemsShape: 'items', session: { turn: 'completed' }, rev: 0, history: [] });
    const macItems = itemsOf(displayRows({ ...base, shape: 'items', items: mac.snapshot('c').items }));
    const snap = phone.snapshot();
    const hostItems = itemsOf(displayRows({ ...base, shape: 'items', history: snap.history, items: snap.items }));
    assert.ok(hostItems.length >= 4);
    assert.deepEqual(hostItems.map(read), macItems.map(read));
  });
}
