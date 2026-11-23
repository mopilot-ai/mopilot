// Session IPC forwards awaited sends through the production controller while Quick Chat retains request identity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { hostOver } from './support/host/localHost.ts';
import { setup, tick, selectSegment } from './support/controller/fixture.ts';
import { reverseGraph } from '../scripts/related-tests.mjs';
const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/sessions.cjs');
const { QuickChatRequests } = require('../electron/session/quickChat.cjs');

function ipc(quick = false, observed = true) {
  const c = setup({ auto: false });
  const handlers = new Map();
  const sender = { id: 7, isDestroyed: () => false };
  const live = {
    controller: c.c,
    host: hostOver(c.c),
    chats: c.chats,
    sessions: c.state,
    mini: quick ? { isDestroyed: () => false, webContents: sender } : null,
    quickState: { owns: () => true },
    peerRuntime: { registerIpc() {}, userTurn: (_id: string, item: any) => item },
  };
  register(
    { handle: (name: string, fn: any) => handlers.set(name, fn), on() {} },
    {
      live,
      execWindows: new Set(observed ? [sender] : []),
      peerWindowChats: new Map(),
      viewedBy: new Map([[7, { visible: ['chat'], focused: 'chat' }]]),
      quickRequests: new QuickChatRequests(),
      readyMainWindow: async () => {},
    },
  );
  assert.equal(typeof c.c.chromeContinuationCheck, 'function', 'real registration installs the handoff-only dispatch guard');
  return {
    ...c,
    live,
    patch: (partial: any) => handlers.get('session:patch')({ sender }, 'chat', partial),
    send: (item: any) => handlers.get('session:send')({ sender }, 'chat', item),
    call: (name: string, chatId: string, ...args: any[]) => handlers.get(name)({ sender }, chatId, ...args),
  };
}

test('normal session IPC waits for failure and returns the sole queued input', async () => {
  const { send, execs, s } = ipc();
  const pending = send({ id: 'input', text: 'hello', peer: { forged: true }, sideSession: { id: 'forged' } });
  execs[0].done({ started: false, error: 'cannot open' });
  assert.deepEqual(await pending, { action: 'queued', id: 'input', error: 'cannot open' });
  assert.equal(s('chat').queue.length, 1);
  assert.equal(s('chat').queue[0].peer, undefined);
  assert.equal(s('chat').queue[0].sideSession, undefined);
});

test('pending model IPC merges the model into main state without replacing current account or mode', async () => {
  const t = ipc();
  t.state.patch('chat', { pendingSwitch: { harness: 'codex', model: 'old', modelLabel: 'Old', account: 'current', mode: 'workspace' } });
  assert.equal(await t.call('session:pendingModel', 'chat', 'codex', 'chosen'), true);
  assert.deepEqual(t.state.get('chat').pendingSwitch, {
    harness: 'codex',
    model: 'chosen',
    modelLabel: 'Chosen',
    account: 'current',
    mode: 'workspace',
    effort: null,
  });
});

test('a chat on a remote machine goes to the remote service; anything it does not own goes to the controller', async () => {
  const { send, call, live: wired, execs, s } = ipc();
  const live = wired as any;
  const shown: boolean[] = [];
  const remote: any = {
    send: async (chatId: string, item: any, _origin: number, drawn: boolean) =>
      chatId === 'chat' && item.text === 'far' ? (shown.push(drawn), { action: 'queued', id: 'k' }) : null,
    remove: (_c: string, qid: string) => (qid === 'mine' ? true : qid === 'sent' ? false : null),
    sendNow: async (_c: string, qid: string) => (qid === 'mine' ? { status: 'queued', waitingFor: 'host' } : null),
  };
  live.remoteSend = () => remote;
  assert.deepEqual(await send({ id: 'k', text: 'far' }), { action: 'queued', id: 'k' });
  assert.equal(execs.length, 0, 'nothing reached the local harness');
  // a send that carries an id is one the window draws at once; one without is not
  assert.deepEqual(await send({ text: 'far' }), { action: 'queued', id: 'k' });
  assert.deepEqual(await send({ id: '', text: 'far' }), { action: 'queued', id: 'k' });
  assert.deepEqual(shown, [true, false, false]);
  assert.equal(await call('session:removeQueued', 'chat', 'mine'), true);
  assert.equal(await call('session:removeQueued', 'chat', 'sent'), false, 'a message the machine has stays');
  assert.equal(await call('session:removeQueued', 'chat', 'local'), false, 'not ours and not in the controller queue');
  assert.deepEqual(await call('session:sendNow', 'chat', 'mine'), { status: 'queued', waitingFor: 'host' });
  assert.deepEqual(await call('session:sendNow', 'chat', 'gone'), { status: 'missing' });
  // Host off: the service is null and every call is the controller's
  live.remoteSend = () => null;
  assert.deepEqual(await call('session:sendNow', 'chat', 'gone'), { status: 'missing' });
  assert.equal(await call('session:removeQueued', 'chat', 'gone'), false);
  assert.equal(s('chat').queue.length, 0);
});

test('a Quick Chat send, which always carries an id and never draws an early copy, goes to its own dispatch and never to the remote service whose queue it could hide from', async () => {
  const { send, execs, live } = ipc(true);
  (live as any).remoteSend = () => ({
    send: async () => assert.fail('the Mini’s message must not be kept as one the window already draws'),
  });
  const pending = send({ id: 'mini-1', text: 'hello' });
  await tick();
  assert.equal(execs.length, 1);
  execs[0].done({ started: true });
  assert.equal((await pending).action, 'started');
});

