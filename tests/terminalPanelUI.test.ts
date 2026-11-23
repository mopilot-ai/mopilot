// Terminal panel lifecycle, rendering and native shortcut ownership using fake xterm and PTY boundaries.
import { FakeTerminal, terminalCalls as calls, terminalInstances as terms } from './support/terminal-ui-fake';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PALETTE } from '../shared/defaultPalette.mjs';
import './support/dom.ts';
import { fakeStore, markdownStub, one, settle, render } from './support/shell-panels-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const store = fakeStore({ prefs: { codeFontSize: 12, keybindings: {} } });
const theme = { dark: true };
const fit = { throws: false };

class FakeFit {
  fit() {
    if (fit.throws) throw new Error('not attached');
  }
}
const observers: { cb: () => void; disconnected: boolean }[] = [];
(globalThis as any).ResizeObserver = class {
  entry: { cb: () => void; disconnected: boolean };
  constructor(cb: () => void) {
    this.entry = { cb, disconnected: false };
    observers.push(this.entry);
  }
  observe() {}
  disconnect() {
    this.entry.disconnected = true;
  }
};

const ptyListeners = new Set<(e: any) => void>();
const ptyListener = (e: any) => ptyListeners.forEach((cb) => cb(e));
const spawnResult = { error: null as unknown };
const native = {
  pty: {
    onEvent: (cb: (e: any) => void) => {
      ptyListeners.add(cb);
      return () => {
        calls.push(['off']);
        ptyListeners.delete(cb);
      };
    },
    spawn: async (id: string, opts: any) => {
      calls.push(['spawn', id, opts]);
      if (spawnResult.error !== null) throw spawnResult.error;
    },
    write: (id: string, d: string) => calls.push(['write', id, d]),
    resize: (id: string, cols: number, rows: number) => calls.push(['resize', id, cols, rows]),
    kill: async (id: string) => {
      calls.push(['kill', id]);
      throw new Error('already dead');
    },
  },
};
mock.module('@xterm/xterm', { namedExports: { Terminal: FakeTerminal } });
mock.module('@xterm/addon-fit', { namedExports: { FitAddon: FakeFit } });
mock.module('@xterm/xterm/css/xterm.css', { namedExports: {} });
stubStore(store.exports);
installNativeStub(native);
mock.module('../src/components/markdown/Markdown.tsx', { namedExports: markdownStub(theme) });
const { createElement, act } = await import('react');
const { TerminalPanel, TermView, termFontFamily } = await import('../src/components/panels/TerminalPanel.tsx');

beforeEach(() => {
  calls.length = 0;
  store.calls.length = 0;
  terms.length = 0;
  observers.length = 0;
  fit.throws = false;
  spawnResult.error = null;
  theme.dark = true;
});

test('the terminal font follows the platform', () => {
  assert.equal(termFontFamily(true), 'Consolas, "Cascadia Mono", monospace');
  assert.equal(termFontFamily(false), 'Menlo, monospace');
});

test('an embedded sign-in receives its config folder and a recoverable startup error', async () => {
  spawnResult.error = new Error('cannot start');
  const errors: string[] = [];
  const r = await render(
    createElement(TermView, {
      tab: { id: 'scoped-auth', cwd: '/p', title: 'Sign in', env: { CLAUDE_CONFIG_DIR: '/account-a' } },
      visible: false,
      onExit: () => {},
      onError: (message: string) => errors.push(message),
    }),
  );
  assert.deepEqual(errors, ['cannot start']);
  assert.deepEqual((calls.find((c) => c[0] === 'spawn')![2] as any).env, { CLAUDE_CONFIG_DIR: '/account-a' });
  await r.unmount();
});

