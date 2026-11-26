// Quick Chat (src/components/mini/Mini.tsx): the floating window's draft, sending, stopping, opening and hiding.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { focusFixup, keyTarget, pressKey } from './support/focus-fixup.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act, useSyncExternalStore } = await import('react');
const { createRoot } = await import('react-dom/client');

const listeners = new Set<() => void>();
let state: any;
const update = (patch: any) => {
  state = { ...state, ...patch };
  listeners.forEach((cb) => cb());
};
const events: any[] = [];
let saved: { threadId: string | null; text: string };
let read: () => Promise<any>;
let saveImpl: (s: any) => Promise<void>;
let openImpl: (id: string) => Promise<any>;
let createImpl: (seed: string) => Promise<string | null>;
let sendImpl: (...a: any[]) => Promise<unknown>;
let interruptImpl: (id: string) => Promise<void>;
let shown: () => void = () => {};
let boots = 0;
function reset() {
  state = {
    route: { name: 'home' },
    prefs: { sendWith: 'enter', followUp: 'queue', fontSize: 14, codeFontSize: 12 },
    runtime: {},
    usable: true,
    checking: false,
    dark: true,
  };
  events.length = 0;
  saved = { threadId: null, text: 'hello from quick chat' };
  read = async () => saved;
  saveImpl = async (s) => {
    saved = { ...s };
  };
  openImpl = async (id) => (events.push(['open', id]), { ok: true });
  createImpl = async (seed) => {
    events.push(['create', seed]);
    update({ route: { name: 'thread', id: 'claude:quick' } });
    return 'claude:quick';
  };
  sendImpl = async (...a) => {
    events.push(['send', ...a]);
  };
  interruptImpl = async (id) => {
    events.push(['stop', id]);
  };
}
reset();

installNativeStub({
  win: {
    quickChatRead: () => read(),
    quickChatSave: (s: any) => (events.push(['save', s]), saveImpl(s)),
    quickChatOpen: (id: string) => openImpl(id),
    miniHide: async () => {
      events.push(['hide']);
    },
    onMiniShown: (cb: () => void) => ((shown = cb), () => events.push(['offShown'])),
  },
});
stubStore({
  useStore: (sel: any) =>
    useSyncExternalStore(
      (cb) => (listeners.add(cb), () => listeners.delete(cb)),
      () => sel(state),
    ),
  getState: () => state,
  boot: async (o: unknown) => {
    boots++;
    events.push(['boot', o]);
  },
  navigate: (route: any) => update({ route }),
  createChatThread: (seed: string) => createImpl(seed),
  interrupt: (id: string) => interruptImpl(id),
  resetNewChatDefaults: () => events.push(['resetDefaults']),
  clearNewChatProject: () => events.push(['clearProject']),
  anyHarnessUsable: (s: any) => s.usable,
  harnessesChecking: (s: any) => s.checking,
  chatKind: (id: string) => id.split(':')[0],
});
// how new chats start is its own (tests/newChatStart.test.ts): here when the bar starts its draft and what it remembers
mock.module('../src/session/newChatStart.ts', {
  namedExports: {
    applyNewChatDefault: () => events.push(['applyDefault']),
    rememberUsedChat: (id: string, kind: string) => events.push(['remember', id, kind]),
  },
});
mock.module('../src/harness/adapters/proxy.ts', { namedExports: { chatProxy: { send: (...a: any[]) => sendImpl(...a) } } });
const useState_ = (sel: (s: any) => any) =>
  useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => sel(state),
  );
