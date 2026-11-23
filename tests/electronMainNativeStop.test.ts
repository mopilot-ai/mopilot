// electron/main.cjs and electron/app/agentTools.cjs: Codex Computer Use under MoPilot's desktop lock, over a fake
// Electron and fake collaborators (tests/support/electron-main-harness.ts): which threads are native, the chat a thread
// asks in, a native program stopped for a desktop another chat holds or a no-go app (the chat's line, the system
// notification, the interrupt and what the model is told, #1724), and Esc or Stop on a sub-agent thread.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain, unloadMain, flush } from './support/electron-main-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
after(() => unloadMain());
const calls = (f: any) => f.mock.calls.map((c: any) => c.arguments);

test('ready: a native Computer Use program stopped by MoPilot says why in the chat, tells its model, and Esc reaches sub-agents', async () => {
  const h = await loadMain();
  await h.ready();
  const cu = h.inst.computerUse[0];
  const notifier = h.mod('platform/notify.cjs').registerNotify.mock.calls[0].result;
  const codex = h.one('CodexAdapter');
  const ctl = h.one('ChatController');
  // Codex Computer Use under MoPilot's desktop lock: which threads are native, the chat a thread asks in,
  // and a native program that finds another chat holding the desktop stops its own turn and says why
  const inj = h.one('CodexToolInjection');
  inj.isNativeThread = mock.fn((id: string) => id === 'nat');
  assert.equal(cu.opts.nativeThread('nat'), true);
  assert.equal(cu.opts.nativeThread('other'), false);
  ctl.requestChat = mock.fn((id: string) => `chat-${id}`);
  assert.equal(cu.opts.requestChat('sub'), 'chat-sub');
  // the interrupt fails (the turn already ended) and the model is told anyway; a failing inject is only noted
  codex.request = mock.fn(async (method: string) => {
    throw new Error(method === 'turn/interrupt' ? 'the turn already ended' : 'no such thread');
  });
  codex.chatName = (id: string) => (id === 'c1' ? 'Holder' : '');
  cu.opts.onNativeBusy('nat', 't1', 'c9', 'c1');
  cu.opts.onNativeBusy('nat', 't2', 'c9', 'c2');
  // null: another app or MoPilot profile holds the helper's lock
  cu.opts.onNativeBusy('nat', 't3', 'c9', null);
  // an app on MoPilot's no-go list (#1319): the chat's line names it, and the reason is what the model reads
  const keychain = { reason: 'blocked', app: 'Keychain Access', name: 'Keychain Access' };
  cu.opts.onNativeBusy('nat', 't4', 'c9', null, 'Keychain Access is blocked in Settings → Computer use', keychain);
  await flush();
  const sent = calls(codex.request);
  assert.deepEqual(
    sent.map((c: any[]) => [c[0], c[1].threadId, c[1].turnId]),
    [
      ...['t1', 't2', 't3', 't4'].map((t) => ['turn/interrupt', 'nat', t]),
      ...[1, 2, 3, 4].map(() => ['thread/inject_items', 'nat', undefined]),
    ],
  );
  // a developer message in the thread's model-visible history (Responses API items)
  assert.deepEqual(Object.keys(sent[4][1].items[0]), ['type', 'role', 'content']);
  assert.equal(sent[4][1].items[0].role, 'developer');
  const told = calls(codex.request)
    .filter(([m]: any[]) => m === 'thread/inject_items')
    .map(([, p]: any[]) => p.items[0].content[0].text);
  assert.match(told[0], /because "Holder" was controlling this Mac\. Do not retry computer use until the user asks\./);
  assert.match(told[3], /because the user blocked Keychain Access in Settings → Computer use\. Do not try Keychain Access again/);
  // one line in each chat's transcript (shared with every harness), and the system notification for a user elsewhere
  const refusals = cu.refusals;
  assert.deepEqual(calls(refusals.note), [
    ['c9', { reason: 'busy', holder: 'Holder', chat: true }],
    ['c9', { reason: 'busy', holder: null, chat: true }],
    ['c9', { reason: 'busy', holder: null, chat: false }],
    ['c9', keychain],
  ]);
  assert.deepEqual(calls(notifier.notify).slice(-4), [
    ['computer', 'c9', { title: 'Computer use stopped', body: 'Computer use stopped: "Holder" is using this Mac.' }],
    ['computer', 'c9', { title: 'Computer use stopped', body: 'Computer use stopped: another chat is using this Mac.' }],
    ['computer', 'c9', { title: 'Computer use stopped', body: 'Computer use stopped: another app is using this Mac.' }],
    ['computer', 'c9', { title: 'Computer use stopped', body: 'Keychain Access is blocked in Settings → Computer use.' }],
  ]);
  // Esc or Stop: a sub-agent thread (no chat of its own) is interrupted here; the chat's own thread is Stop's
  inj.parents = { parentOf: (id: string) => (id === 'sub' ? 'root' : null) };
  assert.equal(cu.opts.subagentThread('sub'), true);
  assert.equal(cu.opts.subagentThread('root'), false);
  cu.opts.onNativeStop('root', 'r1');
  cu.opts.onNativeStop('sub', 's1');
  await flush();
  assert.deepEqual(calls(codex.request).at(-1), ['turn/interrupt', { threadId: 'sub', turnId: 's1' }]);
  assert.equal(codex.request.mock.callCount(), 9);
});