test('a term view spawns a pty, pipes data both ways and cleans up on unmount', async () => {
  const exits: number[] = [];
  const tab = { id: 'a', cwd: '/repo', title: 'repo', command: ['bash'] };
  const r = await render(createElement(TermView, { tab, visible: true, onExit: (c: number) => exits.push(c) }));
  await settle(act);
  const term = terms[0];
  assert.equal(term.options.fontSize, 12);
  assert.equal(term.options.fontFamily, termFontFamily());
  assert.equal(term.options.theme.background, DEFAULT_PALETTE.dark.bg);
  assert.deepEqual(calls.slice(0, 2), [
    ['open', 'term-view'],
    [
      'spawn',
      'a',
      { command: ['bash'], windowsCommandLine: undefined, env: undefined, cwd: '/repo', cols: 80, rows: 24, systemBrowser: undefined },
    ],
  ]);
  assert.equal(term.focused, 1, 'a visible view takes focus');
  await act(async () => {
    ptyListener({ id: 'other', type: 'data', data: 'ignored' });
    ptyListener({ id: 'a', type: 'data', data: 'hello' });
    ptyListener({ id: 'a', type: 'exit', exitCode: 3 });
  });
  assert.deepEqual(term.written, ['hello', '\r\n\x1b[2m[process exited with code 3]\x1b[0m\r\n']);
  assert.deepEqual(exits, [3]);
  term.data!('ls\r');
  term.resize!({ rows: 40, cols: 100 });
  assert.deepEqual(calls.slice(-2), [
    ['write', 'a', 'ls\r'],
    ['resize', 'a', 100, 40],
  ]);
  observers[0].cb();
  theme.dark = false;
  await r.rerender(createElement(TermView, { tab, visible: true, onExit: () => {} }));
  assert.equal(term.options.theme.background, DEFAULT_PALETTE.light.bg);
  assert.equal(terms.length, 1, 'the same terminal survives a re-render');
  await r.unmount();
  await settle(act);
  assert.equal(term.disposed, true);
  assert.equal(observers[0].disconnected, true);
  assert.deepEqual(
    calls.filter((c) => ['off', 'dispose data', 'dispose resize', 'kill'].includes(c[0] as string)),
    // the pty is let go first (its events, then the process), then the view's own listeners
    [['off'], ['kill', 'a'], ['dispose data'], ['dispose resize']],
  );
});

test('a session starts once per id: a rebuilt tab, a new exit handler and a font size change keep its shell', async () => {
  const exits: string[] = [];
  const view = (onExit: (code: number) => void) =>
    // callers rebuild the tab (and its command) on every render
    createElement(TermView, { tab: { id: 'kept', cwd: '/repo', title: 'repo', command: ['bash'] }, visible: true, onExit });
  const r = await render(view(() => exits.push('first')));
  await settle(act);
  await r.rerender(view((code) => exits.push(`latest ${code}`)));
  // the code font size changes: the open terminal follows it and fits the panel again
  await act(async () => store.exports.setPrefs({ codeFontSize: 15 }));
  assert.equal(terms[0].options.fontSize, 15);
  await act(async () => ptyListener({ id: 'kept', type: 'exit', exitCode: 2 }));
  assert.deepEqual(exits, ['latest 2'], 'the exit goes to the handler of the latest render');
  assert.equal(terms.length, 1);
  assert.equal(calls.filter((c) => c[0] === 'spawn').length, 1);
  assert.equal(calls.filter((c) => c[0] === 'kill').length, 0);
  // a new terminal starts in the current font size
  await r.rerender(createElement(TermView, { tab: { id: 'next', cwd: '/repo', title: 'repo' }, visible: true, onExit: () => {} }));
  assert.equal(terms[1].options.fontSize, 15);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'spawn' || c[0] === 'kill').map((c) => c.slice(0, 2)),
    [
      ['spawn', 'kept'],
      ['kill', 'kept'],
      ['spawn', 'next'],
    ],
  );
  await act(async () => store.exports.setPrefs({ codeFontSize: 12 }));
});

test('a hidden view stays unfocused, and fit failures before layout are tolerated', async () => {
  fit.throws = true;
  const tab = { id: 'b', cwd: '/', title: 'x' };
  const r = await render(createElement(TermView, { tab, visible: false, onExit: () => {} }));
  await settle(act);
  assert.equal((r.host.querySelector('.term-view') as HTMLElement).style.display, 'none');
  assert.equal(terms[0].focused, 0);
  observers[0].cb();
  await r.rerender(createElement(TermView, { tab, visible: true, onExit: () => {} }));
  await settle(act);
  assert.equal((r.host.querySelector('.term-view') as HTMLElement).style.display, 'block');
  assert.equal(terms[0].focused, 1);
});

