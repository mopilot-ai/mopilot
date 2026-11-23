// A displayed Codex completion means main has settled the same turn, so a post-Stop follow-up cannot be trapped behind it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setup as adapterFixture, settle } from './support/codex-adapter/fixture.ts';
import { setup as controllerFixture, selectSegment } from './support/controller/fixture.ts';
import { deferred } from './support/async-scenarios.ts';

for (const rejected of [false, true]) {
  test(`interrupted completion settles main before publication after ${rejected ? 'failed' : 'successful'} snapshot capture`, async () => {
    const capture = deferred<string>();
    const f = controllerFixture();
    selectSegment(f.c, f.chats, 'chat', [['codex', 'native']]);
    const oldQueue = { id: 'before-stop', text: 'Earlier queued input', opts: {}, attachments: [] };
    f.state.patch('chat', { turn: 'running', activeTurn: { id: 'old', human: true }, queue: [oldQueue] });
    Object.assign(f.c.rt('chat'), { token: 'old', inputToken: 'pending-old' });
    const { a, server, events } = adapterFixture({}, { segments: { chat: 'native' }, turnChanges: { finish: () => capture.promise } });
    a.observe = (msg: any) => f.c.onCodexMessage(msg);
    const emit = a.emit;
    const actions: string[] = [];
    a.emit = (event: any, target: any) => {
      emit(event, target);
      if (event.method === 'turn/completed') {
        // This models a user action after the displayed completion, using the real controller send boundary.
        actions.push(f.c.send('chat', { id: 'after-stop', text: 'Continue task', opts: { human: true }, attachments: [] }, 1).action);
      }
    };
    try {
      server.notify('turn/completed', { threadId: 'native', turn: { id: 'old', status: 'interrupted' } });
      assert.equal(events.filter(({ e }) => e.method === 'turn/completed').length, 0);
      assert.equal(f.s('chat').turn, 'running');
      if (rejected) capture.reject(new Error('snapshot failed'));
      else capture.resolve('captured diff');
      await settle();
      assert.deepEqual(actions, ['started']);
      assert.equal(events.filter(({ e }) => e.method === 'turn/completed').length, 1);
      assert.equal(f.execs.at(-1)?.item.id, 'after-stop');
      assert.deepEqual(
        f.s('chat').queue.map((q: any) => q.id),
        ['before-stop'],
      );
    } finally {
      server.listeners.clear();
      f.c.end('chat', { drain: false });
      fs.rmSync(f.chats.dir, { recursive: true, force: true });
    }
  });
}

test('a snapshot finishing after server restart cannot end a pending retry or publish retired output', async () => {
  const capture = deferred<string>();
  const f = controllerFixture({ auto: false });
  selectSegment(f.c, f.chats, 'chat', [['codex', 'native']]);
  f.state.patch('chat', { turn: 'running', activeTurn: { id: 'old', human: true } });
  Object.assign(f.c.rt('chat'), { token: 'old', inputToken: 'pending-old' });
  const { a, server, events } = adapterFixture(
    {},
    { segments: { chat: 'native' }, turnChanges: { finish: () => capture.promise, clear() {} } },
  );
  a.observe = (msg: any) => f.c.onCodexMessage(msg);
  a.onExit = () => {
    f.c.onCodexExit();
    return [];
  };
  try {
    await a.connect();
    server.notify('turn/completed', { threadId: 'native', turn: { id: 'old', status: 'interrupted' } });
    server.emit({ kind: 'stopped' });
    await a.connect();
    f.c.send('chat', { id: 'retry', text: 'Continue task', opts: { human: true }, attachments: [] }, 1);
    const pending = f.s('chat').activeTurn.id;
    assert.match(pending, /^pending-/);
    capture.resolve('retired diff');
    await settle();
    assert.equal(f.s('chat').activeTurn.id, pending);
    assert.equal(events.filter(({ e }) => ['turn/completed', 'turn/diff/updated'].includes(e.method)).length, 0);
    f.execs.at(-1)!.done({ started: true, turnId: 'replacement' });
    await settle();
    assert.equal(f.s('chat').activeTurn.id, 'replacement');
  } finally {
    server.listeners.clear();
    f.c.end('chat', { drain: false });
    fs.rmSync(f.chats.dir, { recursive: true, force: true });
  }
});

test('replacement of the server process also retires pending snapshot publication', async () => {
  const capture = deferred<string>();
  const { a, server, observed, events } = adapterFixture({}, { turnChanges: { finish: () => capture.promise } });
  try {
    await a.connect();
    server.notify('turn/completed', { threadId: 'native', turn: { id: 'old' } });
    server.proc = {};
    capture.resolve('retired diff');
    await settle();
    assert.equal(observed.filter((msg) => msg.method === 'turn/completed').length, 0);
    assert.equal(events.filter(({ e }) => ['turn/completed', 'turn/diff/updated'].includes(e.method)).length, 0);
  } finally {
    server.listeners.clear();
  }
});

test('a Codex turn’s completion asks for its file checkpoint (a rewind restores files from it)', async () => {
  const finished: unknown[][] = [];
  const { a, server } = adapterFixture({}, { turnChanges: { finish: async (...args: unknown[]) => (finished.push(args), undefined) } });
  try {
    await a.connect();
    server.notify('turn/completed', { threadId: 'native', turn: { id: 'done' } });
    await settle();
    assert.deepEqual(finished, [['native', 'done', { checkpoint: true }]]);
  } finally {
    server.listeners.clear();
  }
});
