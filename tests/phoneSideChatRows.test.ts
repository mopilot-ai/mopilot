// A side chat a phone made is readable for its whole life (#5202): nothing saves its turns, so the phone feed keeps them (also while no phone is attached), the app keeps what the phone sent (Claude's stream has no user message), a snapshot and a read give every turn once, and a re-read never blanks it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openPhoneItems } = require('../electron/app/chromePanelPhones.cjs');
const { createOpenReads } = require('../electron/app/chromePanelOpenRead.cjs');
const threadPath = '../mobile/src/presentation/thread';
const { snapshot, displayRows } = await import(threadPath);

const FORK = 'claude:fork-1';
const KEY = 'claude:fork-1';
const reply = (id: string, text: string) => ({ type: 'assistant', uuid: id, message: { id, content: [{ type: 'text', text }] } });

/** The phone feed of an app whose phone is attached or away, with the side chats it knows, what the phone sent them, and the open read that gives a snapshot its history: a fork has none saved. */
function rig(forks: string[] = [FORK]) {
  const state = { attached: true };
  const events: any[] = [];
  const known = new Set(forks);
  const asks: string[] = [];
  let phone: any;
  const reads = createOpenReads({
    live: { chats: { records: new Map() }, controller: { state: { get: () => ({ turn: undefined }) } } },
    reachable: () => true,
    historyOf: Object.assign(async () => ({ turns: [] }), { recent: async () => ({ turns: [] }) }),
    forkTurns: (id: string, o: any) => (known.has(id) ? phone.turnsOf(id, o) : null),
  });
  phone = openPhoneItems({
    service: () => ({
      get attached() {
        return state.attached;
      },
      onFeedEvent: (e: any) => events.push(e),
    }),
    chatOf: () => FORK,
    rows: (id: string, n: number) => reads.rows(id, n),
    forks: () => known,
    asked: () => asks,
  });
  /** One turn as the real Claude stream gives it: the reply and the result, no user message; the question is what the phone sent. `echo`: a harness whose stream carries the user message itself (Codex). */
  const turn = (id: string, question: string, answer: string, echo = false) => {
    asks.push(question);
    if (echo) phone.live('claude', { kind: 'turnStarting', key: KEY, turnId: id, clientId: id, text: question });
    phone.live('claude', { kind: 'message', key: KEY, msg: reply(`r-${id}`, answer) });
    phone.live('claude', { kind: 'message', key: KEY, msg: { type: 'result', subtype: 'success' } });
  };
  const follow = async () => displayRows(snapshot({ chatId: FORK, ...(await phone.items(FORK, 50)), rev: 1, session: { turn: 'idle' } }));
  return { phone, state, events, turn, reads, asks, follow };
}
const texts = (rows: any[]) => rows.map((r) => r.text ?? '');
const once = (rows: any[], word: string) => texts(rows).filter((t) => String(t).includes(word)).length;

test('a reply that streams while no phone is attached is still there when the phone follows again, once, with the question', async () => {
  const r = rig();
  r.state.attached = false;
  r.turn('ct-a', 'What was the code word?', 'The code word is MANGO42.');
  assert.deepEqual(
    r.phone.turnsOf(FORK).map((t: any) => [t.status, t.items.map((i: any) => i.type)]),
    [['completed', ['userMessage', 'agentMessage']]],
    'the question is put in front of the turn that has none',
  );
  // the phone is back and follows: its snapshot holds the question and the reply, each once, the question first
  r.state.attached = true;
  const rows = await r.follow();
  assert.equal(once(rows, 'MANGO42'), 1, JSON.stringify(texts(rows)));
  assert.equal(once(rows, 'What was the code word?'), 1);
  assert.ok(texts(rows).findIndex((t) => t.includes('What was')) < texts(rows).findIndex((t) => t.includes('MANGO42')));
});

test('every turn of a side chat is read once, each under its own question: a second turn leaves the first in place, and a re-read gives the same rows', async () => {
  const r = rig();
  r.turn('ct-a', 'First question', 'First answer ALPHA');
  r.turn('ct-b', 'Second question', 'Second answer BETA');
  const first = await r.follow();
  for (const word of ['First question', 'ALPHA', 'Second question', 'BETA'])
    assert.equal(once(first, word), 1, `${word} in ${JSON.stringify(texts(first))}`);
  const at = (word: string) => texts(first).findIndex((t) => t.includes(word));
  assert.ok(
    at('First question') < at('ALPHA') && at('ALPHA') < at('Second question') && at('Second question') < at('BETA'),
    JSON.stringify(texts(first)),
  );
  // following again (a reconnect, a heartbeat's re-read) changes nothing
  assert.deepEqual(texts(await r.follow()), texts(first));
  // a snapshot sends the live turn as live: the turns before it come whole, the live one only with its question
  assert.deepEqual(
    r.phone.turnsOf(FORK, { exceptLive: true }).map((t: any) => t.items.map((i: any) => i.type)),
    [['userMessage', 'agentMessage'], ['userMessage']],
  );
});