test('a startup command is typed in once the shell is up', async () => {
  await render(
    createElement(TermView, { tab: { id: 'c', cwd: '/', title: 'login', input: 'claude auth login\r' }, visible: false, onExit: () => {} }),
  );
  await settle(act, 450);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'write'),
    [['write', 'c', 'claude auth login\r']],
  );
});

test("a sign-in term opens its URLs in the user's own browser, not the chat's pane", async () => {
  const tab = { id: 's', cwd: '/', title: 'claude auth login', command: ['claude', 'auth', 'login'], signIn: true };
  await render(createElement(TermView, { tab, visible: false, onExit: () => {} }));
  await settle(act);
  assert.deepEqual(
    calls.find((c) => c[0] === 'spawn'),
    [
      'spawn',
      's',
      {
        command: ['claude', 'auth', 'login'],
        windowsCommandLine: undefined,
        env: undefined,
        cwd: '/',
        cols: 80,
        rows: 24,
        systemBrowser: true,
      },
    ],
  );
});

test('a pty that fails to start says why', async () => {
  spawnResult.error = new Error('no shell');
  await render(createElement(TermView, { tab: { id: 'd', cwd: '/', title: 'x' }, visible: false, onExit: () => {} }));
  await settle(act);
  spawnResult.error = 'plain';
  await render(createElement(TermView, { tab: { id: 'e', cwd: '/', title: 'x' }, visible: false, onExit: () => {} }));
  await settle(act);
  assert.deepEqual(
    terms.map((t) => t.written),
    [['\r\n\x1b[31mno shell\x1b[0m\r\n'], ['\r\n\x1b[31mplain\x1b[0m\r\n']],
  );
});

test('the bottom panel opens a tab, adds and switches tabs, marks exits and closes', async () => {
  const r = await render(createElement(TerminalPanel, { cwd: '/work/app' }));
  await settle(act);
  const tabs = () => [...r.host.querySelectorAll('.bottom-tab')].map((t) => [t.textContent, t.classList.contains('active')]);
  assert.deepEqual(tabs(), [['app', true]]);
  const firstId = calls.find((c) => c[0] === 'spawn')![1];
  await settle(act, 2);
  await act(() => one(r.host, '[title="New terminal"]').click());
  await settle(act);
  assert.deepEqual(
    tabs().map((t) => t[1]),
    [false, true],
  );
  await act(() => (r.host.querySelectorAll('.bottom-tab')[0] as HTMLElement).click());
  assert.deepEqual(
    tabs().map((t) => t[1]),
    [true, false],
  );
  // tabs are reached with Tab and picked with Enter; each close button names its tab
  const second = r.host.querySelectorAll('.bottom-tab')[1] as HTMLElement;
  assert.equal(second.getAttribute('role'), 'button');
  assert.equal(second.getAttribute('aria-pressed'), 'false');
  assert.equal(second.querySelector('.icon-btn')!.getAttribute('aria-label'), 'Close app');
  assert.equal(second.getAttribute('aria-label'), 'app', 'named apart from its close button');
  await act(() => second.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }) as any));
  assert.deepEqual(
    tabs().map((t) => t[1]),
    [false, true],
  );
  await act(() => (r.host.querySelectorAll('.bottom-tab')[0] as HTMLElement).click());
  await act(async () => ptyListener({ id: firstId, type: 'exit', exitCode: 0 }));
  assert.equal(r.host.querySelectorAll('.bottom-tab-exit').length, 1);
  assert.equal(r.host.querySelector('.bottom-tab')!.getAttribute('aria-label'), 'app (exited)');
  // closing an inactive tab keeps the selection; closing the active one moves to the last tab
  await act(() => (r.host.querySelectorAll('.bottom-tab .icon-btn')[1] as HTMLElement).click());
  assert.deepEqual(tabs(), [['appexited', true]]);
  await settle(act, 2);
  await act(() => one(r.host, '[title="New terminal"]').click());
  await settle(act);
  await act(() => (r.host.querySelectorAll('.bottom-tab')[0] as HTMLElement).click());
  await act(() => (r.host.querySelectorAll('.bottom-tab .icon-btn')[0] as HTMLElement).click());
  assert.deepEqual(tabs(), [['app', true]]);
  assert.deepEqual(store.calls, []);
  await act(() => (r.host.querySelectorAll('.bottom-tab .icon-btn')[0] as HTMLElement).click());
  assert.equal(r.host.querySelectorAll('.bottom-tab').length, 0);
  assert.deepEqual(store.calls, [['setState', { bottomPanelOpen: false }]]);
  await act(() => one(r.host, '[title="Hide panel"]').click());
  assert.equal(store.calls.length, 2);
});