mock.module('../src/components/markdown/Markdown.tsx', { namedExports: { useResolvedDark: () => useState_((s) => s.dark) } });
mock.module('../src/components/harnessPicker/HarnessPicker.tsx', {
  namedExports: { ModelPicker: ({ threadId }: any) => h('span', { 'data-model': String(threadId) }) },
});
mock.module('../src/components/thread/ThreadView.tsx', {
  namedExports: { ThreadView: ({ threadId, composer }: any) => h('div', { 'data-thread': threadId, 'data-composer': String(composer) }) },
});
mock.module('../src/components/composer/QueuedList.tsx', {
  namedExports: { QueuedList: ({ threadId }: any) => h('div', { 'data-queued': threadId }) },
});
mock.module('../src/components/accounts/Accounts.tsx', { namedExports: { AccountSignInDialog: () => null } });
mock.module('../src/components/ui/Toasts.tsx', { namedExports: { Toasts: () => null } });
// Ask MoMo (its own tests: askMomoUI.test.ts): Quick Chat shows its toggle and, while on, its pane instead of the chat
let askOn = false;
mock.module('../src/components/momo/AskMomo.tsx', {
  namedExports: {
    useAskMomo: () => ({ available: true, on: askOn, setOn: () => undefined }),
    AskMomoToggle: () => h('button', { 'aria-label': 'Ask MoMo' }),
    AskMomoPane: () => h('div', { 'data-askmomo': 'pane' }),
    AskMomoBrain: () => h('span', { 'data-askmomo': 'brain' }),
  },
});
const { Mini } = await import('../src/components/mini/Mini.tsx');

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(h(Mini)));
  await settle();
  const q = (sel: string) => host.querySelector(sel) as HTMLElement;
  const input = () => q('textarea') as HTMLTextAreaElement;
  const type = async (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), value);
      input().dispatchEvent(new window.Event('input', { bubbles: true }) as any);
    });
  const key = (init: object, target: EventTarget = input()) =>
    act(async () => {
      target.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }) as any);
    });
  const click = (label: string) => act(async () => q(`[aria-label="${label}"]`).click());
  const unmount = async () => {
    await act(() => root.unmount());
    host.remove();
  };
  return {
    host,
    q,
    input,
    type,
    key,
    click,
    unmount,
    empty: () => q('.quick-chat-empty')?.textContent,
    error: () => q('[role=alert]')?.textContent,
  };
}

test('Quick Chat stays in place, retains the draft until accepted, and opens the same thread', async () => {
  reset();
  let release!: () => void;
  sendImpl = async (...a) => {
    events.push(['send', ...a]);
    return new Promise((r) => (release = () => r({ action: 'started', id: 'turn' })));
  };
  const m = await mount();
  assert.ok(document.documentElement.classList.contains('mini-root'));
  assert.equal(m.input().value, 'hello from quick chat');
  assert.equal(m.empty(), 'What can I help with?');
  await m.click('Send');
  assert.equal(m.input().value, 'hello from quick chat', 'draft is retained during delivery');
  // read-only, not disabled: a disabled field drops the keyboard to <body> (#1658)
  assert.equal(m.input().readOnly, true);
  assert.equal(m.input().getAttribute('aria-disabled'), 'true');
  assert.deepEqual(
    events.find((e) => e[0] === 'create'),
    ['create', 'hello from quick chat'],
  );
  assert.ok(m.q('[data-thread="claude:quick"]'));
  assert.equal(m.q('[data-composer-chat="claude:quick"] [data-queued]').dataset.queued, 'claude:quick');
  const send = events.find((e) => e[0] === 'send');
  assert.deepEqual(send.slice(1, 6), ['claude:quick', 'hello from quick chat', [], { human: true }, 'queue']);
  // a fresh draft: from Settings' fixed default when new chats use one
  assert.deepEqual(events.filter((e) => e[0] === 'resetDefaults' || e[0] === 'applyDefault').slice(0, 2), [
    ['resetDefaults'],
    ['applyDefault'],
  ]);
  await act(async () => release());
  assert.equal(m.input().value, '');
  assert.deepEqual(saved, { threadId: 'claude:quick', text: '' });
  // the message went: its chat is the last used
  assert.deepEqual(
    events.find((e) => e[0] === 'remember'),
    ['remember', 'claude:quick', 'claude'],
  );
  await act(() => update({ runtime: { 'claude:quick': { activeTurnId: 'turn-1' } } }));
  await m.click('Stop');
  assert.deepEqual(events.at(-1), ['stop', 'claude:quick']);
  await m.click('Open in app');
  assert.deepEqual(events.at(-1), ['open', 'claude:quick']);
  await m.click('New chat');
  assert.deepEqual(events.slice(-3, -1), [['resetDefaults'], ['applyDefault']]);
  assert.deepEqual(saved, { threadId: null, text: '' });
  assert.equal(state.route.name, 'home');
  assert.equal(state.runtime['claude:quick'].activeTurnId, 'turn-1', 'New chat does not stop previous work');
  await m.unmount();
  assert.deepEqual(events.at(-1), ['offShown']);
  assert.equal(boots, 1);
});

