// src/store/store.ts: opening chats, following another app's writes, held messages, sending and new chats.
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resolvedEnvironment, resetAll, flush, listeners, bootImpls, calls } from './support/store-harness.ts';
import { controlledReads } from './support/async-scenarios.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, sessions, resetState } = await loadStore();
const threads = await import('../src/store/threads.ts');
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const { noteOwner } = await import('../src/harness/ownership.ts');
const item = (e: any) => listeners['codex.onItem'](e);
const serverTurn = (id: string, o: any = {}) => ({
  id,
  status: 'completed',
  items: [],
  startedAt: 1,
  completedAt: 2,
  durationMs: 1000,
  error: null,
  ...o,
});
const session = (id: string, o: any) =>
  sessions.useSessions.setState((s) => ({ sessions: { ...s.sessions, [id]: { ...sessions.sessionOf(id), rev: 1, ...o } } }));

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  impl['session.snapshot'] = async () => null;
  impl['proxy.send'] = async () => ({ action: 'started', id: 'send-input' });
});

test('openThread hands a switched, basic or Claude chat to its own loader, once', async () => {
  set({ unread: { s1: true }, segments: { s1: [{ nativeId: 'n', harness: 'claude', start: 0 }] as any } });
  await S.openThread('s1');
  assert.equal(st().unread.s1, false);
  await S.openThread('acp:kimi:1');
  noteOwner('cl1', 'claude');
  await S.openThread('cl1');
  set({
    runtime: {
      s1: { loaded: true } as any,
      'acp:kimi:1': { loaded: true } as any,
      cl1: { loaded: true } as any,
      busy: { loading: true } as any,
    },
  });
  await S.openThread('s1');
  await S.openThread('acp:kimi:1');
  await S.openThread('cl1');
  await S.openThread('busy');
  assert.deepEqual(
    [callsOf('switch.openCompositeThread').length, callsOf('acp.openAcpThread').length, callsOf('claude.openClaudeThread').length],
    [1, 1, 1],
  );
  assert.equal(callsOf('api.threadTurns').length, 0);
  // the goal is read only for a Codex chat that isn't temporary
  assert.deepEqual(
    callsOf('api.threadGoal').map(([id]) => id),
    ['busy'],
  );
});

test('ensureResumed takes the lease once; a locked chat throws', async () => {
  impl['codex.resume'] = async (id: string) => ({ locked: id === 'locked' });
  await S.ensureResumed('r1');
  await S.ensureResumed('r1');
  assert.equal(callsOf('codex.resume').length, 1);
  await assert.rejects(
    S.ensureResumed('locked'),
    (e: any) => e instanceof threads.ThreadLocked && e.message === 'This chat is open in another Codex app.',
  );
  // held or temporary and loaded: the live stream is authoritative
  set({ runtime: { r1: { loaded: true } as any, eph: { loaded: true } as any }, threads: { eph: { id: 'eph', ephemeral: true } as any } });
  await S.openThread('r1');
  await S.openThread('eph');
  assert.equal(callsOf('api.threadTurns').length, 0);
});

test('a chat another client is running is read from disk, shown running there, and followed', async () => {
  impl['api.threadRead'] = async () => ({ thread: { id: 'd1', model: 'gpt', reasoningEffort: null, path: '/r/d1.jsonl' } });
  impl['api.threadTurns'] = async () => ({
    data: [serverTurn('t3', { status: 'interrupted', completedAt: null, durationMs: null }), serverTurn('t2'), serverTurn('t1')],
    nextCursor: 'older',
  });
  impl['api.threadGoal'] = async () => ({ goal: null });
  set({
    route: { name: 'thread', id: 'd1' } as any,
    runtime: {
      d1: {
        turns: [
          { id: 't2', error: { message: 'crashed here' }, status: 'failed', items: [], diff: 'D' },
          { id: 'live', items: [] },
        ],
      } as any,
    },
  });
  await S.openThread('d1');
  await flush();
  const rt = st().runtime.d1;
  assert.deepEqual(
    rt.turns.map((t) => [t.id, t.status]),
    [
      ['t1', 'completed'],
      ['t2', 'failed'],
      ['t3', 'inProgress'],
      ['live', undefined],
    ],
  );
  assert.equal(rt.turns[1].diff, 'D');
  assert.deepEqual([rt.loaded, rt.loading, rt.olderCursor, rt.activeTurnId], [true, false, 'older', undefined]);
  assert.deepEqual(rt.settings, { model: 'gpt', effort: null });
  assert.deepEqual(st().elsewhere.d1, { app: 'codex', running: true, hard: true });
  assert.deepEqual(callsOf('codex.watchRollout'), [['d1', '/r/d1.jsonl']]);
  // a write on disk: read the latest turns again; the other client finished
  impl['api.threadTurns'] = async () => ({ data: [serverTurn('t4'), serverTurn('t3')], nextCursor: null });
  listeners['codex.onRollout']('d1');
  await flush();
  assert.deepEqual(
    st().runtime.d1.turns.map((t) => t.id),
    ['t1', 't2', 't3', 't4'],
  );
  assert.equal(st().elsewhere.d1, undefined);
  // still running (recent write, unfinished turn): shown running again
  impl['api.threadTurns'] = async () => ({ data: [serverTurn('t5', { status: 'inProgress' })], nextCursor: null });
  listeners['codex.onRollout']('d1');
  await flush();
  assert.deepEqual(st().elsewhere.d1, { app: 'codex', running: true, hard: true });
  assert.deepEqual(
    st().runtime.d1.turns.map((t) => t.id),
    ['t1', 't2', 't3', 't4', 't5'],
  );
  // the poll re-reads while it runs elsewhere; a long-silent writer stops showing running
  calls.length = 0;
  const now = Date.now;
  Date.now = () => now() + 120_000;
  mock.timers.tick(4000);
  await flush();
  Date.now = now;
  assert.equal(callsOf('api.threadTurns').length, 1);
  assert.equal(st().elsewhere.d1, undefined);
  // nothing new on disk: no change
  impl['api.threadTurns'] = async () => ({ data: [], nextCursor: null });
  listeners['codex.onRollout']('d1');
  await flush();
  impl['api.threadTurns'] = () => Promise.reject(new Error('x'));
  listeners['codex.onRollout']('d1');
  await flush();
  // a rollout of a chat not followed is ignored
  listeners['codex.onRollout']('other');
  // off screen: the follow stops and the notice goes
  set({ route: { name: 'home' }, elsewhere: { d1: { app: 'codex', running: false, hard: true } } });
  mock.timers.tick(4000);
  assert.deepEqual(callsOf('codex.unwatchRollout'), [['d1']]);
  assert.equal(st().elsewhere.d1, undefined);
});

