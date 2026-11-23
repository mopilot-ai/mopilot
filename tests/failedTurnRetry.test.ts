// Terminal-failure Retry preserves original input and cannot restart healthy, historical or superseded work.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { act, createElement } from 'react';
import { stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';
const f: any = {};
const user = (content: any[]) => ({ type: 'userMessage', id: 'u', content });
const failed = (id = 't1', text = 'hello') => ({ id, status: 'failed', items: [user([{ type: 'text', text }])] });
const runtime = (turn = failed()) => ({ turns: [turn], activeTurnId: null });
function reset() {
  Object.assign(f, {
    state: { runtime: { c1: runtime() } },
    session: { turn: 'idle', rev: 7, queue: [] },
    sends: [],
    drafts: [],
    toasts: [],
    send: async () => true,
  });
}
reset();
// the machine's answer for a picture, and the file this app saves it in
installNativeStub({
  host: { picture: (chatId: string, url: string) => f.picture(chatId, url) },
  fs: { saveTempImage: (dataUrl: string) => f.save(dataUrl) },
});
mock.module(new URL('../src/store/session/useSession.ts', import.meta.url).href, {
  namedExports: {
    flushSessionPatches: () => {},
    sessionOf: () => f.session,
    useSession: () => f.session,
    useSessionField: (id: any, pick: any) => pick(((() => f.session) as (id: any) => any)(id)),
  },
});
stubStore(
  {
    useStore: (selector: any) => selector(f.state),
    toastFailure: (what: string) => (error: unknown) => f.toasts.push([what, String(error)]),
  },
  {
    'src/store/core.ts': { get: () => f.state },
    'src/store/send.ts': {
      sendMessage: async (...args: any[]) => {
        f.sends.push(args);
        return f.send(...args);
      },
      giveBackToComposer: (...args: any[]) => f.drafts.push(args),
    },
  },
);
const { messageOf, failedTurnForRetry, retryFailedTurn } = await import('../src/store/failedTurnRetry.ts');
const { FailedTurnRetry } = await import('../src/components/thread/FailedTurnRetry.tsx');
const { createRoot } = await import('react-dom/client');

test('messageOf: the text and the attachments the turn started with, as the composer sends them', () => {
  assert.deepEqual(
    messageOf([
      { type: 'reasoning', id: 'r' },
      user([
        { type: 'text', text: 'fix the bug' },
        { type: 'text', text: 'and test it' },
        { type: 'localImage', path: '/tmp/shot.png' },
        { type: 'skill', path: '/s/review/SKILL.md', name: 'review' },
        { type: 'mention', path: 'C:\\work\\notes.md' },
        { type: 'image', url: 'https://x/y.png' },
        { type: 'mention' },
      ]),
    ] as any),
    {
      text: 'fix the bug\nand test it',
      attachments: [
        { kind: 'image', path: '/tmp/shot.png', name: 'shot.png' },
        { kind: 'skill', path: '/s/review/SKILL.md', name: 'review' },
        { kind: 'file', path: 'C:\\work\\notes.md', name: 'notes.md' },
      ],
    },
  );
  // a skill with no name is named by its file
  assert.equal(messageOf([user([{ type: 'skill', path: '/s/x.md' }])] as any)!.attachments[0].name, 'x.md');
  assert.deepEqual(messageOf([user([{ type: 'localImage', path: '/a.png' }])] as any), {
    text: '',
    attachments: [{ kind: 'image', path: '/a.png', name: 'a.png' }],
  });
  assert.equal(messageOf([user([{ type: 'text', text: '  ' }])] as any), null);
  assert.equal(messageOf([{ type: 'userMessage', id: 'u' }] as any), null);
  assert.equal(messageOf([] as any), null);
});

test('only the latest failed turn in an idle chat can Retry; current and historical work stay untouched', async () => {
  reset();
  assert.equal(failedTurnForRetry(undefined, 't1'), null);
  assert.equal(failedTurnForRetry({ turns: [], activeTurnId: null }, 't1'), null);
  assert.equal(await retryFailedTurn('missing', 't1'), false);
  assert.equal(await retryFailedTurn('c1', 'older'), false);
  for (const status of ['inProgress', 'interrupted', 'completed']) {
    f.state.runtime.c1.turns[0].status = status;
    assert.equal(await retryFailedTurn('c1', 't1'), false);
  }
  reset();
  f.state.runtime.c1.activeTurnId = 'new';
  assert.equal(await retryFailedTurn('c1', 't1'), false);
  reset();
  for (const turn of ['running', 'awaitingUser']) {
    f.session = { turn, rev: 7, queue: [] };
    assert.equal(await retryFailedTurn('c1', 't1'), false);
  }
  assert.deepEqual(f.sends, []);
  reset();
  f.state.runtime.c1.turns.push(failed('t2'));
  assert.equal(await retryFailedTurn('c1', 't1'), false);
  assert.equal(await retryFailedTurn('c1', 't2'), true);
  assert.deepEqual(f.sends, [['c1', 'hello', [], { human: true, retryAtRevision: 7 }]]);
});

test('no original message sends nothing; attachments and text are sent without an interrupt', async () => {
  reset();
  f.state.runtime.c1.turns[0].items = [];
  assert.equal(await retryFailedTurn('c1', 't1'), false);
  assert.deepEqual(f.sends, []);
  f.state.runtime.c1.turns[0].items = [
    user([
      { type: 'text', text: 'fix' },
      { type: 'localImage', path: '/shot.png' },
    ]),
  ];
  f.send = async () => undefined;
  assert.equal(await retryFailedTurn('c1', 't1'), true);
  assert.deepEqual(f.sends, [['c1', 'fix', [{ kind: 'image', path: '/shot.png', name: 'shot.png' }], { human: true, retryAtRevision: 7 }]]);
  assert.deepEqual(f.drafts, []);
});

test('input already retained in the queue or a writer-lock hold has one owner and cannot be resent from the failure', async () => {
  reset();
  f.session.queue = [{ id: 'kept', text: 'hello' }];
  assert.equal(await retryFailedTurn('c1', 't1'), false);
  assert.deepEqual(f.sends, []);
  reset();
  f.state.runtime.c1.held = { text: 'hello', attachments: [], opts: { human: true } };
  assert.equal(await retryFailedTurn('c1', 't1'), false);
  assert.deepEqual(f.sends, []);
});

test('duplicate clicks coalesce per chat; independent chats can finish in either order', async () => {
  for (const order of [
    ['c1', 'c2'],
    ['c2', 'c1'],
  ]) {
    reset();
    f.state.runtime.c2 = runtime();
    const settle: Record<string, (value: boolean) => void> = {};
    f.send = (id: string) =>
      new Promise((resolve) => {
        settle[id] = resolve;
      });
    const one = retryFailedTurn('c1', 't1');
    const two = retryFailedTurn('c2', 't1');
    assert.equal(await retryFailedTurn('c1', 't1'), false);
    assert.equal(f.sends.length, 2);
    settle[order[0]](true);
    settle[order[1]](false);
    assert.deepEqual(await Promise.all([one, two]), order[0] === 'c1' ? [true, false] : [false, true]);
    assert.equal(f.drafts[0][0], order[1]);
  }
});

test('refused and thrown sends retain accepted user input in the original chat; retry works after failure', async () => {
  reset();
  f.send = async () => false;
  assert.equal(await retryFailedTurn('c1', 't1'), false);
  assert.deepEqual(f.drafts, [['c1', 'hello', []]]);
  f.send = async () => {
    throw new Error('offline');
  };
  await assert.rejects(retryFailedTurn('c1', 't1'), /offline/);
  assert.equal(f.drafts.length, 2);
  f.send = async () => true;
  assert.equal(await retryFailedTurn('c1', 't1'), true);
  assert.equal(f.sends.length, 3);
});

test('a pending send owns its input after the visible chat/turn changes; it never starts a second continuation', async () => {
  reset();
  let reject!: (error: Error) => void;
  f.send = () =>
    new Promise((_, no) => {
      reject = no;
    });
  const pending = retryFailedTurn('c1', 't1');
  f.state = { runtime: { c1: runtime(failed('new', 'newer input')) } };
  assert.equal(await retryFailedTurn('c1', 'new'), false);
  reject(new Error('offline'));
  await assert.rejects(pending, /offline/);
  assert.deepEqual(f.drafts, [['c1', 'hello', []]]);
  f.send = async () => true;
  assert.equal(await retryFailedTurn('c1', 'new'), true);
  assert.equal(f.sends.length, 2);
});

async function mount(chatId = 'c1', turnId = 't1') {
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as any);
  const update = () => act(async () => root.render(createElement(FailedTurnRetry, { chatId, turnId })));
  await update();
  return {
    host,
    update,
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('the failure action disables while sending and reports a failure without losing input', async () => {
  reset();
  const view = await mount();
  let reject!: (error: Error) => void;
  f.send = () =>
    new Promise((_, no) => {
      reject = no;
    });
  await act(async () => view.host.querySelector('button')!.click());
  assert.equal(view.host.textContent, 'Retrying…');
  assert.equal(view.host.querySelector('button')!.disabled, true);
  await act(async () => reject(new Error('offline')));
  assert.equal(view.host.textContent, 'Retry');
  assert.deepEqual(f.toasts, [["Couldn't retry", 'Error: offline']]);
  assert.deepEqual(f.drafts, [['c1', 'hello', []]]);
  f.send = async () => true;
  await act(async () => view.host.querySelector('button')!.click());
  assert.equal(f.sends.length, 2);
  f.state.runtime.c1 = runtime(failed('new'));
  await view.update();
  assert.equal(view.host.textContent, '');
  await view.close();
});

test('missing input, an active main turn or a newer turn hides Retry; unmount leaves no automatic resend', async () => {
  reset();
  const view = await mount();
  for (const turn of ['running', 'awaitingUser']) {
    f.session = { turn, rev: 7, queue: [] };
    await view.update();
    assert.equal(view.host.textContent, '');
  }
  f.session = { turn: 'idle', rev: 7, queue: [] };
  f.state.runtime.c1.turns[0].items = [];
  await view.update();
  assert.equal(view.host.textContent, '');
  f.state.runtime.c1 = runtime();
  await view.update();
  let resolve!: (answer: boolean) => void;
  f.send = () =>
    new Promise((yes) => {
      resolve = yes;
    });
  await act(async () => view.host.querySelector('button')!.click());
  await view.close();
  await act(async () => resolve(false));
  assert.equal(f.sends.length, 1);
  assert.deepEqual(f.drafts, [['c1', 'hello', []]]);
});

test('the failed transcript copy hides Retry while a queue or native writer-lock hold owns the message', async () => {
  reset();
  const view = await mount();
  f.session.queue = [{ id: 'kept' }];
  await view.update();
  assert.equal(view.host.textContent, '');
  f.session.queue = [];
  f.state.runtime.c1.held = { text: 'hello', attachments: [], opts: {} };
  await view.update();
  assert.equal(view.host.textContent, '');
  f.state.runtime.c1.held = null;
  await view.update();
  assert.equal(view.host.textContent, 'Retry');
  await view.close();
});

test('explicit Retry preserves audio-only and mixed messages, and restores the media when sending is refused', async () => {
  for (const text of ['', 'Listen to this recording'])
    for (const accepted of [true, false]) {
      reset();
      f.state.runtime.c1.turns[0].items = [
        user([...(text ? [{ type: 'text', text }] : []), { type: 'localAudio', path: '/audio/original.wav' }]),
      ];
      f.send = async () => accepted;
      assert.equal(await retryFailedTurn('c1', 't1'), accepted);
      const attachment = { kind: 'audio', path: '/audio/original.wav', name: 'original.wav' };
      assert.deepEqual(f.sends[0], ['c1', text, [attachment], { human: true, retryAtRevision: 7 }]);
      assert.deepEqual(f.drafts, accepted ? [] : [['c1', text, [attachment]]]);
    }
});

test('Retry of a machine chat read from its saved history fetches the pictures back from the machine and sends them again; one it cannot get stops the Retry and keeps the message', async () => {
  const REF = 'host-image:' + 'a'.repeat(64);
  const REF2 = 'host-image:' + 'b'.repeat(64);
  const turn = (content: any[]) => {
    reset();
    f.state.runtime.c1.turns[0].items = [user(content)];
    f.send = async () => true;
    f.picture = async (_chat: string, url: string) => ({ picture: `data:image/png;base64,${url.slice(11, 13)}` });
    f.save = async (dataUrl: string) => `/tmp/sage-codex-attachments/${dataUrl.slice(-2)}.png`;
  };
  // pictures of the saved message and a file the live bubble still draws from: each is sent, in order, as the composer sends them
  turn([
    { type: 'text', text: 'what is this' },
    { type: 'image', url: REF },
    { type: 'image', url: REF2 },
    { type: 'image', url: 'host-image:' + 'c'.repeat(64), path: '/tmp/live.png' },
    { type: 'image', url: 'https://x/y.png' },
    { type: 'image', url: 'data:image/png;base64,dd' },
  ]);
  assert.deepEqual(messageOf(f.state.runtime.c1.turns[0].items as any)!.pictures, [REF, REF2, 'data:image/png;base64,dd']);
  assert.equal(await retryFailedTurn('c1', 't1'), true);
  assert.deepEqual(f.sends[0].slice(1, 3), [
    'what is this',
    [
      { kind: 'image', path: '/tmp/live.png', name: 'live.png' },
      { kind: 'image', path: '/tmp/sage-codex-attachments/aa.png', name: 'aa.png' },
      { kind: 'image', path: '/tmp/sage-codex-attachments/bb.png', name: 'bb.png' },
      { kind: 'image', path: '/tmp/sage-codex-attachments/dd.png', name: 'dd.png' },
    ],
  ]);
  assert.deepEqual(f.drafts, []);
  // a picture only (no words) is still a message
  turn([{ type: 'image', url: REF }]);
  assert.equal(await retryFailedTurn('c1', 't1'), true);
  // the machine cannot give a picture back (away, gone, or the request fails): nothing is sent, the message goes back to the composer with what was had, and the person is told
  for (const answer of [{ offline: 'Studio' }, 'throws']) {
    turn([
      { type: 'text', text: 'again' },
      { type: 'image', url: REF },
    ]);
    f.picture = async () => {
      if (answer === 'throws') throw new Error('ipc');
      return answer;
    };
    assert.equal(await retryFailedTurn('c1', 't1'), false);
    assert.deepEqual(f.sends, []);
    assert.deepEqual(f.drafts, [['c1', 'again', []]]);
    assert.match(f.toasts.at(-1)[1], /picture is not available from its machine/);
  }
  // a file that cannot be saved is the same
  for (const saved of [null, 'throws']) {
    turn([{ type: 'image', url: REF }]);
    f.save = async () => {
      if (saved === 'throws') throw new Error('disk');
      return null;
    };
    assert.equal(await retryFailedTurn('c1', 't1'), false);
    assert.deepEqual(f.sends, []);
    assert.match(f.toasts.at(-1)[1], /could not be saved/);
  }
});