test('only the title and spacer drag the window, and buttons with nothing to do are disabled', async () => {
  reset();
  saved = { threadId: null, text: '' };
  const m = await mount();
  assert.equal(document.documentElement.dataset.platform, 'darwin', 'styles frame the panel off macOS');
  const header = m.q('.quick-chat-header');
  assert.deepEqual(
    [...header.querySelectorAll('.quick-chat-drag')].map((e) => e.className),
    ['quick-chat-title quick-chat-drag', 'quick-chat-spacer quick-chat-drag'],
  );
  assert.equal(header.querySelector('.quick-chat-drag button, .quick-chat-drag [data-model]'), null, 'no control inside a drag region');
  const button = (label: string) => m.q(`[aria-label="${label}"]`) as HTMLButtonElement;
  assert.equal(button('New chat').disabled, true, 'nothing to clear');
  assert.equal(button('Open in app').disabled, true, 'no chat yet');
  assert.equal(button('Hide Quick Chat').disabled, false);
  await m.type('draft');
  assert.equal(button('New chat').disabled, false, 'a draft can be cleared');
  await m.click('New chat');
  assert.equal(m.input().value, '');
  assert.equal(button('New chat').disabled, true);
  saveImpl = async () => {
    throw new Error('disk full');
  };
  await m.type('x');
  await m.type('');
  assert.equal(m.error(), 'disk full');
  assert.equal(button('New chat').disabled, false, 'an error can be cleared');
  saveImpl = async (s) => {
    saved = { ...s };
  };
  await m.click('New chat');
  assert.equal(m.error(), undefined);
  assert.equal(button('New chat').disabled, true);
  await act(() => update({ route: { name: 'thread', id: 'claude:t' } }));
  assert.equal(button('New chat').disabled, false, 'a chat can be left');
  assert.equal(button('Open in app').disabled, false);
  await m.unmount();
});

test('a saved chat reopens; theme and appearance follow the prefs', async () => {
  reset();
  saved = { threadId: 'claude:old', text: '' };
  document.documentElement.style.setProperty('--stale', '1');
  document.documentElement.style.setProperty('color', 'red');
  const m = await mount();
  assert.equal(state.route.id, 'claude:old');
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(document.documentElement.style.getPropertyValue('--stale'), '');
  assert.equal(document.documentElement.style.getPropertyValue('color'), 'red');
  assert.equal(document.documentElement.style.getPropertyValue('--fs-chat'), '14px');
  await act(() => update({ dark: false }));
  assert.equal(document.documentElement.dataset.theme, 'light');
  // focus returns to the input when the window is shown again
  m.input().blur();
  await act(async () => shown());
  assert.equal(document.activeElement === m.input(), true);
  await m.unmount();
});

test('the empty state explains checking and missing harnesses', async () => {
  reset();
  let resolveRead!: (v: any) => void;
  read = () => new Promise((r) => (resolveRead = r));
  state = { ...state, usable: false, checking: true };
  const m = await mount();
  assert.equal(m.empty(), 'Starting…');
  await act(async () => resolveRead({ threadId: null, text: '' }));
  assert.equal(m.empty(), 'Checking harnesses…');
  await act(() => update({ checking: false }));
  assert.equal(m.empty(), 'Sign in to a harness to start chatting.');
  assert.equal(m.input().readOnly, true);
  await m.unmount();
});

