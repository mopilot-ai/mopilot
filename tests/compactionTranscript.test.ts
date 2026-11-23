// One rule for how a context compaction reads in a chat on every harness (shared/compaction.mjs): opencode's summary
// streamed as an agent message (#1575) and Claude Code's summary read back as a user message (#1501) both become the
// compaction item, live, on replay and in the handoff record. Transcripts are made up; the summary is opencode 1.18's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactionItem } from '../shared/compaction.mjs';
import { AcpTranslator, buildAcpTurns } from '../electron/harness/items/acpTranslator.cjs';
import { buildTurns } from './support/claude-translate.ts';
import { renderConversation } from '../shared/handoff.mjs';

const SUMMARY = [
  '## Objective',
  '- Sign in to the OAuth fixture in the in-app browser',
  '',
  '## Important Details',
  '- (none)',
  '',
  '## Work State',
  '### Completed',
  '- Opened the sign-in page',
  '### Active',
  '- (none)',
  '### Blocked',
  '- (none)',
  '',
  '## Next Move',
  '1. Click Approve',
  '',
  '## Relevant Files',
  '- (none)',
].join('\n');
/** The text in pieces the way a model streams it, the first ones too short to tell what it is. */
const pieces = (text: string) => [text.slice(0, 1), text.slice(1, 5), text.slice(5, 9), text.slice(9, 40), text.slice(40)];

const user = (turnId: string, text: string): any => ({
  t: 'user',
  turnId,
  user: { id: `u-${turnId}`, clientId: turnId, content: [{ type: 'text', text, text_elements: [] }] },
  at: 1000,
});
const up = (turnId: string, update: any): any => ({ t: 'update', turnId, update, at: 2000 });
const end = (turnId: string): any => ({ t: 'end', turnId, stopReason: 'end_turn', at: 3000 });
const text = (t: string, messageId: string | undefined) => ({
  sessionUpdate: 'agent_message_chunk',
  ...(messageId ? { messageId } : {}),
  content: { type: 'text', text: t },
});
const thought = (t: string, messageId: string) => ({ sessionUpdate: 'agent_thought_chunk', messageId, content: { type: 'text', text: t } });
const call = (id: string) => ({ sessionUpdate: 'tool_call', toolCallId: id, title: 'browser_click', kind: 'other', status: 'completed' });

test('the shared rule: a compaction item carries the summary only when there is one', () => {
  assert.deepEqual(compactionItem('c1'), { type: 'contextCompaction', id: 'c1', trigger: null });
  assert.deepEqual(compactionItem('c2', { trigger: 'manual', summary: '  \n ' }), {
    type: 'contextCompaction',
    id: 'c2',
    trigger: 'manual',
  });
  assert.deepEqual(compactionItem('c3', { summary: ` ${SUMMARY}\n` }), {
    type: 'contextCompaction',
    id: 'c3',
    trigger: null,
    summary: SUMMARY,
  });
});

test("ACP: opencode's compaction summary is a compaction item, not the agent's reply, between the steps it splits (#1575)", () => {
  const turns = buildAcpTurns(
    [
      user('t1', 'Sign in on the fixture'),
      up('t1', text('Opening the page.', 'msg_1')),
      up('t1', call('c1')),
      // the compaction agent: its thinking, then the summary, in a message of its own
      up('t1', thought('Summarizing', 'prt_r1')),
      ...pieces(SUMMARY).map((p) => up('t1', text(p, 'msg_2'))),
      // the next step's reply follows straight on, in another message
      up('t1', text('Clicking Approve.', 'msg_3')),
      up('t1', call('c2')),
      up('t1', text('Signed in.', 'msg_4')),
      end('t1'),
    ],
    'opencode:x',
    '/repo',
  );
  const items = turns[0].items;
  const TOOL = items[2].type;
  assert.deepEqual(
    items.map((i: any) => i.type),
    ['userMessage', 'agentMessage', TOOL, 'reasoning', 'contextCompaction', 'agentMessage', TOOL, 'agentMessage'],
  );
  const compaction: any = items.find((i: any) => i.type === 'contextCompaction');
  assert.deepEqual(compaction, { type: 'contextCompaction', id: compaction.id, trigger: 'auto', summary: SUMMARY });
  const replies = items.filter((i: any) => i.type === 'agentMessage').map((i: any) => i.text);
  assert.deepEqual(replies, ['Opening the page.', 'Clicking Approve.', 'Signed in.']);
});

