// TermView over a process someone else owns (a harness install run in main): its transport carries data, input,
// size, exit and errors, and the view starts and kills no pty of its own.
import { FakeTerminal, terminalCalls as calls, terminalInstances as terms } from './support/terminal-ui-fake';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, markdownStub, settle, render } from './support/shell-panels-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const store = fakeStore({ prefs: { codeFontSize: 12, keybindings: {} } });
(globalThis as any).ResizeObserver = class {
  observe() {}
  disconnect() {}
};
class FakeFit {
  fit() {}
}
const native = {
  pty: {
    onEvent: () => () => calls.push(['off']),
    spawn: async (id: string) => calls.push(['spawn', id]),
    write: () => undefined,
    resize: () => undefined,
    kill: async (id: string) => calls.push(['kill', id]),
  },
};
mock.module('@xterm/xterm', { namedExports: { Terminal: FakeTerminal } });
mock.module('@xterm/addon-fit', { namedExports: { FitAddon: FakeFit } });
mock.module('@xterm/xterm/css/xterm.css', { namedExports: {} });
stubStore(store.exports);
installNativeStub(native);
mock.module('../src/components/markdown/Markdown.tsx', { namedExports: markdownStub({ dark: true }) });
const { createElement, act } = await import('react');
const { TermView } = await import('../src/components/panels/TerminalPanel.tsx');

test("a term view on someone else's process uses its transport: no pty of its own, and closing leaves the process", async () => {
  const exits: number[] = [];
  const errors: string[] = [];
  const seen: any[] = [];
  let on: any = null;
  const transport = (tab: any, size: any, events: any) => {
    on = events;
    seen.push(['open', tab.id, size]);
    return {
      write: (d: string) => seen.push(['write', d]),
      resize: (c: number, r: number) => seen.push(['resize', c, r]),
      close: () => seen.push(['close']),
    };
  };
  const tab = { id: 'run-1', cwd: '', title: 'install' };
  const r = await render(
    createElement(TermView, {
      tab,
      visible: true,
      transport,
      onExit: (c: number) => exits.push(c),
      onError: (m: string) => errors.push(m),
    }),
  );
  await settle(act);
  const term = terms[0];
  await act(async () => {
    on.data('out');
    on.exit(0);
    on.error('gone');
  });
  assert.deepEqual(term.written, ['out', '\r\n\x1b[2m[process exited with code 0]\x1b[0m\r\n', '\r\n\x1b[31mgone\x1b[0m\r\n']);
  assert.deepEqual(exits, [0]);
  assert.deepEqual(errors, ['gone']);
  term.data!('y');
  term.resize!({ rows: 10, cols: 50 });
  await r.unmount();
  assert.deepEqual(seen, [['open', 'run-1', { cols: 80, rows: 24 }], ['write', 'y'], ['resize', 50, 10], ['close']]);
  assert.equal(calls.filter((c) => c[0] === 'spawn' || c[0] === 'kill').length, 0, 'no pty of its own');
});

test('a shared package log is read-only, and changing that view option never restarts its process', async () => {
  const seen: any[] = [];
  const transport = () => {
    seen.push(['open']);
    return {
      write: (d: string) => seen.push(['write', d]),
      resize() {},
      close() {
        seen.push(['close']);
      },
    };
  };
  const props = { tab: { id: 'package-output', cwd: '', title: 'install' }, visible: false, transport, onExit() {} };
  const r = await render(createElement(TermView, { ...props, readOnly: true }));
  const term = terms.at(-1)!;
  assert.equal(term.options.disableStdin, true);
  assert.equal(term.options.cursorBlink, false);
  assert.equal(r.host.querySelector('[role=log]')?.getAttribute('aria-label'), 'Command output');
  term.data!('discarded');
  assert.deepEqual(seen, [['open']]);
  await r.rerender(createElement(TermView, { ...props, readOnly: false }));
  assert.equal(term.options.disableStdin, false);
  term.data!('accepted');
  assert.deepEqual(seen, [['open'], ['write', 'accepted']]);
  await r.unmount();
});