test('following a chat whose path is known, or whose path read fails, and stopping it while a message is held', async () => {
  impl['api.threadTurns'] = async () => ({ data: [serverTurn('a', { status: 'inProgress' })], nextCursor: null });
  impl['api.threadRead'] = () => Promise.reject(new Error('x'));
  set({ route: { name: 'thread', id: 'f1' } as any, threads: { f1: { id: 'f1', path: '/known' } as any } });
  await S.openThread('f1');
  await S.openThread('f1');
  await flush();
  assert.deepEqual(callsOf('codex.watchRollout'), [['f1', '/known']]);
  // the poll re-reads only while running elsewhere and not held
  set({ elsewhere: { f1: { app: 'codex', running: false, hard: true } } });
  calls.length = 0;
  mock.timers.tick(4000);
  assert.equal(callsOf('api.threadTurns').length, 0);
  set({
    route: { name: 'home' },
    runtime: { ...st().runtime, f1: { ...st().runtime.f1, held: { text: 'x', attachments: [], opts: {} } } },
  });
  mock.timers.tick(4000);
  assert.ok(st().elsewhere.f1);
  // the thread read failing leaves no watch
  set({ route: { name: 'thread', id: 'f2' } as any, threads: {} });
  await S.openThread('f2');
  await flush();
  assert.equal(callsOf('codex.watchRollout').length, 0);
  impl['api.threadRead'] = async () => ({ thread: { id: 'f3' } });
  set({ route: { name: 'thread', id: 'f3' } as any });
  await S.openThread('f3');
  await flush();
  assert.equal(callsOf('codex.watchRollout').length, 0);
  // a held follow stops reacting to rollout changes
  impl['codex.resume'] = async () => ({ locked: false });
  await S.ensureResumed('f3');
  listeners['codex.onRollout']('f3');
  mock.timers.tick(4000);
  // stop before the path arrives: no watch
  let release!: (v: any) => void;
  let reads = 0;
  impl['api.threadRead'] = () => (reads++ ? new Promise((r) => (release = r)) : Promise.resolve({ thread: { id: 'f4' } }));
  set({ route: { name: 'thread', id: 'f4' } as any });
  await S.openThread('f4');
  set({ route: { name: 'home' } });
  mock.timers.tick(4000);
  release({ thread: { path: '/late' } });
  await flush();
  assert.equal(callsOf('codex.watchRollout').length, 0);
});

test('an older Codex disk read cannot restore another-app busy after a newer completed turn', async () => {
  const id = 'ordered-rollout';
  impl['api.threadRead'] = async () => ({ thread: { id, path: '/rollout' } });
  impl['api.threadTurns'] = async () => ({ data: [serverTurn('external')], nextCursor: null });
  set({ route: { name: 'thread', id } as any });
  await S.openThread(id);
  const reads = controlledReads<any>();
  impl['api.threadTurns'] = reads.read;
  listeners['codex.onRollout'](id);
  listeners['codex.onRollout'](id);
  reads.requests[1].resolve({ data: [serverTurn('external')], nextCursor: null });
  await flush();
  const turns = st().runtime[id].turns;
  reads.requests[0].resolve({ data: [serverTurn('external', { status: 'inProgress' })], nextCursor: null });
  await flush();
  assert.equal(st().runtime[id].turns, turns);
  assert.equal(st().elsewhere[id], undefined);
});

test('Codex disk replies and failures cannot cross local ownership, source changes or unwatch', async () => {
  for (const retire of ['lease', 'resume', 'stream', 'switch', 'unwatch', 'main-turn', 'newer-read']) {
    for (const reject of [false, true]) {
      const id = `retire-rollout-${retire}-${reject}`;
      impl['api.threadRead'] = async () => ({ thread: { id, path: '/rollout' } });
      impl['api.threadTurns'] = async () => ({ data: [serverTurn('external')], nextCursor: null });
      set({ route: { name: 'thread', id } as any });
      await S.openThread(id);
      const reads = controlledReads<any>();
      impl['api.threadTurns'] = reads.read;
      listeners['codex.onRollout'](id);
      if (retire === 'lease') {
        item({ kind: 'lease', threadId: id, held: true });
        item({ kind: 'lease', threadId: id, held: false, reason: 'released' });
      }
      if (retire === 'resume') {
        impl['codex.resume'] = async () => ({ locked: false });
        await S.ensureResumed(id);
        item({ kind: 'lease', threadId: id, held: false, reason: 'released' });
      }
      if (retire === 'stream') S.patchRuntime(id, () => ({ turns: [serverTurn('local')] }));
      if (retire === 'switch') set({ segments: { [id]: [{ nativeId: 'replacement', harness: 'claude', start: 0 }] as any } });
      if (retire === 'unwatch') {
        set({ route: { name: 'home' } });
        mock.timers.tick(4000);
      }
      if (retire === 'main-turn') session(id, { turn: 'awaitingUser' });
      if (retire === 'newer-read') {
        listeners['codex.onRollout'](id);
        reads.requests[1].resolve({ data: [serverTurn('newer')], nextCursor: null });
        await flush();
      }
      const turns = st().runtime[id].turns;
      if (reject) reads.requests[0].reject(new Error('retired read failed'));
      else reads.requests[0].resolve({ data: [serverTurn('external', { status: 'inProgress' })], nextCursor: null });
      await flush();
      assert.equal(st().runtime[id].turns, turns, `${retire}/${reject}`);
      assert.equal(st().elsewhere[id], undefined, `${retire}/${reject}`);
    }
  }
});