test('terminals opened in one clock tick keep separate sessions and output', async (t) => {
  t.mock.method(Date, 'now', () => 1700000000000);
  const r = await render(createElement(TerminalPanel, { cwd: '/repo' }));
  await settle(act);
  await act(() => {
    one(r.host, '[title="New terminal"]').click();
    one(r.host, '[title="New terminal"]').click();
  });
  await settle(act);
  const ids = calls.filter((call) => call[0] === 'spawn').map((call) => call[1]);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
  await act(() => ptyListener({ id: ids[1], type: 'data', data: 'second terminal only' }));
  assert.deepEqual(
    terms.map((term) => term.written),
    [[], ['second terminal only'], []],
  );
  await act(() => (r.host.querySelectorAll('.bottom-tab .icon-btn')[1] as HTMLElement).click());
  assert.deepEqual(
    calls.filter((call) => call[0] === 'kill'),
    [['kill', ids[1]]],
  );
  assert.equal(r.host.querySelectorAll('.bottom-tab').length, 2);
  assert.deepEqual(
    terms.map((term) => term.disposed),
    [false, true, false],
  );
});

test('separate terminal panels created in one clock tick do not share a session', async (t) => {
  t.mock.method(Date, 'now', () => 1700000000000);
  const first = await render(createElement(TerminalPanel, { cwd: '/first' }));
  const second = await render(createElement(TerminalPanel, { cwd: '/second' }));
  await settle(act);
  const ids = calls.filter((call) => call[0] === 'spawn').map((call) => call[1]);
  assert.notEqual(ids[0], ids[1]);
  await first.unmount();
  await act(() => ptyListener({ id: ids[1], type: 'data', data: 'remaining session' }));
  assert.deepEqual(terms[1].written, ['remaining session']);
  assert.equal(terms[1].disposed, false);
  assert.ok(second.host.querySelector('.bottom-tab'));
});

test('closing a terminal cancels its delayed startup input', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = await render(
    createElement(TermView, {
      tab: { id: 'closed-input', cwd: '/', title: 'startup', input: 'startup command\r' },
      visible: false,
      onExit: () => {},
    }),
  );
  await act(async () => {});
  await r.unmount();
  await act(() => t.mock.timers.tick(450));
  assert.deepEqual(
    calls.filter((call) => call[0] === 'write'),
    [],
  );
});

for (const failure of [false, true]) {
  test(`a spawn ${failure ? 'failure' : 'acknowledgement'} after terminal disposal is ignored`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    t.mock.method(
      native.pty,
      'spawn',
      async () =>
        new Promise<void>((done, fail) => {
          resolve = done;
          reject = fail;
        }),
    );
    const r = await render(
      createElement(TermView, {
        tab: { id: 'late-spawn', cwd: '/', title: 'startup', input: 'startup command\r' },
        visible: false,
        onExit: () => {},
      }),
    );
    await r.unmount();
    await act(() => (failure ? reject(new Error('late startup failure')) : resolve()));
    await act(() => t.mock.timers.tick(450));
    assert.deepEqual(
      calls.filter((call) => call[0] === 'write'),
      [],
    );
    assert.deepEqual(terms[0].written, []);
    assert.equal(terms[0].disposed, true);
  });
}

