// A button bound to the turn, tab, task or app it showed (#1866): Stop reaches only that turn on every harness, main
// refuses a turn that is no longer running, and a retired answer shows the shared "Already ended" line.
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush, bootImpls } from './support/store-harness.ts';
import { setup } from './support/controller/fixture.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, sessions, resetState } = await loadStore();
const S = store;
const st = () => S.useStore.getState();
const texts = () => st().toasts.map((t) => t.text);
const { noteOwner } = await import('../src/harness/ownership.ts');
const L = await import('../src/store/liveAction.ts');
noteOwner('cl', 'claude');

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  impl['session.snapshot'] = async () => null;
});

/** Main's session as this window last heard it: the turn main runs for the chat. */
const mainRuns = (chatId: string, id: string | null) =>
  sessions.useSessions.setState((s: any) => ({
    sessions: { ...s.sessions, [chatId]: { ...sessions.sessionOf(chatId), turn: 'running', activeTurn: id ? { id } : null } },
  }));

test('a Stop bound to a turn that ended, after a queued message started the next one, stops nothing on any harness (#1866)', async () => {
  // each chat's first turn ended and its queued message runs as B now
  S.useStore.setState({
    runtime: { cx: { activeTurnId: 'B' } as any, cl: { activeTurnId: 'B' } as any, 'acp:k:1': { activeTurnId: 'B' } as any },
  });
  for (const chat of ['cx', 'cl', 'acp:k:1']) assert.equal(await S.interrupt(chat, 'A'), 'retired', chat);
  // nothing running at all: the shown turn is gone too
  assert.equal(await S.interrupt('none', 'A'), 'retired');
  assert.deepEqual([callsOf('sem.pauseCodexGoal'), callsOf('claude.claudeStop'), callsOf('acp.acpInterrupt')], [[], [], []]);
  // no turn bound, nothing running: nothing to stop
  assert.equal(await S.interrupt('none'), false);
});

test('a Stop bound to the running turn names it: Codex on turn/interrupt, Claude Code and ACP by main’s id as last heard (#1866)', async () => {
  S.useStore.setState({
    runtime: { cx: { activeTurnId: 'B' } as any, cl: { activeTurnId: 'pending-1' } as any, 'acp:k:1': { activeTurnId: 'b2' } as any },
  });
  mainRuns('cl', 'pending-m1');
  mainRuns('acp:k:1', 'at-2');
  assert.equal(await S.interrupt('cx', 'B'), true);
  assert.equal(await S.interrupt('cl', 'pending-1'), true);
  assert.equal(await S.interrupt('acp:k:1', 'b2'), true);
  assert.deepEqual(
    [callsOf('sem.pauseCodexGoal'), callsOf('claude.claudeStop'), callsOf('acp.acpInterrupt')],
    [[['cx', 'B']], [['cl', 'pending-m1']], [['acp:k:1', 'at-2']]],
  );
  // main runs a newer turn than this window heard of: its 'retired' comes back
  impl['claude.claudeStop'] = async () => 'retired';
  assert.equal(await S.interrupt('cl', 'pending-1'), 'retired');
  // main hadn't said which turn it runs yet: it stops what runs (the window's own check already passed)
  mainRuns('acp:k:1', null);
  assert.equal(await S.interrupt('acp:k:1', 'b2'), true);
  assert.deepEqual(callsOf('acp.acpInterrupt').at(-1), ['acp:k:1']);
});

test('main stops only the turn a button showed: its id, or the token it started under; another turn answers retired (#1866)', () => {
  const { c, acpCancels } = setup();
  const chat = c.chatOf('acp:test:one');
  // no id: whatever runs
  assert.equal(c.turnIs(chat, undefined), true);
  assert.equal(c.turnIs(chat, null), true);
  // nothing runs: no turn is the shown one
  assert.equal(c.turnIs(chat, 'T1'), false);
  c.state.patch(chat, { turn: 'running', activeTurn: { id: 'T2', human: true } });
  c.rt(chat).token = 'pending-q2';
  assert.equal(c.turnIs(chat, 'T2'), true);
  // the window heard of it before the harness named it
  assert.equal(c.turnIs(chat, 'pending-q2'), true);
  assert.equal(c.turnIs(chat, 'T1'), false);
  assert.equal(c.acpCancel('acp:test:one', 'T1'), 'retired');
  assert.deepEqual(acpCancels, []);
  assert.equal(c.acpCancel('acp:test:one', 'T2'), true);
  assert.deepEqual(acpCancels, ['acp:test:one']);
});

test('liveAction shows the shared line once for false or retired, and lets a real outcome through (#1866)', async () => {
  assert.equal(await L.liveAction(Promise.resolve(true)), true);
  assert.equal(await L.liveAction(undefined), true);
  assert.deepEqual(texts(), []);
  assert.equal(await L.liveAction(Promise.resolve(false)), false);
  assert.equal(await L.liveAction('retired'), false);
  await flush();
  assert.deepEqual(texts(), [L.ALREADY_ENDED, L.ALREADY_ENDED]);
  const said: string[] = [];
  assert.equal(await L.liveAction(Promise.resolve('retired' as const), (t) => void said.push(t)), false);
  assert.deepEqual(said, ['Already ended']);
  // an action whose false already said why: only its retired takes the line
  assert.equal(L.onlyRetired(false), undefined);
  assert.equal(L.onlyRetired(true), undefined);
  assert.equal(L.onlyRetired('retired'), 'retired');
  // from a click: a refusal says the line, a failure says it failed, neither goes unhandled
  L.liveClick(Promise.resolve(false));
  L.liveClick(Promise.reject(new Error('gone')));
  await flush();
  assert.deepEqual(texts().slice(2), [L.ALREADY_ENDED, "Couldn't do that: gone"]);
});

test('Stop on a background terminal that had ended already answers retired (#1866)', async () => {
  impl['codex.leased'] = async () => ({ result: { terminated: false } });
  assert.equal(await S.terminateBackgroundTerminal('cx', '7'), 'retired');
});
