// src/store/actions.ts openSideChat: a Claude Code chat's side chat is opened by Claude Code itself, reached through the
// harness runtime main installs (src/store/runtime.ts), not an import of the harness module.
import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, flush, bootImpls } from './support/store-harness.ts';
import { deferred } from './support/async-scenarios.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, sessions } = await loadStore();
const { noteOwner } = await import('../src/harness/ownership.ts');
noteOwner('cl', 'claude');

before(async () => {
  bootImpls();
  await store.boot();
  await flush();
});

test("a Claude Code chat's side chat is opened by Claude Code, with the chat, its session and the selection", async () => {
  impl['claude.openClaudeSideChat'] = () => 'claude:side';
  store.useStore.setState({ route: { name: 'thread', id: 'cl' } });
  assert.equal(await store.openSideChat('cl', 'picked'), 'claude:side');
  assert.deepEqual(callsOf('claude.openClaudeSideChat'), [['cl', 'cl', 'picked', undefined]]);
});

test('a remote Codex chat opens a temporary pane with the selection on the child composer', async () => {
  const parent = 'acp:host-codex:main';
  const child = 'acp:host-codex:side-chat-00000000-0000-4000-8000-000000000001';
  const config = { hostSelection: { hostId: 'box', harness: 'codex', model: 'm' } };
  const { acpThread } = await import('../src/harness/acpSessions.ts');
  impl['host.openSideChat'] = () => ({ chatId: child, hostId: 'box', cwd: '/srv/project', config });
  const thread = { ...acpThread({ id: parent, cwd: '/srv/project', createdAt: 0, updatedAt: 0 }), projectId: 'project' };
  store.useStore.setState((s: any) => ({ threads: { ...s.threads, [parent]: thread }, route: { name: 'thread', id: parent } }));
  assert.equal(await store.openSideChat(parent, 'quoted return value'), child);
  const s = store.useStore.getState();
  assert.equal(s.threads[child].ephemeral, true);
  assert.equal(s.threads[child].cwd, '/srv/project');
  assert.equal(s.threads[child].projectId, 'project');
  assert.equal(s.threadOrder.includes(child), false);
  assert.equal(s.paneTabs.find((t) => t.threadId === child)?.sourceChatId, parent);
  assert.equal(s.drafts[child].attachments[0].text, 'quoted return value');
  assert.deepEqual(s.chatConfig[child], config);
  assert.equal(callsOf('host.openSideChat').at(-1)?.[0], parent);
  assert.deepEqual(callsOf('codex.fork'), []);
});

test('a pending remote side chat does not replace a tab the user navigated away from', async () => {
  const parent = 'acp:kimi:parent';
  const child = 'acp:kimi:side-chat-00000000-0000-4000-8000-000000000002';
  const reply = deferred<{ chatId: string; hostId: string; cwd: string }>();
  impl['host.openSideChat'] = () => reply.promise;
  store.useStore.setState({ route: { name: 'thread', id: parent }, paneTabs: [{ id: 'blank', kind: 'browser' }] });
  const first = store.openSideChat(parent, 'quote', 'blank');
  const repeated = store.openSideChat(parent, 'quote', 'blank');
  assert.equal(callsOf('host.openSideChat').filter(([id]) => id === parent).length, 1);
  store.useStore.setState({ paneTabs: [{ id: 'blank', kind: 'browser', url: 'https://example.test' }] });
  reply.resolve({ chatId: child, hostId: 'box', cwd: '/srv/project' });
  assert.deepEqual(await Promise.all([first, repeated]), [undefined, undefined]);
  assert.equal(store.useStore.getState().threads[child], undefined);
  assert.equal(store.useStore.getState().paneTabs[0].kind, 'browser');
  assert.deepEqual(callsOf('chats.delete').at(-1), [child]);
});

test('a still-blank window tab converts and parks with the source chat when focus moves', async () => {
  const parent = 'acp:kimi:parked';
  const child = 'acp:kimi:side-chat-00000000-0000-4000-8000-000000000003';
  const reply = deferred<{ chatId: string; hostId: string; cwd: string; config: object }>();
  impl['host.openSideChat'] = () => reply.promise;
  store.useStore.setState({ route: { name: 'thread', id: parent }, paneTabs: [{ id: 'blank2', kind: 'browser' }] });
  const request = store.openSideChat(parent, undefined, 'blank2');
  store.useStore.setState({ route: { name: 'thread', id: 'other' } });
  reply.resolve({ chatId: child, hostId: 'box', cwd: '/srv/project', config: {} });
  assert.equal(await request, child);
  const s = store.useStore.getState();
  assert.equal(
    s.paneTabs.some((t) => t.threadId === child),
    false,
  );
  assert.equal(s.chatPanes[parent]?.tabs.find((t) => t.id === 'blank2')?.threadId, child);
});