test('a failed read shows its error; one that lands after closing is ignored', async () => {
  reset();
  read = async () => {
    throw new Error('no state');
  };
  let m = await mount();
  assert.equal(m.error(), 'no state');
  await m.unmount();
  read = () => Promise.reject('plain');
  m = await mount();
  assert.equal(m.error(), 'plain');
  await m.unmount();
  let fail!: (e: unknown) => void;
  read = () => new Promise((_, reject) => (fail = reject));
  m = await mount();
  await m.unmount();
  fail(new Error('late'));
  let ok!: (v: unknown) => void;
  read = () => new Promise((resolve) => (ok = resolve));
  m = await mount();
  await m.unmount();
  ok({ threadId: 'x', text: 'late' });
  await settle();
  assert.equal(state.route.name, 'home');
});

test('typing saves the draft; a failed save shows why', async () => {
  reset();
  const m = await mount();
  await m.type('draft one');
  assert.deepEqual(saved, { threadId: null, text: 'draft one' });
  saveImpl = async () => {
    throw new Error('disk full');
  };
  await m.type('draft two');
  await settle();
  assert.equal(m.error(), 'disk full');
  saveImpl = () => Promise.reject('denied');
  await m.type('draft three');
  await settle();
  assert.equal(m.error(), 'denied');
  await m.unmount();
});

test('Enter keeps the keyboard in the box while the message goes out, so the next one can be typed (#1658)', async () => {
  reset();
  const uninstall = focusFixup();
  let release!: () => void;
  sendImpl = async (...a) => {
    events.push(['send', ...a]);
    await new Promise<void>((r) => (release = r));
  };
  const m = await mount();
  try {
    m.input().focus();
    await pressKey('Enter');
    await settle();
    assert.equal(m.input().readOnly, true);
    assert.equal(keyTarget(), m.input());
    await act(async () => release());
    await settle();
    assert.equal(m.input().readOnly, false);
    assert.equal(keyTarget(), m.input());
  } finally {
    uninstall();
    await m.unmount();
  }
});

test('Enter sends per the send-with setting; other keys and a second Enter do not', async () => {
  reset();
  let release!: () => void;
  sendImpl = async (...a) => {
    events.push(['send', ...a]);
    await new Promise<void>((r) => (release = r));
  };
  const m = await mount();
  await m.key({ key: 'Enter', shiftKey: true });
  assert.equal(
    events.some((e) => e[0] === 'send'),
    false,
  );
  // two Enters before a re-render: only one send
  await act(async () => {
    m.input().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }) as any);
    m.input().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }) as any);
  });
  assert.equal(events.filter((e) => e[0] === 'create').length, 1);
  await act(async () => release());
  // empty text, not ready or unusable: Enter does nothing
  await m.key({ key: 'Enter' });
  await act(() => update({ usable: false }));
  await m.type('blocked');
  await m.key({ key: 'Enter' });
  assert.equal(events.filter((e) => e[0] === 'send').length, 1);
  await m.unmount();
  // not ready yet
  reset();
  read = () => new Promise(() => {});
  const pending = await mount();
  await pending.key({ key: 'Enter' });
  assert.equal(
    events.some((e) => e[0] === 'create'),
    false,
  );
  await pending.unmount();
});

test('send failures keep the draft and show why', async () => {
  reset();
  createImpl = async () => null;
  const m = await mount();
  await m.click('Send');
  assert.equal(m.error(), 'Could not start chat. Check your harness and sign-in.');
  assert.equal(m.input().value, 'hello from quick chat');
  assert.equal(m.input().readOnly, false);
  reset();
  createImpl = async () => {
    throw 'offline';
  };
  await act(() => update({}));
  await m.type('again');
  await m.click('Send');
  assert.equal(m.error(), 'offline');
  await m.unmount();
});