test('Quick Chat repeats a pending/failed receipt without launching or retaining a second input', async () => {
  const { send, execs, s } = ipc(true);
  const item = { id: 'request', text: 'hello' };
  const first = send(item);
  const second = send(item);
  await tick();
  assert.equal(execs.length, 1);
  execs[0].done({ started: false, error: 'list_turns is not supported yet' });
  assert.deepEqual(await first, await second);
  assert.deepEqual(await send(item), await first);
  assert.equal(execs.length, 1);
  assert.equal(s('chat').queue.length, 1);
});

test('unobserved renderer input receives the same actual receipt without peer tagging', async () => {
  const { send, execs } = ipc(false, false);
  const pending = send({ id: 'input', text: 'hello' });
  execs[0].done({ started: true, turnId: 'native-turn' });
  assert.deepEqual(await pending, { action: 'started', id: 'input' });
});

// Registration can add an eager dependency even when a fixture exercises a different handler. Every direct
// consumer belongs to this contract inventory; do not dismiss it as a transitive shared-module selection.
test('real session registration keeps every direct fixture consumer in the contract inventory', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const consumers = [...(reverseGraph(root).get('electron/app/ipc/sessions.cjs') ?? [])].sort();
  // harnessNamedCopy only reads the source text of electron/app/ipc for its copy scan; it registers nothing. Three name
  // the electron/app folder that holds the IPC handlers (module resolution, boundary fixtures) and load none of them.
  assert.deepEqual(consumers, [
    'tests/acpFormWiring.test.ts',
    'tests/automationUpdateIpc.test.ts',
    'tests/automationsMomoTasks.test.ts',
    'tests/controlMatrixChromeGroups.test.ts',
    'tests/harnessNamedCopy.test.ts',
    'tests/moduleBoundaries.test.ts',
    'tests/planAcceptanceIpc.test.ts',
    'tests/sendReceiptIpc.test.ts',
  ]);
});

test('leaving an inherited plan through IPC durably restores only this chat permission before its next send', () => {
  const { chats, state, patch } = ipc();
  chats.ensure('chat');
  chats.patchMeta('chat', { config: { permission: 'plan', planBasePermission: 'read-only', additionalDirectories: ['/notes'] } });
  state.patch('chat', { plan: true });
  patch({ plan: false });
  assert.equal(state.get('chat').plan, false);
  assert.deepEqual(chats.records.get('chat').meta.config, {
    permission: 'read-only',
    planBasePermission: 'read-only',
    additionalDirectories: ['/notes'],
  });
  chats.patchMeta('chat', { config: { permission: 'plan' } });
  state.patch('chat', { plan: true });
  chats.patchMeta = () => false;
  assert.throws(() => patch({ plan: false }), /could not save/);
  assert.equal(state.get('chat').plan, true, 'failed persistence does not claim the requested mode was changed');
});

for (const quick of [false, true]) {
  test(`a stale Retry leaves peer pause and input grants untouched (Quick Chat=${quick})`, async () => {
    const f = ipc(quick);
    let paused = true;
    const inputs: any[] = [];
    f.live.peerRuntime.userTurn = (_chat: string, item: any) => {
      paused = false;
      inputs.push(item);
      return item;
    };
    const retry = (retryAtRevision: number) =>
      f.send({
        id: `retry-${retryAtRevision}`,
        text: 'retry original',
        opts: { human: true },
        retryAtRevision,
      });
    await assert.rejects(retry(42), /chat changed/i);
    assert.equal(paused, true);
    assert.deepEqual(inputs, []);
    assert.equal(f.execs.length, 0);
    const pending = retry(f.s('chat').rev);
    await tick();
    assert.equal(f.execs.length, 1);
    f.execs[0].done({ started: true });
    assert.equal((await pending).action, 'started');
    assert.equal(paused, false);
    assert.equal(inputs.length, 1);
  });
}

for (const quick of [false, true]) {
  test(`realtime reservation rejects a conditional Retry before peer or durable input side effects (Quick Chat=${quick})`, async () => {
    const { startVoice, observeVoice } = require('../electron/session/voice.cjs');
    const f = ipc(quick);
    selectSegment(f.c, f.chats, 'chat', [['codex', 'native']]);
    f.c.codex.pin = () => undefined;
    f.c.codex.request = async () => ({});
    const revision = f.s('chat').rev;
    await startVoice(
      { controller: f.c, codex: f.c.codex, caps: { get: async () => ({ kind: 'codex', caps: { voiceChat: { state: 'native' } } }) } },
      { threadId: 'native' },
    );
    let tagged = 0,
      admitted = 0;
    f.live.peerRuntime.userTurn = (_id, item) => (tagged++, item);
    f.c.audioPending = { admit: () => admitted++ };
    const item = { id: 'retry-voice', text: 'Retry', retryAtRevision: revision, attachments: [{ kind: 'audio', path: '/keep.wav' }] };
    try {
      await assert.rejects(f.send(item), /chat changed/i);
      assert.throws(() => f.c.send('chat', item, 1), /chat changed/i);
      assert.equal(tagged, 0);
      assert.equal(admitted, 0);
      assert.equal(f.s('chat').queue.length, 0);
      assert.equal(f.execs.length, 0);
    } finally {
      observeVoice(f.c.codex, { kind: 'stopped' });
    }
  });
}