test('a child allocated for a parent deleted during the owner lookup is retired without mounting', async () => {
  const { deletionVisibility } = await import('../src/store/deletionVisibility.ts');
  const chatId = 'acp:kimi:deleted-during-open';
  const child = 'acp:kimi:side-chat-00000000-0000-4000-8000-000000000004';
  const owner = deferred<{ chatId: string; hostId: string; cwd: string; config: object }>();
  impl['host.openSideChat'] = () => owner.promise;
  const opening = store.openSideChat(chatId, 'selection');
  deletionVisibility.accept({ chatId, nativeKeys: [chatId], nativeDeleted: true, metadata: 'retained' });
  owner.resolve({ chatId: child, hostId: 'box', cwd: '/srv/project', config: {} });
  assert.equal(await opening, undefined);
  assert.equal(store.useStore.getState().threads[child], undefined);
  assert.deepEqual(callsOf('chats.delete').at(-1), [child]);
});

test('the parent opens a fresh child after refusing the first send and preserves the old queued draft', async () => {
  const parent = 'acp:kimi:parent-moved';
  const old = 'acp:kimi:side-chat-00000000-0000-4000-8000-000000000005';
  const next = 'acp:kimi:side-chat-00000000-0000-4000-8000-000000000006';
  let child = old;
  impl['host.openSideChat'] = () => ({ chatId: child, hostId: 'box', cwd: '/srv/project', config: {} });
  store.useStore.setState({ route: { name: 'thread', id: parent } });
  assert.equal(await store.openSideChat(parent, 'first quote'), old);
  const queued = [{ id: 'old-draft', text: 'keep me', refusal: { code: 'side_chat_parent_changed', retry: false } }] as any;
  sessions.useSessions.setState((s) => ({ sessions: { ...s.sessions, [old]: { ...s.sessions[old], queue: queued } } }));

  child = next;
  assert.equal(await store.openSideChat(parent, 'new quote'), next);
  assert.equal(sessions.sessionOf(old).queue[0].text, 'keep me');
  assert.equal(store.useStore.getState().drafts[next].attachments[0].text, 'new quote');
});

test('recovering a pending side-chat draft opens a separate pane even when another side chat is available', async () => {
  const parent = 'acp:kimi:parent-with-pending-send';
  const pending = `acp:kimi:side-chat-${crypto.randomUUID()}`;
  const existing = `acp:kimi:side-chat-${crypto.randomUUID()}`;
  const fresh = `acp:kimi:side-chat-${crypto.randomUUID()}`;
  const reply = deferred<{ chatId: string; hostId: string; cwd: string; config: object }>();
  store.useStore.setState({
    route: { name: 'thread', id: parent },
    paneActive: 'pending',
    paneTabs: [
      { id: 'existing', kind: 'chat', threadId: existing, sourceChatId: parent },
      { id: 'pending', kind: 'chat', threadId: pending, sourceChatId: parent },
    ],
  });
  impl['host.openSideChat'] = () => reply.promise;
  const options = { recoveryFrom: pending };
  const recovering = store.openSideChat(parent, undefined, undefined, options);
  const repeated = store.openSideChat(parent, undefined, undefined, options);
  assert.equal(callsOf('host.openSideChat').filter(([id]) => id === parent).length, 1);
  reply.resolve({ chatId: fresh, hostId: 'box', cwd: '/srv/project', config: {} });
  assert.deepEqual(await Promise.all([recovering, repeated]), [fresh, fresh]);
  assert.deepEqual(
    store.useStore.getState().paneTabs.map((tab) => tab.threadId),
    [existing, pending, fresh],
  );
});

for (const code of ['side_chat_parent_changed', 'request_interrupted']) {
  test(`a side chat with terminal start refusal ${code} stays outside automatic reuse`, async () => {
    const parent = `acp:kimi:parent-of-${code}`;
    const first = `acp:kimi:side-chat-${crypto.randomUUID()}`;
    const next = `acp:kimi:side-chat-${crypto.randomUUID()}`;
    let child = first;
    impl['host.openSideChat'] = () => ({ chatId: child, hostId: 'box', cwd: '/srv/project', config: {} });
    impl['session.removeQueued'] = () => true;
    store.useStore.setState({ route: { name: 'thread', id: parent } });
    assert.equal(await store.openSideChat(parent), first);
    const queue = [{ id: 'old', text: 'draft', refusal: { code, retry: false } }] as any;
    sessions.useSessions.setState((s) => ({ sessions: { ...s.sessions, [first]: { ...s.sessions[first], queue } } }));
    if (code === 'side_chat_parent_changed') {
      await store.removeQueued(first, 'old');
      sessions.useSessions.setState((s) => ({ sessions: { ...s.sessions, [first]: { ...s.sessions[first], queue: [] } } }));
    }
    child = next;
    assert.equal(await store.openSideChat(parent), next);
  });
}