test('ACP live: the summary never streams as reply text; a reply that only opened like one keeps every character', () => {
  const events: [string, any][] = [];
  const tr = new AcpTranslator('opencode:x', '/repo', (m, p) => events.push([m, p]));
  tr.beginTurn('t1');
  for (const p of pieces(SUMMARY)) tr.onUpdate(text(p, 'msg_2'), 't1');
  const started = events.filter(([m]) => m === 'item/started').map(([, p]) => p.item);
  assert.deepEqual(
    started.map((i) => i.type),
    ['contextCompaction'],
  );
  assert.equal(
    events.some(([m]) => m === 'item/agentMessage/delta'),
    false,
  );
  // a plan that opens like a summary is a reply as soon as its second heading is another one
  const plan = '## Objective\nShip the fix.\n\n## Next Move\n1. Test it';
  for (const p of pieces(plan)) tr.onUpdate(text(p, 'msg_3'), 't1');
  tr.endTurn('end_turn', null);
  const done = events.filter(([m]) => m === 'item/completed').map(([, p]) => p.item);
  assert.deepEqual(
    done.map((i) => [i.type, i.summary ?? i.text]),
    [
      ['contextCompaction', SUMMARY],
      ['agentMessage', plan],
    ],
  );
  assert.equal(new Set(done.map((i) => i.id)).size, 2);
  // the summary's id is the one its item started with, so the store replaces it in place
  assert.equal(done[0].id, started[0].id);
});

test('ACP: a reply too short to tell is still shown, live and when it ends the turn', () => {
  const events: [string, any][] = [];
  const tr = new AcpTranslator('opencode:x', '/repo', (m, p) => events.push([m, p]));
  tr.beginTurn('t1');
  tr.onUpdate(text('#', undefined), 't1');
  assert.equal(events.filter(([m]) => m.startsWith('item/')).length, 0, 'held back until it can tell');
  tr.onUpdate(text('# Done', undefined), 't1');
  assert.deepEqual(
    events.filter(([m]) => m === 'item/agentMessage/delta').map(([, p]) => p.delta),
    ['## Done'],
  );
  tr.onUpdate(text('##', 'm9'), 't1');
  tr.endTurn('end_turn', null);
  const done = events.filter(([m]) => m === 'item/completed').map(([, p]) => p.item);
  assert.deepEqual(
    done.map((i) => i.text),
    ['## Done', '##'],
  );
});

test("ACP: the user's /compact makes a manual compaction; text with no message id keeps streaming into one reply", () => {
  const turns = buildAcpTurns(
    [
      user('t1', '/compact'),
      ...pieces(SUMMARY).map((p) => up('t1', text(p, undefined))),
      end('t1'),
      user('t2', 'Go on'),
      up('t2', text('One', undefined)),
      up('t2', text(' reply', undefined)),
      end('t2'),
    ],
    'opencode:x',
    '/repo',
  );
  assert.deepEqual(
    turns[0].items.map((i: any) => [i.type, i.trigger]),
    [
      ['userMessage', undefined],
      ['contextCompaction', 'manual'],
    ],
  );
  assert.deepEqual(
    turns[1].items.filter((i: any) => i.type === 'agentMessage').map((i: any) => i.text),
    ['One reply'],
  );
});

