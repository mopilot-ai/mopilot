// X4's invariant: a machine's chat shows the same rows on the Mac and on the phone. For a recorded Host stream of each harness the rows the phone makes
// (shared/host/threadRows.mjs) read the same as the ones the Mac's own translators make (electron/harness/remoteItemFeed.cjs), in order and in step kind and state.
// The Mac's side is run here, not copied, so a change on either side fails this.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFold } from '../shared/host/fold.mjs';
import { createThreadRows } from '../shared/host/threadRows.mjs';
import { row, snapshot, displayRows } from '../mobile/src/presentation/thread.ts';

const require = createRequire(import.meta.url);
const { createItemFeed } = require('../electron/harness/remoteItemFeed.cjs');

const fam = (family: string, event: object) => ({ t: 'event', family, event });
const user = (turnId: string, text: string) => ({
  id: `u-${turnId}`,
  clientId: turnId,
  content: [{ type: 'text', text, text_elements: [] }],
});
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

/** One exchange per harness: a reply, a command, a file read that fails, more reply; then a second turn that is cancelled. */
function exchange(family: string, withUser: boolean) {
  const start = (t: string, text: string) =>
    withUser
      ? [fam(family, { kind: 'turnStart', turnId: t, user: user(t, text) })]
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

/** What a person reads of a row: its place, who or what it is, its words, how a step was done. */
const read = (r: any) => [
  r.role === 'preview' ? 'assistant' : r.role === 'liveUser' ? 'user' : r.role === 'live' ? 'step' : r.role,
  r.text,
  r.kind ?? null,
  r.state ?? null,
];

for (const [family, items] of Object.entries(STREAMS)) {
  test(`${family}: the phone's rows read like the Mac's, while the turn runs and when it is over`, () => {
    // the phone's side
    const fold = createFold({ hostId: 'h'.repeat(64) });
    const phone = createThreadRows();
    // the Mac's side: its translator is fed what the same fold lets through
    const mac = createItemFeed({ emit: () => undefined, batcher: { timers: { setTimeout: () => 0, clearTimeout: () => undefined } } });
    const seen: string[] = [];
    for (const item of items) {
      const out = fold.push(item);
      for (const ev of out.events) mac.push('c', 'acp', ev);
      for (const rec of out.records) for (const e of phone.push(rec)) if (e.ev === 'turn.state') seen.push(`${e.status}:${e.turnId}`);
    }
    const macItems = mac.snapshot('c').items;
    const macRows = displayRows({
      ...snapshot({ items: [], itemsShape: 'items', session: { turn: 'completed' }, rev: 0, history: [] }),
      shape: 'items',
      items: macItems,
    });
    const snap = phone.snapshot();
    const phoneRows = [...snap.history.map((h: any) => row(h, 'rows')), ...snap.items.map((i: any) => row(i, 'items'))].map(read);
    // the Mac draws every row of a turn it has not saved as live: only the words, kind and state are compared
    assert.deepEqual(phoneRows, macRows.map(read));
    assert.deepEqual(seen, ['inProgress:t1', 'completed:t1', 'inProgress:t2', 'interrupted:t2']);
  });
}
