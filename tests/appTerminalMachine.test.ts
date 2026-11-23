// The machine the bottom terminal opens on (src/session/useTerminalMachine.ts, #5072): the focused chat's, else the new-chat draft's pick, else this Mac.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';

let state: any = {};
mockSource('src/store/core.ts', { useStore: (sel: any) => sel(state) });
mockSource('src/store/projects.ts', { newChatHostPick: (s: any) => s.newChatHost ?? null });
const { createElement: h } = await import('react');
const { useTerminalMachine } = await import('../src/session/useTerminalMachine.ts');

let seen: unknown;
function Probe(p: { focusedId: string | null; machine: { id: string; name: string } | null; folder?: string }) {
  seen = useTerminalMachine(p.focusedId, p.machine, p.folder);
  return null;
}
async function read(props: Parameters<typeof Probe>[0]) {
  const m = await mount(h(Probe, props));
  await m.unmount();
  return seen;
}
const DRAFT = { id: 'ssh:me@far', name: 'far', path: '/srv/draft' };

test('no chat open: the machine the draft picked, with its folder', async () => {
  state = { newChatHost: DRAFT };
  assert.deepEqual(await read({ focusedId: null, machine: null }), { id: 'ssh:me@far', name: 'far', folder: '/srv/draft' });
});

test('a chat in front wins over the draft: its machine and folder, or this Mac', async () => {
  state = { newChatHost: DRAFT };
  assert.deepEqual(await read({ focusedId: 'a', machine: { id: 'ssh:me@box', name: 'box' }, folder: '/srv/app' }), {
    id: 'ssh:me@box',
    name: 'box',
    folder: '/srv/app',
  });
  assert.equal(await read({ focusedId: 'a', machine: null, folder: '/repo' }), null);
});

test('no chat and no machine picked: this Mac', async () => {
  state = { newChatHost: null };
  assert.equal(await read({ focusedId: null, machine: null }), null);
});