let n = 0;
const ts = () => new Date(Date.now() - 3_600_000).toISOString();
const cuser = (content: any, extra: object = {}) => ({
  type: 'user',
  uuid: `u${++n}`,
  timestamp: ts(),
  message: { role: 'user', content },
  parent_tool_use_id: null,
  ...extra,
});
const said = (t: string) => ({
  type: 'assistant',
  uuid: `a${++n}`,
  timestamp: ts(),
  message: { id: `m${n}`, content: [{ type: 'text', text: t }] },
  parent_tool_use_id: null,
});
const CLAUDE_SUMMARY =
  'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request: fix the login test';

test("Claude: a compaction summary read back is the compaction, not a user message, and Claude's work after it stays in its turn (#1501)", () => {
  for (const content of [CLAUDE_SUMMARY, [{ type: 'text', text: CLAUDE_SUMMARY }]]) {
    const turns = buildTurns(
      [
        cuser(content, { isCompactSummary: true, is_meta: true }),
        said('Continuing with the login test.'),
        cuser('Thanks, now push it'),
        said('Pushed.'),
      ],
      'claude:x',
      '/repo',
    );
    assert.equal(turns.length, 2);
    const [first, second] = turns;
    assert.deepEqual(
      first.items.map((i: any) => i.type),
      ['contextCompaction', 'agentMessage'],
    );
    assert.deepEqual(first.items[0], { type: 'contextCompaction', id: first.items[0].id, trigger: null, summary: CLAUDE_SUMMARY });
    assert.equal(first.status, 'completed');
    assert.deepEqual(
      second.items.map((i: any) => i.type),
      ['userMessage', 'agentMessage'],
    );
  }
});

test('Claude: a summary read back without a uuid still heads its own turn, named by its place', () => {
  const { uuid: _, ...bare } = cuser(CLAUDE_SUMMARY, { isCompactSummary: true });
  const turns = buildTurns([bare], 'claude:x', '/repo');
  assert.equal(turns[0].id, 'h-0');
  assert.equal(turns[0].items[0].id, 'compact-0');
});

test('Claude: a summary that arrives while a turn is open joins that turn', () => {
  const turns = buildTurns(
    [cuser('Fix the test'), said('On it.'), cuser(CLAUDE_SUMMARY, { isCompactSummary: true }), said('Fixed.')],
    'claude:x',
    '/repo',
  );
  assert.equal(turns.length, 1);
  assert.deepEqual(
    turns[0].items.map((i: any) => i.type),
    ['userMessage', 'agentMessage', 'contextCompaction', 'agentMessage'],
  );
});

test('Claude: a /compact right after a summary that joined an open turn makes its divider the user’s, and is the next turn’s prompt', () => {
  // the turns the compaction folded away are read back too (electron/platform/claudeCompactedHistory.cjs), so the summary finds a turn open
  const turns = buildTurns(
    [cuser('Fix the test'), said('On it.'), cuser(CLAUDE_SUMMARY, { isCompactSummary: true }), cuser('/compact')],
    'claude:x',
    '/repo',
  );
  assert.deepEqual(
    turns.map((t: any) => t.items.map((i: any) => i.type + (i.trigger ? `:${i.trigger}` : ''))),
    [['userMessage', 'agentMessage', 'contextCompaction:manual'], ['userMessage']],
  );
  // any other prompt after it leaves the divider as the summary made it
  const other = buildTurns(
    [cuser('Fix the test'), said('On it.'), cuser(CLAUDE_SUMMARY, { isCompactSummary: true }), cuser('Go on')],
    'claude:x',
    '/repo',
  );
  assert.equal((other[0]!.items.at(-1) as any).trigger, null);
});

