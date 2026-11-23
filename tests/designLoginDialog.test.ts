// The Claude Design sign-in dialog (src/components/dialogs/DesignLoginDialog.tsx): it starts a run on the chat's account,
// follows only its own run's events, offers the opened pages and a pasted code, and stops the run when it closes.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const calls: any[][] = [];
let listener: ((e: any) => void) | null = null;
let start: (...a: any[]) => Promise<void> = async () => {};
let codeAnswer: () => Promise<boolean> = async () => true;
let cancelAnswer: () => Promise<void> = async () => {};
let openAnswer: () => Promise<void> = async () => {};
const state: any = { prefs: { claudeBin: '/bin/claude' }, claudeAccounts: { active: 'main' } };

stubStore({
  getState: () => state,
  toast: (...a: any[]) => calls.push(['toast', ...a]),
});
mock.module('../src/session/harness/claude/accounts.ts', {
  namedExports: { claudeChatAccount: (id: string) => `acct-of-${id}` },
});
installNativeStub({
  claude: {
    designLogin: (...a: any[]) => {
      calls.push(['start', ...a]);
      return start(...a);
    },
    designLoginCode: (...a: any[]) => {
      calls.push(['code', ...a]);
      return codeAnswer();
    },
    designLoginCancel: (...a: any[]) => {
      calls.push(['cancel', ...a]);
      return cancelAnswer();
    },
    onDesignLogin: (cb: (e: any) => void) => {
      listener = cb;
      return () => {
        calls.push(['off']);
        if (listener === cb) listener = null;
      };
    },
  },
  shell: {
    openExternal: (u: string) => {
      calls.push(['open', u]);
      return openAnswer();
    },
  },
});
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { DesignLoginDialog, OPEN_DESIGN_LOGIN } = await import('../src/components/dialogs/DesignLoginDialog.tsx');

let closed = 0;
async function mount(threadId: string | null) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(() => root.render(createElement(DesignLoginDialog, { threadId, onClose: () => closed++ })));
  return { host, unmount: () => act(() => root.unmount()) };
}
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const startedId = () => calls.filter((c) => c[0] === 'start').at(-1)![1] as string;
const emit = (e: any) => act(() => listener!(e));
function setValue(el: any, value: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, value);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}
const pages = { kind: 'pages', url: 'https://claude.ai/auto', manualUrl: 'https://claude.ai/manual', manualFirst: false };

beforeEach(() => {
  calls.length = 0;
  closed = 0;
  start = async () => {};
  codeAnswer = async () => true;
  cancelAnswer = async () => {};
  openAnswer = async () => {};
});

test('the event name the command opens it with', () => {
  assert.equal(OPEN_DESIGN_LOGIN, 'open-design-login');
});

test('it signs in on the chat’s account, ignores other runs, and closes itself when it is authorized', async () => {
  const { host, unmount } = await mount('c1');
  const id = startedId();
  assert.deepEqual(calls[0], ['start', id, '/bin/claude', 'acct-of-c1']);
  assert.match(host.textContent!, /Starting the sign-in/);
  // another run's events are not this one's
  await emit({ id: 'someone-else', kind: 'done', ok: true });
  assert.equal(closed, 0);
  await emit({ id, ...pages });
  assert.match(host.textContent!, /Finish signing in to claude\.ai in your browser/);
  await act(() => button(host, 'Open the sign-in page again')!.click());
  await act(() => button(host, 'Sign in with a code instead')!.click());
  assert.deepEqual(
    calls.filter((c) => c[0] === 'open'),
    [
      ['open', 'https://claude.ai/auto'],
      ['open', 'https://claude.ai/manual'],
    ],
  );
  await emit({ id, kind: 'done', ok: true });
  assert.deepEqual(calls.at(-1), ['toast', 'Claude Design is authorized for this account']);
  assert.equal(closed, 1);
  await unmount();
  // closing lets go of the events and stops the run (main leaves an ended one alone)
  assert.deepEqual(calls.slice(-2), [['off'], ['cancel', id]]);
});

test('a new chat uses the active account; a remote session asks for the code first', async () => {
  const { host, unmount } = await mount(null);
  const id = startedId();
  assert.equal(calls[0][3], 'main');
  await emit({ id, ...pages, url: null, manualFirst: true });
  assert.match(host.textContent!, /paste the code it shows here/);
  assert.ok(button(host, 'Open the sign-in page again'));
  assert.equal(button(host, 'Sign in with a code instead'), undefined);
  await emit({ id, ...pages, manualUrl: null, manualFirst: true });
  assert.equal(button(host, 'Open the sign-in page again'), undefined);
  await unmount();
});

