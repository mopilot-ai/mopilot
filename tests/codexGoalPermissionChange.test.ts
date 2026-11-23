// A Codex chat's permission changed while its goal runs reaches the thread, so Codex's next continuation turn runs with it.
import { test, assert, setup, settle, thread } from './support/codex-adapter/fixture.ts';

const FULL = { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } };
const sentOf = (server: any) => server.sent.filter((m: any) => m.method === 'thread/settings/update').map((m: any) => m.params);
const toasts = (events: any[]) => events.filter((x) => x.e.kind === 'toast');

/** A chat whose thread `nid` is loaded here, with its goal `status`. */
function goalChat(handlers: Record<string, any> = {}, o: { status?: string | null; config?: any; prefs?: any } = {}) {
  const config: Record<string, any> = { chat1: o.config ?? { permission: 'full-access' } };
  const f = setup(handlers, { segments: { chat1: 'seg2' }, config, prefs: o.prefs });
  f.a.hold('seg2', thread('seg2'));
  if (o.status !== null) f.a.noteGoal('seg2', { status: o.status ?? 'active' });
  return { ...f, config };
}

test("permissionChanged: an active goal's loaded thread takes the chat's new permission, and computer use's anchor follows", async () => {
  const { a, server, state, events } = goalChat();
  assert.deepEqual(await a.permissionChanged('chat1'), ['chat1']);
  assert.deepEqual(sentOf(server), [{ threadId: 'seg2', ...FULL }]);
  assert.equal(state.get('chat1').permission, 'full-access');
  assert.deepEqual(toasts(events), []);
});

test("permissionChanged: the chat's extra folders join the thread's writable roots", async () => {
  const { a, server } = goalChat({}, { config: { permission: 'default', additionalDirectories: ['/extra'] } });
  await a.permissionChanged('chat1');
  assert.deepEqual(sentOf(server)[0].sandboxPolicy.writableRoots, ['/work', '/extra']);
});

test('permissionChanged: with no goal running, or a paused one, nothing is sent (the next turn carries its own permission)', async () => {
  for (const status of [null, 'paused', 'complete']) {
    const { a, server } = goalChat({}, { status });
    assert.deepEqual(await a.permissionChanged('chat1'), []);
    assert.deepEqual(sentOf(server), []);
  }
});

test("permissionChanged: a thread that isn't loaded is left alone: it is not resumed, and its next run applies the permission", async () => {
  const { a, server } = setup({}, { segments: { chat1: 'seg2' }, config: { chat1: { permission: 'full-access' } } });
  a.noteGoal('seg2', { status: 'active' });
  assert.deepEqual(await a.permissionChanged('chat1'), []);
  assert.deepEqual(server.methods(), []);
});

test("permissionChanged: a chat that isn't on Codex now is left alone", async () => {
  const { a, server } = goalChat();
  a.nativeOf = () => ({ kind: 'claude', id: 'k', key: 'k' });
  assert.deepEqual(await a.permissionChanged('chat1'), []);
  assert.deepEqual(sentOf(server), []);
});

test('permissionChanged: with no chat named (the default permission changed), every loaded thread with an active goal takes it', async () => {
  const f = setup({}, { segments: { chat1: 'seg2', chat2: 'seg3', chat3: 'seg4' }, prefs: { permission: 'full-access' } });
  for (const id of ['seg2', 'seg3', 'seg4']) f.a.hold(id, thread(id));
  f.a.noteGoal('seg2', { status: 'active' });
  f.a.noteGoal('seg4', { status: 'active' });
  // a thread that is no longer its chat's current one (the chat switched away) is not that chat's to set
  f.a.hold('old', thread('old'));
  f.a.noteGoal('old', { status: 'active' });
  const chatOf = f.a.chatOf;
  f.a.chatOf = (nid: string) => (nid === 'old' ? 'chat1' : chatOf(nid));
  assert.deepEqual((await f.a.permissionChanged()).sort(), ['chat1', 'chat3']);
  assert.deepEqual(
    sentOf(f.server)
      .map((p: any) => p.threadId)
      .sort(),
    ['seg2', 'seg4'],
  );
});