test('the question of the turn that is still running is in the snapshot too, before the reply that streams in', async () => {
  const r = rig();
  r.asks.push('Is it still going?');
  r.phone.live('claude', { kind: 'message', key: KEY, msg: reply('r1', 'Working on it') });
  const rows = await r.follow();
  assert.equal(once(rows, 'Is it still going?'), 1, JSON.stringify(texts(rows)));
  assert.equal(once(rows, 'Working on it'), 1);
});

test('the questions are matched from the end: a ring that dropped the oldest turn keeps the right question on each turn left', async () => {
  const r = rig();
  r.asks.push('Q one (turn gone)');
  r.turn('ct-b', 'Q two', 'A two TWO');
  r.turn('ct-c', 'Q three', 'A three THREE');
  const rows = await r.follow();
  const at = (word: string) => texts(rows).findIndex((t) => t.includes(word));
  assert.ok(at('Q two') < at('TWO') && at('TWO') < at('Q three') && at('Q three') < at('THREE'), JSON.stringify(texts(rows)));
  assert.equal(once(rows, 'Q one'), 0, 'a question with no turn is not shown');
});

test('a harness whose stream carries the user message itself (Codex) is not given a second copy', async () => {
  const r = rig();
  r.turn('ct-a', 'Echoed question', 'Echoed answer', true);
  const rows = await r.follow();
  assert.equal(once(rows, 'Echoed question'), 1, JSON.stringify(texts(rows)));
  assert.equal(once(rows, 'Echoed answer'), 1);
});

test('the open read of a side chat gives its rows, the panel read all of its turns, and a chat that is not one keeps its saved history', async () => {
  const r = rig();
  r.turn('ct-a', 'Q one', 'A one GAMMA');
  r.turn('ct-b', 'Q two', 'A two DELTA');
  const rows = await r.reads.rows(FORK, 50);
  // the live turn (the last) is sent as live by a snapshot, so the rows are the turns before it, plus its question
  assert.equal(once(rows, 'GAMMA'), 1, JSON.stringify(texts(rows)));
  assert.equal(once(rows, 'Q two'), 1);
  assert.equal(once(rows, 'DELTA'), 0);
  assert.deepEqual(await r.reads.rows('claude:other', 50), [], 'any other chat reads its saved history, empty here');
  assert.equal(r.phone.turnsOf(FORK).length, 2, 'the panel read has every turn');
});

test('only a side chat is kept while no phone is attached; any other chat is not', () => {
  const r = rig(['claude:something-else']);
  r.state.attached = false;
  r.turn('ct-a', 'Q', 'A');
  assert.deepEqual(r.phone.turnsOf(FORK), [], 'not a side chat, no phone attached: nothing kept (as before)');
  const none = rig([]);
  none.state.attached = false;
  none.turn('ct-a', 'Q', 'A');
  assert.deepEqual(none.phone.turnsOf(FORK), []);
});

test('a side chat that is forgotten (its turns end with it) leaves no rows, and an unknown chat has no turns', () => {
  const r = rig();
  r.turn('ct-a', 'Q', 'A');
  assert.equal(r.phone.turnsOf(FORK).length, 1);
  r.phone.forget(FORK);
  assert.deepEqual(r.phone.turnsOf(FORK), []);
  assert.deepEqual(r.phone.turnsOf('claude:never-seen'), []);
});

test('a phone that goes away in the middle of a turn finds the whole reply, once, when it follows again', async () => {
  const r = rig();
  r.asks.push('Tell me two words');
  r.phone.live('claude', { kind: 'message', key: KEY, msg: reply('r1', 'First word OAK') });
  // the phone leaves: nothing follows, the feed's translators are closed, and the turn goes on
  r.state.attached = false;
  r.phone.live('claude', { kind: 'message', key: KEY, msg: reply('r2', 'Second word ELM') });
  r.phone.live('claude', { kind: 'message', key: KEY, msg: { type: 'result', subtype: 'success' } });
  r.state.attached = true;
  const rows = await r.follow();
  assert.equal(once(rows, 'OAK'), 1, JSON.stringify(texts(rows)));
  assert.equal(once(rows, 'ELM'), 1, JSON.stringify(texts(rows)));
  assert.equal(once(rows, 'Tell me two words'), 1);
});
