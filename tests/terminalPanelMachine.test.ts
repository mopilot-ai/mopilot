// The terminal panel of a chat on a machine (audit turn:T63): a shell there over ssh in the chat's folder, none on this Mac in its place for a machine with no ssh.
import { FakeTerminal, terminalCalls as calls, terminalInstances as terms } from './support/terminal-ui-fake';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, markdownStub, one, settle, render } from './support/shell-panels-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const store = fakeStore({ prefs: { codeFontSize: 12, keybindings: {} } });
class FakeFit {
  fit() {}
}
(globalThis as any).ResizeObserver = class {
  observe() {}
  disconnect() {}
};
const native = {
  pty: {
    onEvent: () => () => undefined,
    spawn: async (id: string, opts: any) => void calls.push(['spawn', id, opts]),
    write: () => undefined,
    resize: () => undefined,
    kill: async () => undefined,
  },
};
mock.module('@xterm/xterm', { namedExports: { Terminal: FakeTerminal } });
mock.module('@xterm/addon-fit', { namedExports: { FitAddon: FakeFit } });
mock.module('@xterm/xterm/css/xterm.css', { namedExports: {} });
stubStore(store.exports);
installNativeStub(native);
mock.module('../src/components/markdown/Markdown.tsx', { namedExports: markdownStub({ dark: true }) });
const { createElement, act } = await import('react');
const { TerminalPanel } = await import('../src/components/panels/TerminalPanel.tsx');

beforeEach(() => {
  calls.length = 0;
  store.calls.length = 0;
  terms.length = 0;
});

test('a chat on a machine added over ssh gets a shell there, in its folder; another folder gets its own tab, a chat on this Mac keeps the tabs (audit turn:T63)', async () => {
  const spawned = () => calls.filter((c) => c[0] === 'spawn').map((c) => (c[2] as any).command);
  const box = { id: 'ssh:me@box', name: 'box', folder: '/srv/app' };
  const r = await render(createElement(TerminalPanel, { cwd: '', machine: box }));
  await settle(act);
  assert.deepEqual(spawned(), [['/usr/bin/ssh', '-t', 'me@box', `cd '/srv/app' && exec "$SHELL" -l`]]);
  assert.equal(r.host.querySelector('.bottom-tab')!.textContent, 'box');
  // the same machine and folder again: no second tab
  await r.rerender(createElement(TerminalPanel, { cwd: '', machine: { ...box } }));
  await settle(act);
  assert.equal(spawned().length, 1);
  // another folder on it: its shell comes up beside the first and takes focus
  await r.rerender(createElement(TerminalPanel, { cwd: '', machine: { ...box, folder: '/srv/other' } }));
  await settle(act);
  assert.equal(spawned().length, 2);
  assert.match(spawned()[1][3], /\/srv\/other/);
  assert.equal(r.host.querySelectorAll('.bottom-tab').length, 2);
  assert.equal(r.host.querySelectorAll('.bottom-tab.active').length, 1);
  // New terminal on a machine chat is a shell on the machine too
  await act(async () => (one(r.host, 'button[title="New terminal"]') as HTMLButtonElement).click());
  await settle(act);
  assert.equal(spawned().length, 3);
  assert.match(spawned()[2][3], /\/srv\/other/);
  // a chat on this Mac: the open tabs stay as they are
  await r.rerender(createElement(TerminalPanel, { cwd: '/repo', machine: null }));
  await settle(act);
  assert.equal(spawned().length, 3);
  await r.unmount();
});

test('a chat on a machine with no ssh from this Mac starts no shell and offers no New terminal; the next chat on this Mac gets one (audit turn:T63)', async () => {
  const spawns = () => calls.filter((c) => c[0] === 'spawn').length;
  const far = { id: 'relay:abc', name: 'far', folder: '/x' };
  const r = await render(createElement(TerminalPanel, { cwd: '', machine: far }));
  await settle(act);
  assert.equal(spawns(), 0, 'nothing is started on this Mac in its place');
  assert.equal(one(r.host, '.bottom-note').textContent, 'far has no ssh from this Mac, so there is no terminal here.');
  assert.equal(r.host.querySelector('button[title="New terminal"]'), null);
  await r.rerender(createElement(TerminalPanel, { cwd: '/repo', machine: null }));
  await settle(act);
  assert.equal(spawns(), 1);
  assert.equal(r.host.querySelector('.bottom-note'), null);
  await r.unmount();
});
