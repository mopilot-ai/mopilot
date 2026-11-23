// Whether a chat's turn carries the user's word (#2249, electron/session/userTurn.cjs): a turn the user started stops counting as theirs once input no human wrote enters it (a steered peer message, a queued message sent into the running turn, MoPilot's own text), on Codex, Claude Code and an ACP harness; a goal item keeps the provenance it was queued with; the gates that act on the user's word (start_session, hand-offs, offers) read that, and nothing else reads `activeTurn.human` for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setup, tick, codex } from './support/controller/fixture.ts';

export const GUARDS = ['electron/'];

const require = createRequire(import.meta.url);
const { isUserTurn, turnHasPerson, withInput, endedTurn } = require('../electron/session/userTurn.cjs');
const { Orchestrator } = require('../electron/session/orchestration/service.cjs');
const { propose } = require('../electron/session/orchestration/proposals.cjs');
const ROOT = path.join(import.meta.dirname, '..');

test('attendance preserves user participation without granting authority to a steered automatic or tainted turn', () => {
  for (const [turn, person, authority] of [
    [null, false, false],
    [{}, false, false],
    [{ human: false }, false, false],
    [{ human: false, userEngaged: true }, true, false],
    [{ human: true, nonHuman: true }, true, false],
    [{ human: true }, true, true],
  ] as const) {
    assert.equal(turnHasPerson(turn), person);
    assert.equal(endedTurn(turn).person, person);
    assert.equal(isUserTurn(turn), authority);
  }
  assert.deepEqual(endedTurn({ id: 'native', human: false, userEngaged: true }), { turnId: 'native', person: true });
});

/** A running turn the user started on `chat`, in the fixture's controller. */
async function userTurn(chat: string) {
  const w = setup();
  w.c.send(chat, { text: 'plan my week', opts: { human: true } }, 1);
  await tick();
  if (chat === 't1') w.c.onCodexMessage(codex('turn/started', { threadId: 't1', turn: { id: 'turn-1' } }));
  if (chat.startsWith('acp:')) w.c.onAcpEvent({ key: chat, kind: 'turnStart', turnId: 'at-1', human: true });
  return w;
}
const requireUserTurn = (activeTurn: any) =>
  Orchestrator.prototype.requireUserTurn.call({ o: { controller: { state: { get: () => ({ activeTurn }) } } } }, 'c', 'start a session');

test('a steer no human wrote makes the running user turn no longer the user’s, on each harness family; the user’s own steer keeps it', async () => {
  for (const chat of ['t1', 'claude:s1']) {
    const { c, s } = await userTurn(chat);
    assert.equal(isUserTurn(s(chat).activeTurn), true, chat);
    c.send(chat, { text: 'and Friday', followUp: 'steer', opts: { human: true } }, 1);
    await tick();
    assert.equal(isUserTurn(s(chat).activeTurn), true, `${chat}: the user's own steer`);
    // a peer message steered in, and MoPilot's own text sent into the turn
    c.send(chat, { text: 'from another chat', followUp: 'steer', peer: { messageId: 'm1', sourceChatId: 'x' }, opts: { human: true } }, 1);
    await tick();
    assert.equal(isUserTurn(s(chat).activeTurn), false, `${chat}: a peer steer`);
    assert.equal(s(chat).activeTurn.human, true, 'attendance is left as it was');
    c.send(chat, { text: 'the user again', followUp: 'steer', opts: { human: true } }, 1);
    await tick();
    assert.equal(isUserTurn(s(chat).activeTurn), false, 'the user’s word after it doesn’t make it theirs again');
  }
  // an ACP harness takes no input into a running prompt: the peer message waits for its own turn, which isn't the user's
  const acp = await userTurn('acp:kimi:k1');
  const sent = acp.execs.length;
  acp.c.send('acp:kimi:k1', { text: 'from another chat', followUp: 'steer', peer: { messageId: 'm1', sourceChatId: 'x' }, opts: {} }, 1);
  await tick();
  assert.deepEqual([isUserTurn(acp.s('acp:kimi:k1').activeTurn), acp.execs.length], [true, sent]);
  assert.ok(
    acp.s('acp:kimi:k1').queue.some((q: any) => q.text === 'from another chat'),
    'it waits in the queue',
  );
  // a queued message no human wrote, sent into the running turn with Send now
  const { c, s } = await userTurn('t1');
  const q = c.send('t1', { text: 'a routine’s note', opts: {} }, 1);
  assert.equal(c.sendNow('t1', q.id, 1), true);
  await tick();
  assert.equal(isUserTurn(s('t1').activeTurn), false);
});

