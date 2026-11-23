// A refusal reaches the Chrome side panel as one `refusal` note in the chat's history, whichever harness refused it: Claude Code's error reply with stop reason `refusal`, an ACP prompt's stop reason `refusal`, a Codex turn that failed on a policy error. The panel's row for it (chromePanelLive rowsOf) is last in an idle chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildTurns } from './support/claude-translate.ts';
import { buildAcpTurns } from '../electron/harness/items/acpTranslator.cjs';
import { REFUSAL_TEXT } from '../shared/chatSignals.mjs';
import { mk, asst } from './support/claude-translator-kit.ts';
import { acpTurnsOf } from './support/acp-transcript.ts';

const require = createRequire(import.meta.url);
process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'refusal-codex-'));
const { createPeerNativeReader } = require('../electron/session/peerNativeHistory.cjs');
const { rowsOf, liveOf } = require('../electron/capabilities/browser/chromePanelLive.cjs');

const REFUSED_TEXT = 'Claude is unable to respond to this request, which appears to violate our Usage Policy. Please start a new chat.';
const refused = (extra: object = {}, text: string | null = REFUSED_TEXT) =>
  ({
    ...asst(text === null ? [] : [{ type: 'text', text }], { uuid: 'refused-1', error: 'invalid_request', ...extra }),
    message: { id: 'm1', stop_reason: 'refusal', content: text === null ? [] : [{ type: 'text', text }] },
  }) as any;
const prompt = { id: 'user', clientId: null, content: [{ type: 'text', text: 'Do the thing' }] };

test('Claude Code live: the refusal reply is one refusal note in the harness’s words, not a reply, and the turn ends failed without repeating it', () => {
  const { tr, events, items } = mk();
  tr.beginTurn('t1', prompt);
  tr.onMessage(refused());
  tr.onMessage({ type: 'result', subtype: 'success', is_error: true, result: REFUSED_TEXT, errors: [REFUSED_TEXT] });
  const notes = items().filter((i) => i.type === 'statusNote');
  assert.deepEqual(notes, [{ type: 'statusNote', id: 'refusal-refused-1', kind: 'refusal', text: REFUSED_TEXT }]);
  assert.equal(items().filter((i) => i.type === 'agentMessage').length, 0);
  const done = events.find(([m]) => m === 'turn/completed')![1].turn;
  assert.deepEqual([done.status, done.error], ['failed', null]);
});

test('Claude Code live: a refusal reply with no text or id says the default words and gets an id of its own', () => {
  const { tr, items } = mk();
  tr.beginTurn('t1', prompt);
  tr.onMessage(refused({ uuid: undefined }, null));
  const note = items().find((i) => i.kind === 'refusal');
  assert.equal(note.text, REFUSAL_TEXT);
  assert.equal(note.id, 'refusal-m1');
  const { tr: bare, items: bareItems } = mk();
  bare.beginTurn('t2', prompt);
  const noIds = refused({ uuid: undefined }, null);
  noIds.message.id = undefined;
  bare.onMessage(noIds);
  assert.equal(bareItems().find((i) => i.kind === 'refusal').id, 'refusal-t2-1');
});

test('Claude Code replay: the same note comes from the saved transcript, in the turn that was refused, and a later turn is ordinary', () => {
  const turns = buildTurns(
    [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'Do the thing' } },
      refused(),
      { type: 'result', subtype: 'success', is_error: true },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: 'Something else' } },
      asst([{ type: 'text', text: 'Sure.' }], { uuid: 'a2' }),
    ],
    'claude:s',
    '/repo',
  ) as any[];
  const first = turns[0].items.filter((i: any) => i.type === 'statusNote');
  assert.deepEqual(
    first.map((i: any) => [i.kind, i.text]),
    [['refusal', REFUSED_TEXT]],
  );
  assert.equal(turns[0].status, 'failed');
  assert.equal(
    turns[1].items.some((i: any) => i.kind === 'refusal'),
    false,
  );
  // the panel's rows end with the later reply, so no refusal card stays on an old turn
  assert.equal(rowsOf(turns).rows.at(-1).role, 'assistant');
});

test('a refusal frame with no error flag is a refusal too; a streamed partial frame with no stop reason yet is not', () => {
  const { tr, items } = mk();
  tr.beginTurn('t1', prompt);
  const partial = refused({ error: undefined });
  partial.message.stop_reason = null;
  tr.onMessage(partial);
  assert.equal(
    items().some((i) => i.kind === 'refusal'),
    false,
  );
  tr.onMessage(refused({ error: undefined, isApiErrorMessage: undefined }));
  assert.equal(items().filter((i) => i.kind === 'refusal').length, 1);
});