test("permissionChanged: a permission Codex refuses tells the user the goal keeps its old one, and isn't counted as applied", async () => {
  const { a, state, events } = goalChat({
    'thread/settings/update': () => {
      throw new Error('no such method');
    },
  });
  assert.deepEqual(await a.permissionChanged('chat1'), []);
  const [toast] = toasts(events);
  assert.equal(toast?.e.level, 'error');
  assert.match(toast?.e.text, /permission: no such method\. The running goal .* until you pause and resume it/);
  assert.equal(toast?.target, 'any');
  // the anchor stays on what the goal still runs with
  assert.equal(state.get('chat1')?.permission ?? null, null);
});

test('permissionChanged: an older change that fails after a newer one was sent says nothing; the newer one stands', async () => {
  let calls = 0;
  const { a, server, events, config } = goalChat({
    'thread/settings/update': () => {
      calls++;
      if (calls === 1) throw new Error('busy');
      return {};
    },
  });
  const first = a.permissionChanged('chat1');
  config.chat1 = { permission: 'default' };
  const second = a.permissionChanged('chat1');
  assert.deepEqual(await first, []);
  assert.deepEqual(await second, ['chat1']);
  assert.deepEqual(toasts(events), []);
  // sent in the order chosen, so Codex ends on the latest
  assert.deepEqual(
    sentOf(server).map((p: any) => p.approvalPolicy),
    ['never', 'on-request'],
  );
});

test('permissionChanged: a newer change that fails after an older one succeeded still tells the user', async () => {
  let calls = 0;
  const { a, events, config } = goalChat({
    'thread/settings/update': () => {
      calls++;
      if (calls === 2) throw new Error('refused');
      return {};
    },
  });
  const first = a.permissionChanged('chat1');
  config.chat1 = { permission: 'default' };
  const second = a.permissionChanged('chat1');
  assert.deepEqual(await first, ['chat1']);
  assert.deepEqual(await second, []);
  assert.match(toasts(events)[0]?.e.text, /refused/);
});

test('permissionChanged: an update still queued when the goal ends is not sent', async () => {
  const { a, server, config } = goalChat();
  const first = a.permissionChanged('chat1');
  config.chat1 = { permission: 'default' };
  const second = a.permissionChanged('chat1');
  a.noteGoal('seg2', { status: 'complete' });
  assert.deepEqual(await first, ['chat1']);
  assert.deepEqual(await second, []);
  assert.deepEqual(
    sentOf(server).map((p: any) => p.approvalPolicy),
    ['never'],
  );
});

test("main hears a saved change to a chat's permission, plan base or extra folders, and nothing else, for its Codex goal", async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createRequire } = await import('node:module');
  const { createAppState } = createRequire(import.meta.url)('../electron/app/appState.cjs');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-codex-goal-permission-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const calls: string[] = [];
  const live: any = {
    controller: { invalidate() {} },
    codex: {
      permissionChanged: async (id: string) => {
        calls.push(id);
        throw new Error('adapter failed');
      },
    },
  };
  const app = { getPath: () => folder, getVersion: () => '9.9.9' };
  const claude = { retireChat() {}, setChatNames() {} };
  const state = createAppState({ app, live, claude, isFlagEnabled: () => false });
  state.openChats();
  state.chats.patchMeta('c1', { config: { model: 'gpt', permission: 'default' } });
  state.chats.patchMeta('c1', { title: 'Renamed' });
  state.chats.patchMeta('c1', { config: { model: 'gpt-2', permission: 'default' } });
  state.chats.patchMeta('c1', { config: { model: 'gpt-2', permission: 'full-access' } });
  state.chats.patchMeta('c1', { config: { model: 'gpt-2', permission: 'plan', planBasePermission: 'full-access' } });
  state.chats.patchMeta('c1', {
    config: { model: 'gpt-2', permission: 'plan', planBasePermission: 'full-access', additionalDirectories: ['/x'] },
  });
  // an archived chat's goal is not set up again
  state.chats.patchMeta('c1', { archived: 1, config: null });
  // with no Codex adapter yet, nothing breaks
  delete live.codex;
  state.chats.patchMeta('c2', { config: { permission: 'full-access' } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['c1', 'c1', 'c1', 'c1']);
  // a chat loaded at launch starts from its saved settings: reopening hears no change
  live.codex = { permissionChanged: async (id: string) => void calls.push(id) };
  state.openChats();
  state.chats.patchMeta('c2', { title: 'x' });
  assert.equal(calls.length, 4);
});

