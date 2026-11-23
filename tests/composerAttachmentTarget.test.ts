// Attachment target checks reread live ownership and record draft transitions even before React rerenders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h } from 'react';
import { mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
let state: any = { newChatHost: null, newChatCwd: '/a', newChatProjectId: null, threads: { c: { cwd: '/c' } } };
let location: any = { machine: null, pending: false };
let remote = false;
let hostId = 'box';
const hostListeners = new Set<() => void>();
const listeners = new Set<() => void>();
mockSource('src/store/core.ts', {
  get: () => state,
  useStore: Object.assign((s: any) => s(state), { subscribe: (f: () => void) => (listeners.add(f), () => listeners.delete(f)) }),
});
mockSource('src/store/projects.ts', { newChatHostPick: (s: any) => s.newChatHost, currentCwdForNewChat: () => state.newChatCwd });
mockSource('src/lib/chatMachine.ts', { useChatMachine: () => location });
mockSource('src/lib/hostChats.ts', {
  hostOfChatNow: () => (remote ? hostId : ''),
  subscribeHostChats: (f: () => void) => (hostListeners.add(f), () => hostListeners.delete(f)),
});
const { useAttachmentTarget } = await import('../src/session/useAttachmentTarget.ts');
let target: ReturnType<typeof useAttachmentTarget>;
function Probe({ id }: { id: string | null }) {
  target = useAttachmentTarget(id);
  return h('i');
}
const change = (p: any) => {
  state = { ...state, ...p };
  listeners.forEach((f) => f());
};
test('draft ownership and local folder transitions invalidate pending reads including local → remote → local', async () => {
  const m = await mount(h(Probe, { id: null }));
  try {
    const first = target.read();
    assert.equal(first.blocked, false);
    assert.equal(target.why, null);
    change({ newChatHost: { id: 'box', name: 'Box', path: '/there' } });
    assert.equal(target.read().blocked, true);
    await m.render(h(Probe, { id: null }));
    assert.match(target.why!, /Box/);
    change({ newChatHost: null });
    assert.notEqual(target.read().key, first.key, 'returning to the same local folder does not revive a prior admission');
    await m.render(h(Probe, { id: null }));
    assert.equal(target.why, null);
    change({ newChatCwd: '/b' });
    assert.notEqual(target.read().key, first.key);
  } finally {
    await m.unmount();
  }
});
test('started owner and unresolved admission are independent of new-chat picks', async () => {
  location = { machine: null, pending: true };
  const m = await mount(h(Probe, { id: 'c' }));
  try {
    assert.match(target.why!, /Checking/);
    location = { machine: { id: 'box', name: 'Box' }, pending: false };
    remote = true;
    await m.render(h(Probe, { id: 'c' }));
    assert.match(target.why!, /Box/);
    assert.equal(target.read().blocked, true);
    location = { machine: null, pending: false };
    remote = false;
    await m.render(h(Probe, { id: 'c' }));
    assert.equal(target.why, null);
    assert.equal(target.read().blocked, false);
  } finally {
    await m.unmount();
  }
});

test('moving the visible composer does not invalidate the still-local originating chat scope', async () => {
  location = { machine: null, pending: false };
  remote = false;
  const m = await mount(h(Probe, { id: null }));
  try {
    const originRead = target.read;
    const original = originRead();
    await m.render(h(Probe, { id: 'c' }));
    assert.equal(originRead().key, original.key, 'an old completion may retain input in its original local draft');
    assert.notEqual(target.read().key, original.key);
  } finally {
    await m.unmount();
  }
});

test('a remote owner change retires image reads even with identical chat and cwd, including A → B → A', async () => {
  remote = true;
  hostId = 'A';
  location = { machine: { id: 'A', name: 'A' }, pending: false };
  const m = await mount(h(Probe, { id: 'c' }));
  try {
    const first = target.read().key;
    hostId = 'B';
    hostListeners.forEach((f) => f());
    assert.notEqual(target.read().key, first);
    hostId = 'A';
    hostListeners.forEach((f) => f());
    assert.notEqual(target.read().key, first, 'returning to the first remote owner cannot revive a prior capture');
  } finally {
    await m.unmount();
  }
});

test('a preview in a hidden originating chat stays retired through an owner ABA while another composer is visible', async () => {
  remote = true;
  hostId = 'A';
  location = { machine: { id: 'A', name: 'A' }, pending: false };
  const m = await mount(h(Probe, { id: 'c' }));
  try {
    const originRead = target.read;
    const first = originRead().key;
    await m.render(h(Probe, { id: 'other' }));
    hostId = 'B';
    hostListeners.forEach((f) => f());
    hostId = 'A';
    hostListeners.forEach((f) => f());
    assert.notEqual(originRead().key, first, 'a different visible composer cannot hide originating owner transitions');
  } finally {
    await m.unmount();
  }
});