const notice = (over: object = {}) => ({
  type: 'system',
  subtype: 'model_refusal_no_fallback',
  uuid: 'notice-1',
  original_model: 'm-big',
  api_refusal_category: 'cyber',
  content: 'The model declined this request.',
  ...over,
});

test('the SDK’s model_refusal_no_fallback notice is a refusal note in its words, and one refusal shows one card whichever of the two comes first', () => {
  const { tr, items, events } = mk();
  tr.beginTurn('t1', prompt);
  tr.onMessage(notice());
  tr.onMessage(refused());
  const notes = () => items().filter((i) => i.kind === 'refusal');
  assert.deepEqual(notes(), [{ type: 'statusNote', id: 'refusal-notice-1', kind: 'refusal', text: 'The model declined this request.' }]);
  assert.equal(items().filter((i) => i.type === 'agentMessage').length, 0, 'the frame was consumed, not shown as a reply');
  tr.onMessage({ type: 'result', subtype: 'success', is_error: true, result: 'The model declined this request.' });
  assert.equal(events.find(([m]) => m === 'turn/completed')![1].turn.status, 'failed');
  // the frame first, then the notice
  const second = mk();
  second.tr.beginTurn('t2', prompt);
  second.tr.onMessage(refused());
  second.tr.onMessage(notice());
  assert.deepEqual(
    second
      .items()
      .filter((i) => i.kind === 'refusal')
      .map((i) => i.id),
    ['refusal-refused-1'],
  );
  // the next turn's refusal is its own
  second.tr.onMessage({ type: 'result', subtype: 'success', is_error: true });
  second.tr.beginTurn('t3', prompt);
  second.tr.onMessage(notice({ uuid: 'notice-2', content: '  ' }));
  assert.deepEqual(
    second
      .items()
      .filter((i) => i.kind === 'refusal')
      .map((i) => [i.id, i.text]),
    [
      ['refusal-refused-1', REFUSED_TEXT],
      ['refusal-notice-2', REFUSAL_TEXT],
    ],
  );
  // a notice outside any turn has no card to give
  const idle = mk();
  idle.tr.onMessage(notice());
  assert.equal(idle.items().length, 0);
});

test('a refusal a fallback model retried is retracted: its note becomes a model note, the turn is no longer failed for it, and other refusals are left', () => {
  const retry = (over: object = {}) => ({
    type: 'system',
    subtype: 'model_refusal_fallback',
    trigger: 'refusal',
    direction: 'retry',
    original_model: 'm-big',
    fallback_model: 'm-small',
    retracted_message_uuids: ['refused-1'],
    ...over,
  });
  const { tr, items, events } = mk();
  tr.beginTurn('t1', prompt);
  tr.onMessage(refused({ error: undefined }));
  tr.onMessage(retry());
  const note = items()
    .filter((i) => i.id === 'refusal-refused-1')
    .at(-1);
  assert.deepEqual([note.kind, note.text], ['model', 'm-big refused the request; it was retried on m-small.']);
  tr.onMessage(asst([{ type: 'text', text: 'Here is the answer.' }], { uuid: 'a2' }));
  tr.onMessage({ type: 'result', subtype: 'success', is_error: false });
  assert.equal(events.find(([m]) => m === 'turn/completed')![1].turn.status, 'completed');
  // the panel's rows keep no refusal row for it
  const rows = rowsOf([
    { id: 't1', status: 'completed', items: items().filter((i, k, all) => all.findLast((x) => x.id === i.id) === i) },
  ]).rows;
  assert.equal(
    rows.some((r: any) => r.refusal),
    false,
  );
  // another turn: a retraction that names no refusal of this turn, and no words of its own
  const other = mk();
  other.tr.beginTurn('t2', prompt);
  other.tr.onMessage(retry({ retracted_message_uuids: ['x'] }));
  other.tr.onMessage(refused({ error: undefined }));
  other.tr.onMessage(retry({ retracted_message_uuids: ['someone-else'], original_model: undefined, fallback_model: undefined }));
  other.tr.onMessage(retry({ retracted_message_uuids: undefined }));
  assert.equal(other.items().filter((i) => i.kind === 'refusal').length, 1);
  other.tr.onMessage(retry({ original_model: undefined, fallback_model: undefined }));
  assert.equal(other.items().at(-1).text, 'The model refused the request; it was retried on another model.');
  // a direction that is not a retry is not for this reader
  const sticky = mk();
  sticky.tr.beginTurn('t3', prompt);
  sticky.tr.onMessage(refused({ error: undefined }));
  sticky.tr.onMessage(retry({ direction: 'revert' }));
  assert.equal(sticky.items().at(-1).kind, 'refusal');
});