test('a chat this window is running, or whose turn crashed here, is its own', async () => {
  impl['api.threadRead'] = async () => ({ thread: { id: 'm1', reasoningEffort: 'high' } });
  impl['api.threadTurns'] = async () => ({ data: [serverTurn('run', { status: 'inProgress' })], nextCursor: null });
  impl['session.snapshot'] = async (id: string) => ({ ...sessions.sessionOf(id), rev: 1, turn: id === 'm1' ? 'running' : 'crashed' });
  await S.openThread('m1');
  assert.equal(st().runtime.m1.activeTurnId, 'run');
  assert.equal(st().runtime.m1.turns[0].status, 'inProgress');
  set({ runtime: { m2: { activeTurnId: 'run', turns: [] } as any } });
  await S.openThread('m2');
  assert.equal(st().runtime.m2.activeTurnId, null);
  assert.equal(st().elsewhere.m2, undefined);
  // a failed read
  impl['api.threadTurns'] = () => Promise.reject(new Error('disk'));
  await S.openThread('m3');
  assert.deepEqual([st().runtime.m3.loaded, st().runtime.m3.error], [true, 'disk']);
  impl['api.threadTurns'] = () => Promise.reject('plain');
  await S.openThread('m4');
  assert.equal(st().runtime.m4.error, 'plain');
  // a temporary chat is never followed
  impl['api.threadTurns'] = async () => ({ data: [serverTurn('x', { status: 'inProgress' })], nextCursor: null });
  impl['session.snapshot'] = async () => null;
  set({ threads: { m5: { id: 'm5', ephemeral: true } as any } });
  await S.openThread('m5');
  assert.equal(st().elsewhere.m5, undefined);
});

test('lease events: held chats stop showing another Codex app; a released chat on screen is followed', async () => {
  set({ elsewhere: { l1: { app: 'codex', running: false, hard: true }, l2: { app: 'claude-cli', running: false, hard: false } } });
  item({ kind: 'lease', threadId: 'l1', held: true, thread: { id: 'l1', name: 'L1' } });
  item({ kind: 'lease', threadId: 'l2', held: true });
  assert.equal(st().elsewhere.l1, undefined);
  assert.ok(st().elsewhere.l2);
  assert.equal((st().threads.l1 as any).name, 'L1');
  // a later segment's lease: the chat isn't upserted from the segment's thread
  set({ segments: { chat: [{ nativeId: 'seg', harness: 'codex', start: 0 }] as any } });
  item({ kind: 'lease', threadId: 'seg', held: true, thread: { id: 'seg' } });
  assert.equal(st().threads.seg, undefined);
  // a thread a switch is starting: main names its chat before this window learns the new segment
  set({ elsewhere: { ...st().elsewhere, sw: { app: 'codex', running: false, hard: true } } });
  item({ kind: 'lease', threadId: 'fresh', chatId: 'sw', held: true, thread: { id: 'fresh' } });
  assert.equal(st().threads.fresh, undefined);
  assert.equal(st().elsewhere.sw, undefined);
  impl['api.threadRead'] = async () => ({ thread: { path: '/p' } });
  set({ route: { name: 'thread', id: 'l1' } as any });
  item({ kind: 'lease', threadId: 'l1', held: false, reason: 'released' });
  item({ kind: 'lease', threadId: 'l3', held: false, reason: 'released' });
  item({ kind: 'lease', threadId: 'l1', held: false, reason: 'exit' });
  item({ kind: 'lease', threadId: 'seg', held: false, reason: 'released' });
  await flush();
  assert.deepEqual(callsOf('codex.watchRollout'), [['l1', '/p']]);
});

test('withLease returns the result, or marks the chat held by another Codex app', async () => {
  impl['codex.leased'] = async () => ({ result: { ok: 1 } });
  assert.deepEqual(await S.withLease('w1', 'thread/x'), { ok: 1 });
  assert.deepEqual(callsOf('codex.leased')[0], ['w1', 'thread/x', {}]);
  impl['codex.leased'] = async () => ({ locked: true });
  set({ elsewhere: { w1: { app: 'codex', running: true, hard: false } } });
  assert.equal(await S.withLease('w1', 'thread/x', { a: 1 }), undefined);
  assert.deepEqual(st().elsewhere.w1, { app: 'codex', running: true, hard: true });
  assert.match(st().toasts[0].text, /open in another Codex app/);
  await S.withLease('w2', 'thread/x');
  assert.deepEqual(st().elsewhere.w2, { app: 'codex', running: false, hard: true });
});

test('setElsewhere changes only on a real change, and resets continue-here', () => {
  S.setElsewhere('e1', null);
  assert.equal(st().runtime.e1, undefined);
  S.setElsewhere('e1', { app: 'claude-desktop', running: false, hard: false });
  S.patchRuntime('e1', () => ({ continueHere: true }));
  S.setElsewhere('e1', { app: 'claude-desktop', running: false, hard: false });
  assert.equal(st().runtime.e1.continueHere, true);
  S.setElsewhere('e1', { app: 'claude-desktop', running: false, hard: true });
  assert.equal(st().runtime.e1.continueHere, true);
  S.setElsewhere('e1', { app: 'claude-cli', running: true, hard: false });
  assert.equal(st().runtime.e1.continueHere, false);
  S.patchRuntime('e1', () => ({ continueHere: true }));
  S.setElsewhere('e1', { app: 'claude-cli', running: false, hard: false });
  S.setElsewhere('e1', null);
  assert.equal(st().runtime.e1.continueHere, false);
  assert.equal(st().elsewhere.e1, undefined);
  assert.equal(S.ELSEWHERE_LABEL.sage, 'another MoPilot window');
});