test("permissionChanged: a voice session's thread (its pinned lease) takes it with no goal, since its delegated turns run on it", async () => {
  const { a, server, state } = goalChat({}, { status: null });
  a.pin('seg2', true);
  assert.deepEqual(await a.permissionChanged('chat1'), ['chat1']);
  assert.deepEqual(sentOf(server), [{ threadId: 'seg2', ...FULL }]);
  assert.equal(state.get('chat1').permission, 'full-access');
  a.pin('seg2', false);
  assert.deepEqual(await a.permissionChanged('chat1'), []);
  assert.equal(sentOf(server).length, 1);
});

test('permissionChanged: a voice session whose permission Codex refuses tells the user it keeps the earlier one', async () => {
  const { a, events } = goalChat(
    {
      'thread/settings/update': () => {
        throw new Error('refused');
      },
    },
    { status: null },
  );
  a.pin('seg2', true);
  assert.deepEqual(await a.permissionChanged('chat1'), []);
  assert.match(toasts(events)[0]?.e.text, /refused\. The voice session keeps its earlier one until you start it again\./);
});

test('startGoal: a permission picked while Codex was asked to start the goal reaches it once the goal is active', async () => {
  const config: Record<string, any> = { chat1: { permission: 'default' } };
  const f = setup(
    {
      'thread/goal/set': (p: any) => {
        // the user picks Full access after the goal's permission went on, before Codex answers
        config.chat1 = { permission: 'full-access' };
        return { goal: { threadId: p.threadId, objective: 'ship', status: p.status } };
      },
    },
    { segments: { chat1: 'seg2' }, config },
  );
  assert.deepEqual(await f.a.startGoal('chat1', { kind: 'codex', id: 'seg2' }, { text: '', attachments: [], opts: { goal: 'ship' } }), {
    started: true,
  });
  await settle();
  assert.deepEqual(
    sentOf(f.server).map((p: any) => p.approvalPolicy),
    ['on-request', 'never'],
  );
});

test('leased: a goal resumed while the permission changed catches up; one with no change, or paused, sends nothing more', async () => {
  const config: Record<string, any> = { chat1: { permission: 'default' } };
  let change: any = null;
  const f = setup(
    {
      'thread/goal/set': (p: any) => {
        if (change) config.chat1 = change;
        return { goal: { threadId: p.threadId, objective: 'ship', status: p.status } };
      },
    },
    { segments: { chat1: 'seg2' }, config },
  );
  await f.a.leased('chat1', 'thread/goal/set', { status: 'active' });
  await settle();
  assert.equal(sentOf(f.server).length, 1);
  change = { permission: 'read-only' };
  await f.a.leased('chat1', 'thread/goal/set', { status: 'paused' });
  await settle();
  // a pause applies nothing and starts nothing: the change waits for the next run
  assert.equal(sentOf(f.server).length, 1);
  change = { permission: 'full-access' };
  await f.a.leased('chat1', 'thread/goal/set', { status: 'active' });
  await settle();
  assert.deepEqual(
    sentOf(f.server).map((p: any) => p.approvalPolicy),
    ['on-request', 'on-request', 'never'],
  );
});

test('a thread let go forgets what was applied to it: a goal set after it loads again applies afresh, with no catch-up', async () => {
  const { a, server, config } = goalChat({ 'thread/goal/set': (p: any) => ({ goal: { threadId: p.threadId, status: p.status } }) });
  await a.permissionChanged('chat1');
  a.drop('seg2', 'released');
  config.chat1 = { permission: 'default' };
  await a.leased('chat1', 'thread/goal/set', { status: 'active' });
  await settle();
  assert.deepEqual(
    sentOf(server).map((p: any) => p.approvalPolicy),
    ['never', 'on-request'],
  );
});

test("permissionChanged: a refusal that already ends in a period isn't doubled", async () => {
  const { a, events } = goalChat({
    'thread/settings/update': () => {
      throw new Error('Invalid sandbox.');
    },
  });
  await a.permissionChanged('chat1');
  assert.match(toasts(events)[0]?.e.text, /Invalid sandbox\. The running goal/);
});

test('permissionCaughtUp: with no prefs read yet, the chat is held to what it saved', async () => {
  const { a, server, config } = goalChat();
  await a.permissionChanged('chat1');
  a.prefs = () => null;
  config.chat1 = { permission: 'read-only' };
  a.permissionCaughtUp('chat1', 'seg2');
  await settle();
  assert.deepEqual(
    sentOf(server).map((p: any) => p.sandboxPolicy.type),
    ['dangerFullAccess', 'readOnly'],
  );
});