test("handoff: a compaction is never the user's, and its summary is handed over (#1501)", () => {
  const claude = buildTurns([cuser(CLAUDE_SUMMARY, { isCompactSummary: true }), said('Continuing.')], 'claude:x', '/repo');
  const full = renderConversation(claude, 1_000_000).text;
  assert.doesNotMatch(full, /User: This session is being continued/);
  assert.match(full, /- \(context compacted; summary:\)\n {4}This session is being continued/);
  assert.match(full, / {4}1\. Primary Request: fix the login test/);
  // condensed, it is one step line without the summary
  const acp = buildAcpTurns(
    [user('t1', 'Sign in'), ...pieces(SUMMARY).map((p) => up('t1', text(p, 'm2'))), up('t1', text('Done.', 'm3')), end('t1')],
    'opencode:x',
    '/repo',
  );
  const acpFull = renderConversation(acp, 1_000_000).text;
  assert.match(acpFull, /Steps:\n- \(context compacted; summary:\)\n {4}## Objective/);
  assert.match(acpFull, /Assistant: Done\.$/);
  // a turn that only compacted keeps its one line, with the summary under it in full
  const only = renderConversation(
    [{ id: 'k', status: 'completed', items: [compactionItem('c', { summary: 'S1\nS2' })] } as any],
    1_000_000,
  ).text;
  assert.equal(only, '### Turn 1\n(context compacted)\n    S1\n    S2');
});

test("Claude: the user's /compact, written after its summary, heads that compaction's turn and makes it manual", () => {
  const turns = buildTurns(
    [
      cuser(CLAUDE_SUMMARY, { isCompactSummary: true, is_meta: true }),
      // a message Claude Code kept from before the compaction, read back right after the summary
      said('The fix is in.'),
      cuser('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>'),
      cuser('<local-command-stdout>Compacted </local-command-stdout>'),
      cuser('Now push it'),
      said('Pushed.'),
    ],
    'claude:x',
    '/repo',
  );
  assert.equal(turns.length, 2);
  assert.deepEqual(
    turns[0].items.map((i: any) => [i.type, i.trigger]),
    [
      ['contextCompaction', 'manual'],
      ['agentMessage', undefined],
      ['userMessage', undefined],
    ],
  );
  assert.equal((turns[0].items[2] as any).content[0].text, '/compact');
  assert.equal((turns[0].items[0] as any).summary, CLAUDE_SUMMARY);
  assert.deepEqual(
    turns[1].items.map((i: any) => i.type),
    ['userMessage', 'agentMessage'],
  );
  const record = renderConversation(turns, 1_000_000).text;
  assert.match(record, /### Turn 1\nUser: \/compact\nSteps:\n- \(context compacted; summary:\)\n {4}This session is being continued/);
  // a /compact after another prompt is a compaction of its own, not this one's
  const later = buildTurns(
    [cuser(CLAUDE_SUMMARY, { isCompactSummary: true }), said('Continuing.'), cuser('Go on'), said('Done.'), cuser('/compact')],
    'claude:x',
    '/repo',
  );
  assert.equal(later.length, 3);
  assert.equal((later[0].items[0] as any).trigger, null);
});

test('ACP: a summary cut off by Stop stays the compaction, with the part that was written', () => {
  const events: [string, any][] = [];
  const tr = new AcpTranslator('opencode:x', '/repo', (m, p) => events.push([m, p]));
  tr.beginTurn('t1');
  const part = SUMMARY.slice(0, SUMMARY.indexOf('### Active'));
  for (const p of pieces(part)) tr.onUpdate(text(p, 'msg_2'), 't1');
  tr.endTurn('cancelled', null);
  const done = events.filter(([m]) => m === 'item/completed').map(([, p]) => p.item);
  assert.deepEqual(
    done.map((i) => [i.type, i.summary ?? i.text]),
    [['contextCompaction', part.trim()]],
  );
  // held back, too short to tell when the turn ended: the text is shown as written
  const held: [string, any][] = [];
  const t2 = new AcpTranslator('opencode:x', '/repo', (m, p) => held.push([m, p]));
  t2.beginTurn('t2');
  t2.onUpdate(text('## Objective\n- Sign in', 'm'), 't2');
  t2.endTurn('cancelled', null);
  assert.deepEqual(
    held.filter(([m]) => m === 'item/completed').map(([, p]) => [p.item.type, p.item.text]),
    [['agentMessage', '## Objective\n- Sign in']],
  );
});