test('a message waits while another app has the chat and goes when it is done or the user says so', async () => {
  set({ elsewhere: { h1: { app: 'claude-desktop', running: true, hard: false } } });
  await S.sendMessage('h1', 'first', [{ kind: 'file', path: '/a', name: 'a' }]);
  await S.sendMessage('h1', 'second', []);
  assert.deepEqual(st().runtime.h1.held, { text: 'first\n\nsecond', attachments: [{ kind: 'file', path: '/a', name: 'a' }], opts: {} });
  assert.equal(callsOf('proxy.send').length, 0);
  // finished: the held message goes, continuing here
  S.otherAppDone('h1');
  await flush();
  assert.deepEqual(st().elsewhere.h1, { app: 'claude-desktop', running: false, hard: false });
  assert.equal(st().runtime.h1.continueHere, true);
  assert.deepEqual(
    callsOf('proxy.send').map((a) => a.slice(0, 2)),
    [['h1', 'first\n\nsecond']],
  );
  // open there but idle, continue-here already chosen: sent at once
  await S.sendMessage('h1', 'third');
  assert.equal(callsOf('proxy.send').length, 2);
  // nothing held: a toast for the chat on screen
  set({
    route: { name: 'thread', id: 'h2' } as any,
    elsewhere: { h2: { app: 'other', running: true, hard: false } },
    runtime: { ...st().runtime, h2: { loaded: true } as any },
  });
  noteOwner('h2', 'claude');
  S.otherAppDone('h2');
  assert.equal(st().toasts.at(-1)!.text, 'Another app finished. You can continue here.');
  S.otherAppDone('nobody');
  set({ elsewhere: { h3: { app: 'codex', running: true, hard: true } } });
  S.otherAppDone('h3');
  assert.equal(st().elsewhere.h3, undefined);
  // cancel gives the text back to the composer
  set({ elsewhere: { h4: { app: 'sage', running: true, hard: false } } });
  await S.sendMessage('h4', 'draft me', []);
  S.cancelHeld('h4');
  assert.deepEqual(st().drafts.h4, { text: 'draft me', attachments: [] });
  assert.equal(st().runtime.h4.held, null);
  S.cancelHeld('h4');
  // typed since it was held: the held text goes after it, with its files, never over it
  const file = { kind: 'file', path: '/held', name: 'held' } as const;
  await S.sendMessage('h4', 'held one', [file]);
  set({ drafts: { ...st().drafts, h4: { text: 'typed since', attachments: [] } } });
  S.cancelHeld('h4');
  assert.deepEqual(st().drafts.h4, { text: 'typed since\nheld one', attachments: [file] });
  // with its composer on screen, the composer takes the text and files, and the saved draft is left alone
  const given: unknown[] = [];
  const take = (e: Event) => {
    const d = (e as CustomEvent).detail;
    given.push([d.threadId, d.text, d.attachments]);
    d.handled = true;
  };
  await S.sendMessage('h4', 'held two', [file]);
  window.addEventListener('composer-insert', take);
  try {
    S.cancelHeld('h4');
  } finally {
    window.removeEventListener('composer-insert', take);
  }
  assert.deepEqual(given, [['h4', 'held two', [file]]]);
  assert.deepEqual(st().drafts.h4, { text: 'typed since\nheld one', attachments: [file] });
  // continue here: a heads-up and the send
  await S.sendMessage('h4', 'again');
  await S.continueHere('h4');
  assert.match(st().toasts.at(-1)!.text, /When you go back to another MoPilot window/);
  await S.continueHere('none');
  await S.sendHeld('none');
  assert.equal(st().runtime.none.continueHere, true);
});

test('a held message main did not take is held again, ahead of anything held since, not lost', async () => {
  set({ elsewhere: { f1: { app: 'claude-desktop', running: true, hard: false } } });
  await S.sendMessage('f1', 'first', [{ kind: 'file', path: '/a', name: 'a' }]);
  S.setElsewhere('f1', { app: 'claude-desktop', running: false, hard: false });
  // main refuses it, and another message is held while the send was on its way
  impl['proxy.send'] = async () => {
    S.patchRuntime('f1', () => ({ held: { text: 'later', attachments: [], opts: {} } }));
    throw new Error("Error invoking remote method 'session:send': Error: main is gone");
  };
  await S.sendHeld('f1', true);
  assert.deepEqual(st().runtime.f1.held, {
    text: 'first\n\nlater',
    attachments: [{ kind: 'file', path: '/a', name: 'a' }],
    opts: {},
  });
  assert.equal(st().toasts.at(-1)!.text, "Couldn't send: main is gone");
  // a send that throws before reaching main: the message is held again as it was
  impl['proxy.send'] = () => {
    throw new Error('bridge broke');
  };
  await S.sendHeld('f1', true);
  assert.equal(st().runtime.f1.held!.text, 'first\n\nlater');
  assert.equal(st().toasts.at(-1)!.text, "Couldn't send: bridge broke");
  // the other app finishing sends it, and a send that works clears it
  impl['proxy.send'] = async () => ({ action: 'started', id: 'held-retry' });
  S.otherAppDone('f1');
  await flush();
  assert.equal(st().runtime.f1.held, null);
  assert.equal(callsOf('proxy.send').at(-1)![1], 'first\n\nlater');
});

test("a chat's handoff summary stays for the next try when its first message isn't sent", async () => {
  set({ handoffCarry: { hc: { text: '<handoff/>', fromTitle: 'Old' } as any }, elsewhere: {} });
  impl['proxy.send'] = async () => {
    throw new Error('journal unwritable');
  };
  assert.equal(await S.sendMessage('hc', 'go on'), false);
  assert.deepEqual(st().handoffCarry.hc, { text: '<handoff/>', fromTitle: 'Old' });
  // the next try carries it, and a send that works uses it up
  impl['proxy.send'] = async () => ({ action: 'started', id: 'handoff-retry' });
  assert.equal(await S.sendMessage('hc', 'go on'), true);
  assert.equal(callsOf('proxy.send').at(-1)![3].prefix, '<handoff/>');
  assert.equal(st().handoffCarry.hc, undefined);
});

