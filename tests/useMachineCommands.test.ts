// useMachineCommands (#4915): which machine, agent and folder the / menu asks about, for a chat that exists and for the new chat a machine is picked for; none for a chat on this Mac or one with no agent there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';

let state: any = {};
let machine: any = null;
let draft: any = null;
const basics: Record<string, string> = {};
const asked: unknown[][] = [];
mockSource('src/store/core.ts', { useStore: (sel: (s: unknown) => unknown) => sel(state) });
mockSource('src/store/chats.ts', { chatBasicHarness: (id: string) => basics[id] ?? null });
mockSource('src/store/machineChatSwitch.ts', { agentOfKind: (k: unknown) => (k ? String(k).replace(/^acp:/, '') : null) });
mockSource('src/lib/chatMachine.ts', { useChatMachine: () => ({ machine, pending: false }) });
mockSource('src/session/useHostAgentChoice.ts', { useHostAgentChoice: () => draft });
mockSource('src/lib/hostCommands.ts', {
  useHostCommands: (...a: unknown[]) => (asked.push(a), { state: 'loading' }),
});
const { createElement } = await import('react');
const { useMachineCommands, wireHarnessOf } = await import('../src/session/useMachineCommands.ts');

let seen: any;
const Probe = ({ id, want = false }: { id: string | null; want?: boolean }) => ((seen = useMachineCommands(id, want)), null);

test('the Host lists Claude Code and Codex by name; any other agent has no list to ask for', () => {
  assert.deepEqual(['claude', 'codex', 'kimi'].map(wireHarnessOf), ['claude', 'codex', null]);
});

test('a chat on a machine asks that machine about its agent there and its folder; a chat on this Mac, or one with no agent, asks nothing', async () => {
  state = { threads: { c1: { cwd: '/srv/app' }, c2: {}, c3: { cwd: '/x' } }, chatConfig: {}, newChatHost: null };
  Object.assign(basics, { c1: 'host-claude', c2: 'host-codex', c3: '' });
  machine = { id: 'box', name: 'Box' };
  const m = await mount(createElement(Probe, { id: 'c1', want: true }));
  try {
    assert.deepEqual(seen, { machine: { id: 'box', name: 'Box' }, answer: { state: 'loading' } });
    assert.deepEqual(asked.at(-1), ['box', 'claude', '/srv/app', true, 'c1']);
    // a chat with no folder of its own asks with none; Codex is named as it is
    await m.render(createElement(Probe, { id: 'c2' }));
    assert.deepEqual(asked.at(-1), ['box', 'codex', '', false, 'c2']);
    // an agent the machine runs besides those two: the one the chat's id names, then the one the Host moved it to; the Host has no list for it, so it is not asked and the answer is "nothing listed"
    const none = { state: 'ready', listed: false, commands: [] };
    basics.c1 = 'kimi';
    await m.render(createElement(Probe, { id: 'c1' }));
    assert.equal(asked.at(-1)?.[1], null);
    assert.deepEqual(seen, { machine: { id: 'box', name: 'Box' }, answer: none });
    basics.c1 = 'host-claude';
    state.chatConfig = { c1: { hostAgent: 'acp:gemini' } };
    await m.render(createElement(Probe, { id: 'c1' }));
    assert.equal(asked.at(-1)?.[1], null);
    assert.deepEqual(seen?.answer, none);
    state.chatConfig = {};
    // no agent known there: nothing to ask about
    await m.render(createElement(Probe, { id: 'c3' }));
    assert.equal(seen, null);
    assert.deepEqual(asked.at(-1), [null, null, '/x', false, 'c3']);
    // this Mac
    machine = null;
    await m.render(createElement(Probe, { id: 'c1' }));
    assert.equal(seen, null);
    assert.deepEqual(asked.at(-1)?.slice(0, 2), [null, null]);
  } finally {
    await m.unmount();
  }
});

test('the new chat a machine is picked for asks about the agent picked there and the folder picked', async () => {
  machine = null;
  state = { threads: {}, chatConfig: {}, newChatHost: { id: 'box', name: 'Box', path: '/srv/new' } };
  draft = { pick: { id: 'box', name: 'Box', path: '/srv/new' }, want: 'claude', choice: { harness: 'codex' } };
  const m = await mount(createElement(Probe, { id: null, want: true }));
  try {
    assert.deepEqual(seen?.machine, { id: 'box', name: 'Box' });
    assert.deepEqual(asked.at(-1), ['box', 'codex', '/srv/new', true, '']);
    // the machine does not list the agent wanted: the one wanted is asked for
    draft = { ...draft, choice: null };
    await m.render(createElement(Probe, { id: null }));
    assert.deepEqual(asked.at(-1), ['box', 'claude', '/srv/new', false, '']);
    // a pick with no agent at all, and no pick
    draft = { ...draft, want: '' };
    await m.render(createElement(Probe, { id: null }));
    assert.equal(seen, null);
    draft = null;
    state.newChatHost = null;
    await m.render(createElement(Probe, { id: null }));
    assert.equal(seen, null);
    assert.deepEqual(asked.at(-1), [null, null, '', false, '']);
  } finally {
    await m.unmount();
  }
});

test('a chat the store knows no agent or settings of asks about nothing', async () => {
  machine = { id: 'box', name: 'Box' };
  draft = null;
  state = { threads: {}, newChatHost: null };
  const m = await mount(createElement(Probe, { id: 'unknown-chat' }));
  try {
    assert.equal(seen, null);
    assert.deepEqual(asked.at(-1), [null, null, '', false, 'unknown-chat']);
  } finally {
    await m.unmount();
  }
});