test('a pasted code goes to the run; Enter submits too; an ended run or a failure says so', async () => {
  const { host, unmount } = await mount('c1');
  const id = startedId();
  await emit({ id, ...pages });
  const input = host.querySelector('input') as HTMLInputElement;
  assert.equal(button(host, 'Submit code')!.disabled, true);
  // nothing to send yet
  await act(() => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  assert.equal(calls.filter((c) => c[0] === 'code').length, 0);
  await act(() => setValue(input, ' abc#state '));
  await act(async () => button(host, 'Submit code')!.click());
  await flush();
  assert.deepEqual(
    calls.find((c) => c[0] === 'code'),
    ['code', id, ' abc#state '],
  );
  assert.match(host.textContent!, /Checking the code/);
  codeAnswer = async () => false;
  await act(() => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true })));
  await act(() => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', 'This sign-in has ended. Try again.', 'error']);
  codeAnswer = async () => {
    throw new Error("Error invoking remote method 'claude:designLoginCode': Error: gone");
  };
  await act(async () => button(host, 'Submit code')!.click());
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', 'gone', 'error']);
  // a page that won't open says why
  openAnswer = async () => {
    throw new Error('no opener');
  };
  await act(() => button(host, 'Open the sign-in page again')!.click());
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', 'no opener', 'error']);
  await unmount();
});

test('a code answered after the dialog moved on to another run is dropped', async () => {
  let answer!: (v: boolean) => void;
  codeAnswer = () => new Promise((r) => (answer = r));
  const { host, unmount } = await mount('c1');
  await emit({ id: startedId(), ...pages });
  await act(() => setValue(host.querySelector('input'), 'abc'));
  await act(async () => button(host, 'Submit code')!.click());
  await emit({ id: startedId(), kind: 'done', ok: false, message: 'The browser sign-in timed out after five minutes. Try again.' });
  await act(() => button(host, 'Try again')!.click());
  const second = startedId();
  await act(async () => answer(false));
  await flush();
  assert.equal(
    calls.some((c) => c[0] === 'toast'),
    false,
  );
  assert.match(host.textContent!, /Starting the sign-in/);
  // a code answered after this run failed keeps the failure on screen
  let late!: (v: boolean) => void;
  codeAnswer = () => new Promise((r) => (late = r));
  await emit({ id: second, ...pages });
  await act(() => setValue(host.querySelector('input'), 'abc'));
  await act(async () => button(host, 'Submit code')!.click());
  await emit({ id: second, kind: 'done', ok: false, message: 'The sign-in did not return a usable credential. Try again.' });
  await act(async () => late(true));
  await flush();
  assert.match(host.textContent!, /did not return a usable credential/);
  await unmount();
});

test('a failed run shows why and starts over on Try again; a failed start does too', async () => {
  const { host, unmount } = await mount('c1');
  const first = startedId();
  await emit({ id: first, kind: 'done', ok: false, message: 'Claude Design sync is not available in this session.' });
  assert.match(host.textContent!, /not available in this session/);
  await emit({ id: first, kind: 'done', ok: false });
  assert.match(host.textContent!, /The sign-in failed\. Try again\./);
  await act(() => button(host, 'Close')!.click());
  assert.equal(closed, 1);
  start = async () => {
    throw new Error("Error invoking remote method 'claude:designLogin': Error: Claude Code is not installed");
  };
  cancelAnswer = async () => {
    throw new Error('window gone');
  };
  await act(() => button(host, 'Try again')!.click());
  await flush();
  const second = startedId();
  assert.notEqual(second, first);
  // the first run was stopped when the second started (a failed stop is only noted)
  assert.ok(calls.some((c) => c[0] === 'cancel' && c[1] === first));
  assert.match(host.textContent!, /Claude Code is not installed/);
  await unmount();
});

test('a start that fails after the dialog closed changes nothing', async () => {
  let fail!: (e: Error) => void;
  start = () => new Promise((_r, j) => (fail = j));
  const { unmount } = await mount('c1');
  await unmount();
  await act(async () => fail(new Error('late')));
  await flush();
  assert.equal(calls.filter((c) => c[0] === 'toast').length, 0);
});