test('a held goal and another held message are never merged: the goal would take its text, or go out as plain text', async () => {
  set({ elsewhere: { g1: { app: 'claude-desktop', running: true, hard: false } }, drafts: {} });
  const file = { kind: 'file', path: '/b', name: 'b' } as const;
  // a goal held first: a plain message after it goes back to the composer, with its file
  await S.sendMessage('g1', 'ship it', [], { goal: 'ship it' } as any);
  await S.sendMessage('g1', 'and this', [file]);
  assert.deepEqual(st().runtime.g1.held, { text: 'ship it', attachments: [], opts: { goal: 'ship it' } });
  assert.deepEqual(st().drafts.g1, { text: 'and this', attachments: [file] });
  assert.match(st().toasts.at(-1)!.text, /A message is already waiting to send here/);
  // a plain message held first: a goal after it goes back too
  set({ elsewhere: { g2: { app: 'claude-desktop', running: true, hard: false } } });
  await S.sendMessage('g2', 'plain', []);
  await S.sendMessage('g2', 'a plan', [], { plan: true } as any);
  assert.deepEqual(st().runtime.g2.held, { text: 'plain', attachments: [], opts: {} });
  assert.equal(st().drafts.g2.text, 'a plan');
  // a held goal main didn't take is held again, and a message held since goes back rather than merge into it
  S.setElsewhere('g1', { app: 'claude-desktop', running: false, hard: false });
  impl['proxy.send'] = async () => {
    S.patchRuntime('g1', () => ({ held: { text: 'since', attachments: [], opts: {} } }));
    throw new Error('main is gone');
  };
  set({ drafts: {} });
  await S.sendHeld('g1', true);
  assert.deepEqual(st().runtime.g1.held, { text: 'ship it', attachments: [], opts: { goal: 'ship it' } });
  assert.equal(st().drafts.g1.text, 'since');
});

test('a chat opened by navigation that fails to load says so', async () => {
  noteOwner('nav1', 'claude');
  impl['claude.openClaudeThread'] = async () => {
    throw new Error('transcript unreadable');
  };
  S.navigate({ name: 'thread', id: 'nav1' });
  await flush();
  assert.equal(st().toasts.at(-1)!.text, "Couldn't open the chat: transcript unreadable");
});

test('while another Codex client holds the lock, a held message retries until it is free', async () => {
  set({ elsewhere: { k1: { app: 'codex', running: false, hard: true } } });
  let locked = true;
  // main takes the lease and says so before answering
  impl['codex.resume'] = async (id: string) => (locked || item({ kind: 'lease', threadId: id, held: true }), { locked });
  await S.sendMessage('k1', 'wait');
  await S.sendMessage('k1', 'more');
  mock.timers.tick(5000);
  await flush();
  assert.equal(callsOf('codex.resume').length, 1);
  assert.ok(st().runtime.k1.held);
  locked = false;
  mock.timers.tick(5000);
  await flush();
  assert.equal(st().toasts.at(-1)!.text, 'The other Codex app let go of this chat. Sending your message.');
  assert.deepEqual(
    callsOf('proxy.send').map((a) => a[1]),
    ['wait\n\nmore'],
  );
  // nothing held any more, or the other app is writing: the retry stops
  set({ elsewhere: { k2: { app: 'codex', running: false, hard: true } } });
  await S.sendMessage('k2', 'x');
  S.cancelHeld('k2');
  mock.timers.tick(5000);
  await flush();
  set({ elsewhere: { k3: { app: 'codex', running: false, hard: true } } });
  await S.sendMessage('k3', 'x');
  set({ elsewhere: { k3: { app: 'codex', running: true, hard: true } } });
  mock.timers.tick(5000);
  await flush();
  assert.equal(callsOf('codex.resume').length, 2);
});

test('a message held while another Codex app runs goes out when it finishes, after the chat left the screen', async () => {
  impl['api.threadTurns'] = async () => ({ data: [serverTurn('o1', { status: 'inProgress' })], nextCursor: null });
  impl['api.threadRead'] = async () => ({ thread: { id: 'w1', path: '/r/w1.jsonl' } });
  set({ route: { name: 'thread', id: 'w1' } as any });
  await S.openThread('w1');
  await flush();
  assert.deepEqual(st().elsewhere.w1, { app: 'codex', running: true, hard: true });
  await S.sendMessage('w1', 'after yours');
  assert.equal(st().runtime.w1.held?.text, 'after yours');
  // the user goes elsewhere while the other app is still writing: the chat stays followed
  set({ route: { name: 'home' } });
  listeners['codex.onRollout']('w1');
  calls.length = 0;
  mock.timers.tick(4000);
  await flush();
  assert.equal(callsOf('api.threadTurns').length, 1);
  assert.deepEqual(callsOf('codex.unwatchRollout'), []);
  // it finishes: the message goes out, and the follow then ends
  impl['api.threadTurns'] = async () => ({ data: [serverTurn('o1')], nextCursor: null });
  impl['codex.resume'] = async () => ({ locked: false });
  listeners['codex.onRollout']('w1');
  await flush();
  await flush();
  assert.deepEqual(
    callsOf('proxy.send')
      .filter((a) => a[0] === 'w1')
      .map((a) => a[1]),
    ['after yours'],
  );
  assert.equal(st().runtime.w1.held, null);
  mock.timers.tick(4000);
  assert.deepEqual(callsOf('codex.unwatchRollout'), [['w1']]);
});

test('a held message is sent once the resume succeeds, even when main already held the lease and says nothing', async () => {
  set({ elsewhere: { k9: { app: 'codex', running: false, hard: true } } });
  let locked = true;
  // main already holds the lease, so a successful resume sends no lease event
  impl['codex.resume'] = async () => ({ locked });
  await S.sendMessage('k9', 'stuck?');
  locked = false;
  mock.timers.tick(5000);
  await flush();
  assert.deepEqual(
    callsOf('proxy.send')
      .filter((a) => a[0] === 'k9')
      .map((a) => a[1]),
    ['stuck?'],
  );
  assert.equal(st().elsewhere.k9, undefined);
  assert.equal(st().runtime.k9.held, null);
});