test('a steer held before it reached the harness never marks the turn the user started after it', async () => {
  let open = () => {};
  const held = new Promise<void>((r) => (open = r));
  const w = setup();
  w.c.beforeDispatch = async ({ kind }: any) => {
    if (kind === 'steer') await held;
  };
  w.c.send('claude:s1', { text: 'first', opts: { human: true } }, 1);
  await tick();
  w.c.send('claude:s1', { text: 'from another chat', followUp: 'steer', peer: { messageId: 'm1', sourceChatId: 'x' }, opts: {} }, 1);
  await tick();
  // the turn it was sent to ends, and the user starts the next one
  w.c.end('claude:s1');
  w.c.send('claude:s1', { text: 'second', opts: { human: true } }, 1);
  await tick();
  open();
  await tick();
  assert.equal(isUserTurn(w.s('claude:s1').activeTurn), true);
});

test('a goal item sent to a harness without native goals keeps the provenance it was queued with', async () => {
  const { c, execs } = setup();
  c.send('claude:s1', { text: 'Ship it', opts: { goal: 'Ship it' } }, 1);
  await tick();
  const sent = execs.find((x) => x.kind === 'claude-turn');
  assert.equal(sent?.item.text, '/goal Ship it');
  assert.equal(sent?.item.opts.human, undefined, 'MoPilot’s own goal round is not the user’s');
  const user = setup();
  user.c.send('claude:s1', { text: 'Ship it', opts: { goal: 'Ship it', human: true } }, 1);
  await tick();
  assert.equal(user.execs.find((x) => x.kind === 'claude-turn')?.item.opts.human, true);
});

test('start_session, a hand-off and an offer need a turn that is still the user’s', () => {
  assert.doesNotThrow(() => requireUserTurn({ id: 'a', human: true }));
  for (const turn of [{ id: 'a', human: true, nonHuman: true }, { id: 'a', human: false }, null])
    assert.throws(
      () => requireUserTurn(turn),
      (e: any) => e.code === 'not_user_turn',
      JSON.stringify(turn),
    );
  const orch = {
    o: { now: () => 1, controller: { state: { get: () => ({ activeTurn: { id: 'a', human: true, nonHuman: true } }) } } },
    journal: {},
  };
  assert.throws(
    () => propose(orch, 'p', { initiation: 'offer' }, 'a'),
    (e: any) => e.code === 'not_user_turn',
  );
  assert.deepEqual(
    [
      isUserTurn(undefined),
      withInput(null, {}),
      withInput({ human: true }, { opts: { human: true } }),
      withInput({ human: true }, { opts: { human: true, prefix: '<handoff>' } }),
    ],
    [false, null, { human: true }, { human: true, nonHuman: true }],
  );
  const tainted = { human: true, nonHuman: true };
  assert.equal(withInput(tainted, {}), tainted);
});

/** The files that read a turn's human flag for attendance (is someone there to answer a card), not for the user's word. */
const ATTENDANCE = ['electron/app/computerAccess.cjs', 'electron/capabilities/computerUse.cjs'];

test('every gate on the user’s word reads isUserTurn, never the turn’s human flag', () => {
  const files = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const gates = files(path.join(ROOT, 'electron'))
    .filter((f) => f.endsWith('.cjs'))
    .filter((f) => fs.readFileSync(f, 'utf8').includes("'not_user_turn'"));
  assert.ok(gates.length >= 2, 'the gates were found');
  // any other read of a turn's human flag is attendance, listed
  const readers = files(path.join(ROOT, 'electron'))
    .filter((f) => f.endsWith('.cjs') && /activeTurn\??\.human\b/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f));
  assert.deepEqual(readers.sort(), ATTENDANCE);
  for (const f of gates) {
    const text = fs.readFileSync(f, 'utf8');
    assert.equal(/activeTurn\??\.human/.test(text), false, `${path.relative(ROOT, f)} reads the turn's human flag`);
    assert.equal(/isUserTurn\(/.test(text), true, `${path.relative(ROOT, f)} reads isUserTurn`);
  }
});
