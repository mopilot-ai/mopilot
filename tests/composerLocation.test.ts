// Composer location covers draft picks, local overrides, unresolved ownership and removed/offline machines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h } from 'react';
import { mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
let state: any = { newChatHost: { id: 'box', name: 'Box' }, newChatProjectId: null, newChatCwd: null };
let location: any = { machine: null, pending: false };
mockSource('src/store/core.ts', { useStore: (f: any) => f(state) });
mockSource('src/store/projects.ts', { newChatHostPick: (s: any) => (s.newChatProjectId || s.newChatCwd ? null : s.newChatHost) });
mockSource('src/lib/chatMachine.ts', { useChatMachine: () => location });
const { useComposerLocation } = await import('../src/session/useComposerLocation.ts');
function Probe({ id }: { id: string | null }) {
  return h('i', { 'data-location': JSON.stringify(useComposerLocation(id)) });
}
test('draft machine is independent of chat owner; started chat always uses resolved owner or pending', async () => {
  const m = await mount(h(Probe, { id: null }));
  const value = () => JSON.parse(m.host.querySelector('i')!.getAttribute('data-location')!);
  try {
    assert.deepEqual(value(), { machine: 'Box', machineId: 'box', pending: false });
    state.newChatCwd = '/local';
    await m.render(h(Probe, { id: null }));
    assert.deepEqual(value(), { machine: null, pending: false });
    location = { machine: { name: 'Offline box' }, pending: false };
    await m.render(h(Probe, { id: 'c' }));
    assert.deepEqual(value(), { machine: 'Offline box', pending: false });
    location = { machine: null, pending: true };
    await m.render(h(Probe, { id: 'c' }));
    assert.deepEqual(value(), { machine: null, pending: true });
    location = { machine: null, pending: false };
    await m.render(h(Probe, { id: 'c' }));
    assert.deepEqual(value(), { machine: null, pending: false });
  } finally {
    await m.unmount();
  }
});

test('a machine that has an id is named by it, for a started chat and for a draft; one with none is named only', async () => {
  const m = await mount(h(Probe, { id: 'c' }));
  const value = () => JSON.parse(m.host.querySelector('i')!.getAttribute('data-location')!);
  try {
    location = { machine: { id: 'box', name: 'Box' }, pending: false };
    await m.render(h(Probe, { id: 'c' }));
    assert.deepEqual(value(), { machine: 'Box', machineId: 'box', pending: false });
    state = { newChatHost: { name: 'Unlisted' }, newChatProjectId: null, newChatCwd: null };
    await m.render(h(Probe, { id: null }));
    assert.deepEqual(value(), { machine: 'Unlisted', pending: false });
  } finally {
    await m.unmount();
  }
});