test("sendOrDraft: a message main didn't take waits in the chat's composer, after anything typed there", async () => {
  impl['proxy.send'] = async () => ({ action: 'started', id: 'draft-input' });
  assert.equal(await S.sendOrDraft('d1', 'review it', { human: true }), true);
  assert.equal(st().drafts.d1, undefined);
  impl['proxy.send'] = () => Promise.reject(new Error('refused'));
  // no composer on screen: the stored draft takes it
  assert.equal(await S.sendOrDraft('d1', 'review it'), false);
  assert.deepEqual(st().drafts.d1, { text: 'review it', attachments: [] });
  // a composer on screen takes it itself
  const inserted: unknown[] = [];
  const take = (e: Event) => {
    const d = (e as CustomEvent).detail;
    inserted.push([d.threadId, d.text]);
    d.handled = true;
  };
  window.addEventListener('composer-insert', take);
  try {
    assert.equal(await S.sendOrDraft('d2', 'note'), false);
    assert.deepEqual(inserted, [['d2', 'note']]);
    assert.equal(st().drafts.d2, undefined);
  } finally {
    window.removeEventListener('composer-insert', take);
  }
  // something typed there already stays, with the message below it
  const file = { kind: 'file', path: '/a', name: 'a' } as const;
  set({
    drafts: {
      ...st().drafts,
      d3: { text: 'mine', attachments: [] },
      d4: { text: '', attachments: [file] },
      d5: { text: 'line\n', attachments: [] },
    },
  });
  await S.sendOrDraft('d3', 'note');
  await S.sendOrDraft('d4', 'note');
  await S.sendOrDraft('d5', 'note');
  assert.deepEqual(st().drafts.d3, { text: 'mine\nnote', attachments: [] });
  assert.deepEqual(st().drafts.d4, { text: 'note', attachments: [file] });
  assert.equal(st().drafts.d5.text, 'line\nnote');
  delete impl['proxy.send'];
});

test('sendMessage: a new chat for no chat, its plan mode, the handoff carried on the first message, and a failed send', async () => {
  set({ newChatTemporary: true });
  assert.equal(await S.sendMessage(null, 'x', [], { goal: 'g' }), false);
  assert.equal(st().toasts[0].text, "Temporary chats can't have goals");
  set({ newChatTemporary: false, newChatCwd: '/w', newChatProjectId: null, conn: 'ready' });
  impl['codex.startThread'] = async () => ({ thread: { id: 'n1', cwd: '/w' } });
  await S.sendMessage(null, 'hello\nmore', [], { plan: true });
  assert.deepEqual(callsOf('session.patch')[0], ['n1', { plan: true }]);
  assert.deepEqual(callsOf('proxy.send')[0], ['n1', 'hello\nmore', [], { plan: true }, 'queue']);
  impl['codex.startThread'] = () => Promise.reject(new Error('no'));
  // the chat didn't start (createChatThread said why): the caller keeps the message
  assert.equal(await S.sendMessage(null, 'x'), false);
  assert.equal(callsOf('proxy.send').length, 1);
  impl['codex.startThread'] = async () => ({ thread: { id: 'n2', cwd: '/w' } });
  await S.sendMessage(null, 'y');
  assert.equal(callsOf('session.patch').length, 1);
  set({ handoffCarry: { c1: { text: 'HANDOFF', fromTitle: 'T' }, c2: { text: 'H2', fromTitle: 'T' } } });
  await S.sendMessage('c1', 'go');
  await S.sendMessage('c2', 'go', [], { prefix: 'own' });
  assert.deepEqual(
    callsOf('proxy.send')
      .slice(2)
      .map((a) => a[3].prefix),
    ['HANDOFF', 'H2\n\nown'],
  );
  assert.deepEqual(st().handoffCarry, {});
  // a pending switch, a busy session or a running turn go straight to main even while held elsewhere
  set({
    elsewhere: {
      b1: { app: 'codex', running: true, hard: true },
      b2: { app: 'codex', running: true, hard: true },
      b3: { app: 'codex', running: true, hard: true },
    },
    runtime: { b3: { activeTurnId: 't' } as any },
  });
  session('b1', { pendingSwitch: { harness: 'claude' } });
  session('b2', { turn: 'running' });
  await S.sendMessage('b1', 'x');
  await S.sendMessage('b2', 'x');
  await S.sendMessage('b3', 'x');
  assert.equal(callsOf('proxy.send').length, 7);
  impl['proxy.send'] = () => Promise.reject(new Error('closed'));
  await S.sendMessage('c1', 'x');
  impl['proxy.send'] = () => Promise.reject('plain');
  await S.sendMessage('c1', 'x');
  assert.deepEqual(
    st()
      .toasts.slice(-2)
      .map((t) => t.text),
    ["Couldn't send: closed", "Couldn't send: plain"],
  );
});