test('stop, open and new chat report their failures', async () => {
  reset();
  saved = { threadId: 'claude:t', text: '' };
  state = { ...state, runtime: { 'claude:t': { activeTurnId: 'r' } } };
  const m = await mount();
  interruptImpl = async () => {
    throw new Error('cannot stop');
  };
  await m.click('Stop');
  assert.equal(m.error(), 'cannot stop');
  interruptImpl = () => Promise.reject('stuck');
  await m.click('Stop');
  assert.equal(m.error(), 'stuck');
  openImpl = async () => ({ ok: false, error: 'window closed' });
  await m.click('Open in app');
  assert.equal(m.error(), 'window closed');
  openImpl = async () => ({ ok: false });
  await m.click('Open in app');
  assert.equal(m.error(), 'Could not open chat');
  // a request that fails on the way is shown too, not dropped
  openImpl = () => Promise.reject(new Error('bridge gone'));
  await m.click('Open in app');
  assert.equal(m.error(), 'bridge gone');
  saveImpl = async () => {
    throw new Error('save failed');
  };
  await m.click('Open in app');
  assert.equal(m.error(), 'save failed');
  await m.click('New chat');
  assert.equal(m.error(), 'save failed');
  assert.equal(state.route.id, 'claude:t');
  await m.unmount();
});

test('hiding saves first once loaded, and Escape hides unless something else owns it', async () => {
  reset();
  read = () => new Promise(() => {});
  let m = await mount();
  await m.click('Hide Quick Chat');
  await m.key({ key: 'Escape' }, window as any);
  assert.deepEqual(
    events.filter((e) => e[0] === 'hide' || e[0] === 'save').map((e) => e[0]),
    ['hide', 'hide'],
  );
  await m.unmount();

  reset();
  m = await mount();
  events.length = 0;
  await m.click('Hide Quick Chat');
  await settle();
  assert.deepEqual(
    events.map((e) => e[0]),
    ['save', 'hide'],
  );
  saveImpl = async () => {
    throw new Error('nope');
  };
  events.length = 0;
  await m.click('Hide Quick Chat');
  await settle();
  assert.deepEqual(
    events.map((e) => e[0]),
    ['save'],
  );
  // Escape: saved or not, the window hides
  events.length = 0;
  await m.key({ key: 'Escape' }, window as any);
  await settle();
  assert.deepEqual(
    events.map((e) => e[0]),
    ['save', 'hide'],
  );
  saveImpl = async () => {};
  events.length = 0;
  await m.key({ key: 'Escape' }, window as any);
  await settle();
  assert.deepEqual(
    events.map((e) => e[0]),
    ['save', 'hide'],
  );
  // ignored: other keys, composing, already handled, or a dialog open
  events.length = 0;
  await m.key({ key: 'a' }, window as any);
  await m.key({ key: 'Escape', isComposing: true }, window as any);
  const claim = (e: Event) => e.preventDefault();
  window.addEventListener('keydown', claim as any, true);
  await m.key({ key: 'Escape' }, window as any);
  (window as any).removeEventListener('keydown', claim, true);
  const dialog = document.createElement('div');
  dialog.className = 'dialog';
  document.body.append(dialog);
  await m.key({ key: 'Escape' }, window as any);
  dialog.remove();
  await settle();
  assert.deepEqual(events, []);
  await m.unmount();
});

test('Ask MoMo: its toggle in the header, and its pane instead of Quick Chat’s own chat and composer while it is on', async () => {
  reset();
  const m = await mount();
  assert.ok(m.q('[aria-label="Ask MoMo"]'));
  assert.equal(m.q('[data-askmomo]'), null);
  await m.unmount();
  askOn = true;
  const on = await mount();
  assert.ok(on.q('[data-askmomo="pane"]'));
  assert.equal(on.q('textarea'), null, 'Quick Chat’s own composer is not shown');
  // the header names MoMo's brain, never the coding Quick Chat's model (#2288)
  assert.ok(on.q('[data-askmomo="brain"]'));
  assert.equal(on.q('[data-model]'), null);
  askOn = false;
  await on.unmount();
});