function pendingFrames(t: any) {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  t.mock.method(globalThis, 'requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  t.mock.method(globalThis, 'cancelAnimationFrame', (key: number) => {
    frames.delete(key);
  });
  return {
    frames,
    flush: async () => {
      const pending = [...frames.values()];
      frames.clear();
      await act(() => pending.forEach((callback) => callback(0)));
    },
  };
}

for (const action of ['hide', 'close']) {
  test(`a queued terminal focus is cancelled when the view is ${action === 'hide' ? 'hidden' : 'closed'}`, async (t) => {
    const pending = pendingFrames(t);
    const tab = { id: 'pending-focus', cwd: '/', title: 'terminal' };
    const r = await render(createElement(TermView, { tab, visible: true, onExit: () => {} }));
    assert.equal(pending.frames.size, 1);
    if (action === 'hide') await r.rerender(createElement(TermView, { tab, visible: false, onExit: () => {} }));
    else await r.unmount();
    await pending.flush();
    assert.equal(terms[0].focused, 0);
  });
}

test('replacing a visible terminal session focuses the new instance', async (t) => {
  const pending = pendingFrames(t);
  const r = await render(createElement(TermView, { tab: { id: 'old-focus', cwd: '/', title: 'old' }, visible: true, onExit: () => {} }));
  await pending.flush();
  assert.equal(terms[0].focused, 1);
  await r.rerender(createElement(TermView, { tab: { id: 'new-focus', cwd: '/', title: 'new' }, visible: true, onExit: () => {} }));
  await pending.flush();
  assert.equal(terms[0].disposed, true);
  assert.equal(terms[1].focused, 1);
  assert.equal(terms[0].focused, 1);
});

test('xterm intercepts clear before PTY input and ignores keys after its owner is disposed', async () => {
  const r = await render(createElement(TermView, { tab: { id: 'clear', cwd: '/repo', title: 'repo' }, visible: true, onExit() {} }));
  const term = terms[0],
    input = document.createElement('input');
  r.host.querySelector('.term-view')!.append(input);
  input.focus();
  const event = new KeyboardEvent('keydown', { key: 'l', code: 'KeyL', ctrlKey: true, cancelable: true });
  assert.equal(term.keyHandler!(event), false);
  assert.ok(calls.some((c) => c[0] === 'clear'));
  assert.equal(
    calls.some((c) => c[0] === 'write'),
    false,
  );
  window.dispatchEvent(new CustomEvent('workspace-shortcut', { detail: { id: 'clear-terminal' } }));
  window.dispatchEvent(new CustomEvent('workspace-shortcut', { detail: { id: 'unrelated' } }));
  input.blur();
  window.dispatchEvent(new CustomEvent('workspace-shortcut', { detail: { id: 'clear-terminal' } }));
  assert.equal(calls.filter((c) => c[0] === 'clear').length, 2);
  await r.unmount();
  assert.equal(term.keyHandler!(event), true);
});

test("an interactive terminal's pty never answers ConPTY's question itself: xterm.js answers it, and a second answer would arrive as typed input", async () => {
  const tabs = [
    { id: 'plain', cwd: '/repo', title: 'repo' },
    { id: 'command', cwd: '/repo', title: 'repo', command: ['powershell.exe', '-NoLogo'], windowsCommandLine: 'powershell.exe -NoLogo' },
    { id: 'sign-in', cwd: '/p', title: 'Sign in', signIn: true, env: { CLAUDE_CONFIG_DIR: '/a' } },
    { id: 'typed', cwd: '/repo', title: 'repo', input: 'npm test\r' },
  ];
  for (const tab of tabs) {
    const r = await render(createElement(TermView, { tab, visible: true, onExit() {} }));
    await settle(act);
    await r.unmount();
  }
  const spawns = calls.filter((c) => c[0] === 'spawn');
  assert.deepEqual(
    spawns.map((c) => c[1]),
    tabs.map((t) => t.id),
  );
  for (const [, id, opts] of spawns) assert.equal(Object.hasOwn(opts as object, 'selfAnswer'), false, `${id} passes no selfAnswer`);
});