test('createChatThread picks the folder and harness for the new chat', async () => {
  set({ conn: 'ready', home: '/home/me' });
  // projectless: a dated folder of its own
  impl['fs.mkdirProjectless'] = async (root: string, _date: string, slug: string) => ({ ok: true, path: `${root}/${slug}` });
  impl['codex.startThread'] = async (p: any) => ({ thread: { id: `cx-${p.cwd}`, cwd: p.cwd } });
  set({ newChatProjectId: 'none' });
  assert.equal(await S.createChatThread('Fix the Bug!'), 'cx-/home/me/Documents/MoPilot/fix-the-bug');
  assert.deepEqual(st().route, { name: 'thread', id: 'cx-/home/me/Documents/MoPilot/fix-the-bug' });
  await S.createChatThread('!!!');
  assert.equal(callsOf('fs.mkdirProjectless').at(-1)![2], 'chat');
  impl['fs.mkdirProjectless'] = async () => ({ ok: false, error: 'read-only' });
  assert.equal(await S.createChatThread('x'), null);
  assert.equal(st().toasts.at(-1)!.text, "Failed to start chat: Couldn't create the chat folder: read-only");
  // a project in a worktree, with its setup script
  set({
    newChatProjectId: 'p',
    savedProjects: [{ id: 'p', name: 'P', roots: [{ path: '/w/p' }], source: 'codex', codexId: 'cxp' }],
  });
  S.setNewChatWorktree(true);
  impl['git.worktreeAdd'] = async () => ({ ok: true, path: '/wt/p1', branch: 'mopilot/a', repo: '/w/p', worktree: '/wt/p1' });
  impl['env.resolve'] = async () => resolvedEnvironment({ setup: 'npm i' });
  impl['env.runScript'] = async () => ({ exitCode: 2, output: 'step\nnpm ERR!\n' });
  await S.createChatThread('x');
  assert.deepEqual(callsOf('git.worktreeAdd').at(-1), ['/w/p', { prefix: 'mopilot/', root: '/home/me/.mopilot/worktrees' }]);
  assert.deepEqual(callsOf('env.runScript').at(-1), ['/wt/p1', 'npm i']);
  assert.ok(st().toasts.some((t) => t.text === 'Setup script failed (exit 2): npm ERR!'));
  assert.ok(st().toasts.some((t) => t.text === 'Working in worktree on mopilot/a'));
  // an environment.toml that is there but can't be read: said, and the worktree goes on without its script
  impl['env.resolve'] = async () => resolvedEnvironment({ source: 'environment', error: 'EACCES: permission denied' });
  const scripts = callsOf('env.runScript').length;
  set({ toasts: [] });
  await S.createChatThread('x');
  assert.ok(st().toasts.some((t) => t.text === "Couldn't read the setup script: EACCES: permission denied"));
  assert.ok(st().toasts.some((t) => t.text === 'Working in worktree on mopilot/a'));
  assert.equal(callsOf('env.runScript').length, scripts);
  impl['env.resolve'] = async () => resolvedEnvironment({ setup: 'npm i' });
  assert.equal(st().worktreeOf['cx-/wt/p1'], '/w/p');
  assert.equal(callsOf('codex.startThread').at(-1)![0].projectId, 'cxp');
  assert.equal(st().chatProject['cx-/wt/p1'], 'p');
  // the setup script passing, or no script: no toast
  impl['env.runScript'] = async () => ({ exitCode: 0, output: '' });
  set({ toasts: [] });
  await S.createChatThread('x');
  impl['env.resolve'] = async () => resolvedEnvironment({ source: 'environment' });
  await S.createChatThread('x');
  delete impl['env.resolve'];
  await S.createChatThread('x');
  assert.deepEqual(
    st().toasts.map((t) => t.text),
    ['Working in worktree on mopilot/a', 'Working in worktree on mopilot/a', 'Working in worktree on mopilot/a'],
  );
  impl['git.worktreeAdd'] = async () => ({ ok: false, error: 'dirty' });
  set({ newChatWorktree: true, newChatWorktreeHintOff: '/w/p' });
  await S.createChatThread('x');
  assert.equal(st().toasts.at(-1)!.text, "Failed to start chat: Couldn't create worktree: dirty");
  // a chat that didn't start keeps its draft's choices for the retry
  assert.deepEqual([st().newChatWorktree, st().newChatWorktreeHintOff], [true, '/w/p']);
  set({ newChatWorktree: null, newChatWorktreeHintOff: null });
  // an explicit folder in a worktree, on Claude Code: no project, but the folder it came from is kept
  impl['git.worktreeAdd'] = async () => ({ ok: true, path: '/wt/f', branch: 'b', repo: '/f', worktree: '/wt/f' });
  impl['claude.startClaudeThread'] = (o: any) => `cl-${o.cwd}`;
  set({
    newChatCwd: '/f',
    newChatProjectId: null,
    prefs: { ...st().prefs, defaultHarness: 'claude' },
    claude: { status: { state: 'ready' } as any, models: [] },
  });
  assert.equal(await S.createChatThread('x'), 'cl-/wt/f');
  assert.equal(st().worktreeOf['cl-/wt/f'], '/f');
  // a project on Claude Code in a worktree remembers the project folder
  set({ newChatCwd: null, newChatProjectId: 'p' });
  impl['git.worktreeAdd'] = async () => ({ ok: true, path: '/wt/c', branch: 'b', repo: '/w/p', worktree: '/wt/c' });
  await S.createChatThread('x');
  assert.equal(st().worktreeOf['cl-/wt/c'], '/w/p');
  assert.deepEqual(callsOf('claude.startClaudeThread').at(-1), [{ cwd: '/wt/c', projectId: 'p', ephemeral: undefined }]);
  // a basic harness picked for new chats
  S.setNewChatWorktree(false);
  set({
    basicHarnesses: [{ id: 'kimi', state: 'admitted' }] as any,
    prefs: { ...st().prefs, defaultHarness: 'acp:kimi' },
  });
  impl['acp.startAcpThread'] = (o: any) => `acp:${o.harness}:1`;
  assert.equal(await S.createChatThread('x'), 'acp:kimi:1');
  assert.equal(st().worktreeOf['acp:kimi:1'], undefined, 'not in a worktree');
  // a basic harness in a worktree keeps its project folder too, so a pruned worktree can be restored
  impl['git.worktreeAdd'] = async () => ({ ok: true, path: '/wt/k', branch: 'b', repo: '/w/p', worktree: '/wt/k' });
  impl['acp.startAcpThread'] = (o: any) => `acp:${o.harness}:${o.cwd}`;
  // the suggestion's choice for this draft: this chat only, and the draft's dismissal ends with it
  set({ newChatWorktree: true, newChatWorktreeHintOff: '/w/p' });
  assert.equal(await S.createChatThread('x'), 'acp:kimi:/wt/k');
  assert.equal(st().worktreeOf['acp:kimi:/wt/k'], '/w/p');
  assert.deepEqual([st().newChatWorktree, st().newChatWorktreeHintOff], [null, null]);
  // a choice made on the next draft while this chat was starting stays with that draft
  let started!: (id: string) => void;
  impl['acp.startAcpThread'] = () => new Promise((r) => (started = r));
  set({ newChatWorktree: true, newChatWorktreeHintOff: null });
  const pending = S.createChatThread('x');
  await flush();
  set({ newChatWorktree: false, newChatWorktreeHintOff: '/w/p' });
  started('acp:kimi:2');
  assert.equal(await pending, 'acp:kimi:2');
  assert.deepEqual([st().newChatWorktree, st().newChatWorktreeHintOff], [false, '/w/p']);
  set({ newChatWorktree: null, newChatWorktreeHintOff: null });
  impl['acp.startAcpThread'] = (o: any) => `acp:${o.harness}:1`;
  set({ newChatCwd: '/loose', newChatProjectId: null });
  await S.createChatThread('x');
  assert.deepEqual(callsOf('acp.startAcpThread').at(-1), [{ cwd: '/loose', projectId: null, harness: 'kimi' }]);
  set({ newChatCwd: null, newChatProjectId: 'p' });
  // temporary: never on a basic harness (Claude Code instead), and reset after
  set({ newChatTemporary: true, prefs: { ...st().prefs, defaultHarness: 'acp:kimi' } });
  await S.createChatThread('x');
  assert.deepEqual(callsOf('claude.startClaudeThread').at(-1), [{ cwd: '/w/p', projectId: 'p', ephemeral: true }]);
  assert.equal(st().newChatTemporary, false);
  // temporary on Codex
  set({ newChatTemporary: true, basicHarnesses: [], prefs: { ...st().prefs, defaultHarness: 'codex' } });
  await S.createChatThread('x');
  assert.equal(callsOf('codex.startThread').at(-1)![0].ephemeral, true);
  impl['codex.startThread'] = () => Promise.reject('plain');
  await S.createChatThread('x');
  assert.equal(st().toasts.at(-1)!.text, 'Failed to start chat: plain');
});