test('ACP: a prompt that ends with stop reason refusal is a refusal note on a failed turn, in the agent’s words when it gave some', () => {
  const user = (turnId: string): any => ({ t: 'user', turnId, user: { id: `u-${turnId}`, content: [{ type: 'text', text: 'Go' }] } });
  const end = (turnId: string, stopReason: string, error?: string): any => ({ t: 'end', turnId, stopReason, ...(error ? { error } : {}) });
  const turns = buildAcpTurns(
    [user('t1'), end('t1', 'refusal'), user('t2'), end('t2', 'refusal', 'Declined by policy'), user('t3'), end('t3', 'end_turn')],
    'c',
    '/',
  ) as any[];
  const note = (i: number) => turns[i].items.find((x: any) => x.type === 'statusNote');
  assert.deepEqual([note(0).kind, note(0).text, turns[0].status], ['refusal', 'The agent refused to continue', 'failed']);
  assert.equal(note(1).text, 'Declined by policy');
  assert.equal(note(2), undefined);
  assert.equal(turns[0].error ?? null, null);
});

test('Codex: a turn that failed on a policy error reads back with the refusal note; a quota failure, and a turn with no error, do not', async () => {
  const turn = (id: string, error: unknown, status = 'failed') => ({ id, status, items: [], error });
  const page = {
    data: [
      turn('t3', null, 'completed'),
      turn('t2', { message: 'Out of usage', codexErrorInfo: 'usageLimitExceeded' }),
      turn('t1', { message: 'Flagged by safety checks', codexErrorInfo: 'cyberPolicy' }),
    ],
    nextCursor: null,
  };
  const read = createPeerNativeReader({ claudeTurns: async () => [], acpTurns: acpTurnsOf(() => []), codexTurns: async () => page });
  const { turns } = await read({ kind: 'codex', nativeId: 'c1' });
  assert.deepEqual(
    turns.map((t: any) => t.items.map((i: any) => i.kind ?? i.type)),
    [['refusal'], [], []],
  );
  assert.deepEqual(turns[0].items[0], { type: 'statusNote', id: 'refusal-t1', kind: 'refusal', text: 'Flagged by safety checks' });
  // a page with no turns at all reads as none
  const empty = createPeerNativeReader({
    claudeTurns: async () => [],
    acpTurns: acpTurnsOf(() => []),
    codexTurns: async () => ({ nextCursor: null }),
  });
  assert.deepEqual((await empty({ kind: 'codex', nativeId: 'c1' })).turns, []);
  // the same turns from a Codex thread's rollout file while the app-server is down
  const down = createPeerNativeReader({
    claudeTurns: async () => [],
    acpTurns: acpTurnsOf(() => []),
    codexTurns: async () => {
      throw new Error('app-server down');
    },
    codexRollout: async () => ({ turns: [turn('t1', { message: '', codexErrorInfo: 'misalignmentPolicyViolation' })] }),
  });
  const disk = await down({ kind: 'codex', nativeId: 'c1' });
  assert.equal(disk.turns[0].items[0].text, REFUSAL_TEXT);
});

test('the panel’s row for a refusal note carries the flag; an account or limit note keeps its own, and a Claude rate limit event asks for a read', () => {
  const turns = [
    {
      id: 't1',
      status: 'failed',
      items: [
        { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'Go' }] },
        { type: 'statusNote', id: 'refusal-t1', kind: 'refusal', text: 'Paused by safety filters' },
        { type: 'statusNote', id: 'n2', kind: 'limit', text: 'Limit' },
        { type: 'statusNote', id: 'n3', kind: 'account', text: 'Moved' },
        { type: 'statusNote', id: 'n4', kind: 'goal', text: 'Not shown' },
      ],
    },
  ];
  const { rows } = rowsOf(turns);
  assert.deepEqual(
    rows.map((r: any) => [r.role, r.text, r.refusal ?? null, r.limit ?? null]),
    [
      ['user', 'Go', null, null],
      ['note', 'Paused by safety filters', true, null],
      ['note', 'Limit', null, true],
      ['note', 'Moved', null, null],
    ],
  );
  const chatOf = (key: string) => `chat-${key}`;
  assert.deepEqual(liveOf('claude', { key: 'k', kind: 'message', msg: { type: 'rate_limit_event' } }, chatOf), {
    chatId: 'chat-k',
    changed: true,
  });
});