test('startThread starts a Codex chat with the defaults and keeps them as its own', async () => {
  set({ prefs: { ...st().prefs, model: 'm', effort: 'high', serviceTier: 'fast', permission: 'read-only', hiddenFolders: ['/w'] } });
  impl['codex.startThread'] = async (p: any) => ({ thread: { id: p.ephemeral ? 'tmp' : 'st1', cwd: p.cwd } });
  assert.equal(await S.startThread({ cwd: '/w', projectId: 'cx' }), 'st1');
  assert.deepEqual(callsOf('codex.startThread')[0], [
    { cwd: '/w', projectId: 'cx', model: 'm', approvalPolicy: 'on-request', sandbox: 'read-only', ephemeral: false, serviceTier: 'fast' },
  ]);
  assert.deepEqual(st().chatConfig.st1, { model: 'm', effort: 'high', serviceTier: 'fast' });
  assert.equal(st().chatProject.st1, 'cx');
  assert.deepEqual(st().prefs.hiddenFolders, []);
  assert.deepEqual(st().threadOrder, ['st1']);
  set({ prefs: { ...st().prefs, hiddenFolders: ['/w'] } });
  await S.startThread({ cwd: '/w', ephemeral: true });
  assert.deepEqual(st().prefs.hiddenFolders, ['/w']);
  assert.equal(st().chatConfig.tmp, undefined);
  assert.equal(st().chatProject.tmp, undefined);
  assert.equal(callsOf('codex.startThread')[1][0].projectId, undefined);
  // the default harness for a folder
  set({ conn: 'ready' });
  assert.equal(await S.startDefaultChat('/w'), 'st1');
  set({ prefs: { ...st().prefs, defaultHarness: 'claude' }, claude: { status: { state: 'ready' } as any, models: [] } });
  impl['claude.startClaudeThread'] = () => 'cl';
  assert.equal(await S.startDefaultChat('/w', 'p'), 'cl');
  assert.deepEqual(callsOf('claude.startClaudeThread')[0], [{ cwd: '/w', projectId: 'p' }]);
});

test('loadOlderTurns pages back on a Codex chat (Claude Code, basic harnesses: tests/turnPaging.test.ts)', async () => {
  set({
    runtime: {
      o1: { olderCursor: 'c1', turns: [{ id: 'new' }] } as any,
      o3: { olderCursor: null } as any,
    },
  });
  impl['api.threadTurns'] = async () => ({ data: [serverTurn('b'), serverTurn('a')], nextCursor: null });
  await S.loadOlderTurns('o1');
  await S.loadOlderTurns('o3');
  await S.loadOlderTurns('none');
  assert.deepEqual(callsOf('api.threadTurns'), [['o1', { limit: 30, cursor: 'c1', itemsView: 'full' }]]);
  assert.deepEqual(
    st().runtime.o1.turns.map((t) => t.id),
    ['a', 'b', 'new'],
  );
  assert.equal(st().runtime.o1.olderCursor, null);
});

test('loadOlderTurns: a second request while a page is read shares it; a page for a cursor that moved is dropped', async () => {
  set({ runtime: { p1: { olderCursor: 'c1', turns: [{ id: 'b' }, { id: 'new' }] } as any } });
  let answer: (v: any) => void = () => undefined;
  impl['api.threadTurns'] = () => new Promise((r) => (answer = r));
  const before = callsOf('api.threadTurns').length;
  const one = S.loadOlderTurns('p1');
  const two = S.loadOlderTurns('p1');
  assert.equal(one, two);
  // the page overlaps what is shown ('b'): it is shown once
  answer({ data: [serverTurn('b'), serverTurn('a')], nextCursor: 'c0' });
  await one;
  assert.equal(callsOf('api.threadTurns').length - before, 1);
  assert.deepEqual(
    st().runtime.p1.turns.map((t) => t.id),
    ['a', 'b', 'new'],
  );
  assert.equal(st().runtime.p1.olderCursor, 'c0');
  // the chat was read again while the page was on its way: paging starts over from that read
  const three = S.loadOlderTurns('p1');
  S.patchRuntime('p1', () => ({ olderCursor: 'fresh' }));
  answer({ data: [serverTurn('z')], nextCursor: null });
  await three;
  assert.deepEqual(
    st().runtime.p1.turns.map((t) => t.id),
    ['a', 'b', 'new'],
  );
  assert.equal(st().runtime.p1.olderCursor, 'fresh');
});

test('opening a chat again keeps the older pages loaded before ahead of the latest turns', async () => {
  impl['api.threadRead'] = async () => ({ thread: { id: 'q1', model: null, reasoningEffort: null } });
  impl['api.threadGoal'] = async () => ({ goal: null });
  impl['api.threadTurns'] = async () => ({ data: [serverTurn('t4'), serverTurn('t3')], nextCursor: 'page2' });
  set({
    runtime: {
      q1: { loaded: true, olderCursor: 'page3', turns: [{ id: 't1' }, { id: 't2' }, { id: 't3' }] } as any,
    },
  });
  await S.openThread('q1');
  await flush();
  assert.deepEqual(
    st().runtime.q1.turns.map((t) => t.id),
    ['t1', 't2', 't3', 't4'],
  );
  assert.equal(st().runtime.q1.olderCursor, 'page3');
});

test('sendMessage: steer: true steers whatever the follow-up preference; otherwise the preference decides', async () => {
  const before = callsOf('proxy.send').length;
  await S.sendMessage('s1', 'continue', [], { human: true, steer: true });
  await S.sendMessage('s1', 'plain');
  const sends = callsOf('proxy.send').slice(before);
  assert.deepEqual(
    sends.map((a) => [a[1], a[4]]),
    [
      ['continue', 'steer'],
      ['plain', st().prefs.followUp],
    ],
  );
});
