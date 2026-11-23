// Ask MoMo in Quick Chat, the window's side (src/components/momo/AskMomo.tsx, #2139): nothing for an uninvited account; the MoMo target sends to MoMo's main chat through window.native.momoAsk and shows its replies; a failed send keeps the draft and retries with the same id; dictation goes into the draft on this Mac with no recording kept; a revoke while Quick Chat is open takes the target away at once.
import { speechMock } from './support/speechMock.ts';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { deferred } from './support/async-scenarios.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act, useSyncExternalStore } = await import('react');
const { createRoot } = await import('react-dom/client');

const listeners = new Set<() => void>();
let state: { allowed: boolean; prefs: any; runtime?: any };
const update = (patch: any) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};
const useState_ = (sel: (s: any) => any) =>
  useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => sel(state),
  );
const calls: any[] = [];
let chatImpl: () => Promise<any>;
let sendImpl: (item: any) => Promise<any>;
let openImpl: () => Promise<void>;
let openThreadImpl: (id: string) => Promise<void>;
let brainImpl: () => Promise<any>;
let brainListener: ((b: any) => void) | null = null;
let held: string[] = [];

mock.module('../src/lib/momo.ts', { namedExports: { useMomoAllowed: () => useState_((s) => s.allowed) } });
installNativeStub({
  momoAsk: {
    chat: () => (calls.push(['chat']), chatImpl()),
    send: (item: any) => (calls.push(['send', item]), sendImpl(item)),
    open: () => (calls.push(['open']), openImpl()),
  },
  momoChat: {
    getBrain: () => (calls.push(['getBrain']), brainImpl()),
    onBrainChanged: (cb: (b: any) => void) => ((brainListener = cb), () => (brainListener = null)),
  },
  speech: speechMock(async (...a) => (calls.push(['transcribe', ...a]), { text: 'and the dentist' })),
  dictation: {
    localStatus: async () => ({ authorization: 'authorized', available: true, onDevice: true }),
    transcribe: async (...a: any[]) => (calls.push(['transcribe', ...a]), { text: 'and the dentist' }),
  },
  recordings: { save: async () => void calls.push(['save']) },
});
stubStore({
  useStore: (sel: any) => useState_(sel),
  getState: () => state,
  navigate: () => {},
  openThread: (id: string) => (calls.push(['openThread', id]), openThreadImpl(id)),
  toast: (t: string) => calls.push(['toast', t]),
});
mock.module('../src/components/thread/ThreadView.tsx', {
  namedExports: {
    ThreadView: ({ threadId, composer, readOnly, readOnlyNote }: any) =>
      h('div', { 'data-thread': threadId, 'data-composer': String(composer), 'data-readonly': String(readOnly) }, readOnlyNote),
  },
});
mock.module('../src/components/momo/settings/BrainPicker.tsx', {
  namedExports: { BrainLabel: ({ brain }: any) => h('span', { 'data-brain': brain.harness }, brain.harness) },
});
// the question's own copy in the chat (askedQuestion.ts has its own tests)
mock.module('../src/components/momo/askedQuestion.ts', {
  namedExports: {
    showAsked: (chatId: string, id: string, text: string) => calls.push(['showAsked', chatId, id, text]),
    dropAsked: (chatId: string, id: string) => calls.push(['dropAsked', chatId, id]),
    heldAsked: (_turns: unknown, asked: Map<string, string>) => held.filter((id) => asked.has(id)),
  },
});
mock.module('../src/lib/flags.ts', { namedExports: { useFlag: () => true } });
mock.module('../src/session/voice.ts', {
  namedExports: { currentDictationEngine: async () => 'chatgpt', currentDictationChain: async () => ['chatgpt'] },
});
mock.module('../src/lib/dictation.ts', { namedExports: { recordingToWav: async () => new Uint8Array([1]) } });

class Stream {
  getTracks() {
    return [{ stop() {} }];
  }
}
class FakeRecorder {
  static isTypeSupported = () => true;
  state = 'inactive';
  ondataavailable: any;
  onstop: any;
  stream = new Stream();
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1])]) });
    this.onstop?.();
  }
}
(globalThis as any).MediaRecorder = FakeRecorder;
Object.defineProperty(window.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => new Stream() } });

const { useAskMomo, AskMomoToggle, AskMomoPane, AskMomoBrain } = await import('../src/components/momo/AskMomo.tsx');

/** Quick Chat's header and body as the integration mounts them. */
function Host() {
  const ask = useAskMomo();
  return h('div', null, h(AskMomoToggle, { ask }), ask.on ? h(AskMomoPane) : h('div', { 'data-quick-chat': '' }));
}

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(h(Host)));
  await settle();
  const q = (sel: string) => host.querySelector(sel) as HTMLElement | null;
  const input = () => q('textarea') as HTMLTextAreaElement;
  const type = (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), value);
      input().dispatchEvent(new window.Event('input', { bubbles: true }) as any);
    });
  const key = (init: object) =>
    act(async () => {
      input().dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }) as any);
    });
  const click = async (label: string) => {
    await act(async () => q(`[aria-label="${label}"]`)!.click());
    await settle();
  };
  const unmount = async () => {
    await act(() => root.unmount());
    host.remove();
  };
  return { host, q, input, type, key, click, unmount };
}

beforeEach(() => {
  state = { allowed: true, prefs: { sendWith: 'enter', followUp: 'queue' }, runtime: {} };
  calls.length = 0;
  chatImpl = async () => ({ chatId: 'claude:momo-main' });
  sendImpl = async () => ({ chatId: 'claude:momo-main', note: null });
  openImpl = async () => {};
  openThreadImpl = async () => {};
  brainImpl = async () => ({ harness: 'claude', account: null, model: 'haiku', modelLabel: 'Haiku' });
  held = [];
});

test('an uninvited account sees no MoMo target and nothing reaches MoMo', async () => {
  state.allowed = false;
  const m = await mount();
  try {
    assert.equal(m.q('[aria-label="Ask MoMo"]'), null);
    assert.ok(m.q('[data-quick-chat]'));
    assert.deepEqual(calls, []);
  } finally {
    await m.unmount();
  }
});

test('the MoMo target shows MoMo’s main chat and sends there; Quick Chat comes back with the same button', async () => {
  const m = await mount();
  try {
    const toggle = m.q('[aria-label="Ask MoMo"]')!;
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(toggle.title, 'Ask MoMo');
    await m.click('Ask MoMo');
    assert.equal(m.q('[data-thread]')!.dataset.thread, 'claude:momo-main');
    assert.equal(m.q('[data-thread]')!.dataset.composer, 'false');
    assert.equal(m.q('[aria-label="Ask MoMo"]')!.title, 'Back to Quick Chat');
    assert.equal((m.q('[aria-label="Send to MoMo"]') as HTMLButtonElement).disabled, true);
    await m.type('What do I have today?');
    // Shift+Enter is a new line
    await m.key({ key: 'Enter', shiftKey: true });
    assert.equal(calls.filter((c) => c[0] === 'send').length, 0);
    await m.key({ key: 'Enter' });
    await settle();
    const first = calls.find((c) => c[0] === 'send')![1];
    assert.equal(first.text, 'What do I have today?');
    assert.equal(first.followUp, 'queue');
    assert.equal(m.input().value, '');
    sendImpl = async () => ({ chatId: 'claude:momo-new', note: 'Queued: Claude Code is busy' });
    await m.type('And tomorrow?');
    await m.click('Send to MoMo');
    const second = calls.filter((c) => c[0] === 'send')[1][1];
    assert.notEqual(second.id, first.id);
    assert.equal(m.q('[data-thread]')!.dataset.thread, 'claude:momo-new');
    assert.equal(m.q('[role=alert]')!.textContent, 'Queued: Claude Code is busy');
    await m.click('Ask MoMo');
    assert.ok(m.q('[data-quick-chat]'));
  } finally {
    await m.unmount();
  }
});

test('a failed send keeps the draft and retries with the same id; a changed draft gets a new one', async () => {
  const m = await mount();
  try {
    await m.click('Ask MoMo');
    sendImpl = async () => {
      throw new Error('Sign in to a harness for MoMo.');
    };
    await m.type('Remind me about the bill');
    await m.click('Send to MoMo');
    assert.equal(m.q('[role=alert]')!.textContent, 'Sign in to a harness for MoMo.');
    assert.equal(m.input().value, 'Remind me about the bill');
    await m.click('Send to MoMo');
    await m.type('Remind me about the water bill');
    await m.click('Send to MoMo');
    const ids = calls.filter((c) => c[0] === 'send').map((c) => c[1].id);
    assert.equal(ids[0], ids[1]);
    assert.notEqual(ids[1], ids[2]);
  } finally {
    await m.unmount();
  }
});

test('with ⌘Enter to send, Enter alone doesn’t; while sending, the box waits', async () => {
  state.prefs = { sendWith: 'cmdEnter', followUp: 'steer' };
  const m = await mount();
  try {
    await m.click('Ask MoMo');
    await m.type('hi');
    await m.key({ key: 'Enter' });
    assert.equal(calls.filter((c) => c[0] === 'send').length, 0);
    const pending = deferred<any>();
    sendImpl = () => pending.promise;
    await m.key({ key: 'Enter', metaKey: true });
    assert.equal(m.input().readOnly, true);
    // a second press while one is in flight sends nothing more
    await m.key({ key: 'Enter', metaKey: true });
    assert.equal(calls.filter((c) => c[0] === 'send').length, 1);
    assert.equal(calls.find((c) => c[0] === 'send')![1].followUp, 'steer');
    pending.resolve({ chatId: 'claude:momo-main', note: null });
    await settle();
    assert.equal(m.input().readOnly, false);
  } finally {
    await m.unmount();
  }
});

test('revoked while Quick Chat is open: the target goes at once, a send in flight lands nowhere, and it comes back off', async () => {
  const m = await mount();
  try {
    for (const fails of [true, false]) {
      await m.click('Ask MoMo');
      const pending = deferred<any>();
      sendImpl = () => pending.promise;
      await m.type('Book the dentist');
      await m.click('Send to MoMo');
      await act(async () => update({ allowed: false }));
      assert.equal(m.q('[aria-label="Ask MoMo"]'), null);
      assert.equal(m.q('textarea'), null);
      assert.ok(m.q('[data-quick-chat]'));
      if (fails) pending.reject(Object.assign(new Error('MoMo is not available for this account.'), { code: 'not_allowed' }));
      else pending.resolve({ chatId: 'claude:momo-main', note: 'late' });
      await settle();
      assert.equal(m.q('[role=alert]'), null);
      await act(async () => update({ allowed: true }));
      assert.equal(m.q('[aria-label="Ask MoMo"]')!.getAttribute('aria-pressed'), 'false');
      assert.ok(m.q('[data-quick-chat]'));
    }
  } finally {
    await m.unmount();
  }
});

test('what is dictated while a message is sending stays in the box after it is sent', async () => {
  const m = await mount();
  try {
    await m.click('Ask MoMo');
    const pending = deferred<any>();
    sendImpl = () => pending.promise;
    await m.type('Call mom');
    await m.click('Send to MoMo');
    await m.click('Dictate');
    await m.click('Dictate');
    await settle();
    assert.equal(m.input().value, 'Call mom and the dentist');
    pending.resolve({ chatId: 'claude:momo-main', note: null });
    await settle();
    assert.equal(m.input().value, 'and the dentist');
    assert.equal(calls.find((c) => c[0] === 'send')![1].text, 'Call mom');
  } finally {
    await m.unmount();
  }
});

test('MoMo’s main chat that can’t be read, or opened, says why; a late answer after closing is dropped', async () => {
  chatImpl = async () => {
    throw new Error('MoMo is getting ready.');
  };
  const m = await mount();
  try {
    await m.click('Ask MoMo');
    assert.equal(m.q('[role=alert]')!.textContent, 'MoMo is getting ready.');
    assert.equal(m.q('.quick-chat-empty')!.textContent, '');
    openImpl = async () => {
      throw new Error('The app window was closed');
    };
    await m.click('Open MoMo');
    assert.equal(m.q('[role=alert]')!.textContent, 'The app window was closed');
    openImpl = async () => {};
    await m.click('Open MoMo');
    assert.equal(calls.filter((c) => c[0] === 'open').length, 2);
    // the pane closes before the main chat answers, or before a failure does
    for (const fail of [false, true]) {
      // back to Quick Chat, then MoMo again with its main chat still being made
      await m.click('Ask MoMo');
      const late = deferred<any>();
      chatImpl = () => late.promise;
      await m.click('Ask MoMo');
      const opening = deferred<void>();
      openImpl = () => opening.promise;
      await m.click('Open MoMo');
      await m.click('Ask MoMo');
      if (fail) {
        late.reject(new Error('late'));
        opening.reject(new Error('late'));
      } else {
        late.resolve({ chatId: 'claude:momo-late' });
        opening.resolve();
      }
      await settle();
      assert.equal(m.q('[data-thread]'), null);
      assert.equal(m.q('[role=alert]'), null);
      await m.click('Ask MoMo');
    }
    await m.click('Ask MoMo');
    chatImpl = async () => ({ chatId: 'claude:momo-main' });
    await m.click('Ask MoMo');
    assert.equal(m.q('.quick-chat-empty'), null);
  } finally {
    await m.unmount();
  }
});

test('dictation goes into Ask MoMo’s draft on this Mac, with no recording kept', async () => {
  const m = await mount();
  try {
    await m.click('Ask MoMo');
    await m.click('Dictate');
    await m.click('Dictate');
    await settle();
    assert.equal(m.input().value, 'and the dentist');
    await m.type('Call mom');
    await m.click('Dictate');
    await m.click('Dictate');
    await settle();
    assert.equal(m.input().value, 'Call mom and the dentist');
    assert.deepEqual(
      calls.filter((c) => c[0] === 'transcribe').map((c) => c[4]),
      ['local', 'local'],
    );
    assert.equal(calls.filter((c) => c[0] === 'save').length, 0);
  } finally {
    await m.unmount();
  }
});

test('the main chat’s history is loaded when its id arrives, again for a new one; a load failure says why', async () => {
  const m = await mount();
  try {
    await m.click('Ask MoMo');
    assert.deepEqual(
      calls.filter((c) => c[0] === 'openThread'),
      [['openThread', 'claude:momo-main']],
    );
    sendImpl = async () => ({ chatId: 'codex:momo-next', note: null });
    openThreadImpl = async () => {
      throw new Error('Codex is not running');
    };
    await m.type('hi');
    await m.click('Send to MoMo');
    await settle();
    assert.deepEqual(calls.filter((c) => c[0] === 'openThread').at(-1), ['openThread', 'codex:momo-next']);
    assert.equal(m.q('[role=alert]')!.textContent, 'Codex is not running');
    // a load that fails after the pane closed shows nothing
    const late = deferred<void>();
    openThreadImpl = () => late.promise;
    sendImpl = async () => ({ chatId: 'codex:momo-third', note: null });
    await m.type('again');
    await m.click('Send to MoMo');
    await m.click('Ask MoMo');
    late.reject(new Error('late'));
    await settle();
    assert.equal(m.q('[role=alert]'), null);
  } finally {
    await m.unmount();
  }
});

test('the chat is read-only here: questions and approvals are answered in MoMo, which its note opens', async () => {
  const m = await mount();
  try {
    await m.click('Ask MoMo');
    const view = m.q('[data-thread]')!;
    assert.equal(view.dataset.readonly, 'true');
    assert.match(view.textContent!, /Answer MoMo's questions in MoMo\./);
    await act(async () => (view.querySelector('button') as HTMLButtonElement).click());
    await settle();
    assert.equal(calls.filter((c) => c[0] === 'open').length, 1);
  } finally {
    await m.unmount();
  }
});

test('the header names MoMo’s brain, read-only, and follows a change made in any window (#2288)', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(h(AskMomoBrain)));
  await settle();
  const chip = () => host.querySelector('.ask-momo-brain') as HTMLElement | null;
  assert.equal(chip()!.getAttribute('aria-label'), "MoMo's brain");
  assert.equal(host.querySelector('[data-brain]')!.textContent, 'claude');
  assert.equal(host.querySelector('button'), null, 'nothing to pick here');
  await act(async () => brainListener!({ harness: 'acp:opencode', account: null, model: null, modelLabel: null }));
  assert.equal(host.querySelector('[data-brain]')!.textContent, 'acp:opencode');
  await act(async () => brainListener!(null));
  assert.equal(chip(), null, 'no brain yet: nothing');
  await act(() => root.unmount());
  assert.equal(brainListener, null, 'unsubscribed when the header goes');
  // a brain main can't read shows nothing either
  brainImpl = async () => {
    throw new Error('not_allowed');
  };
  const again = createRoot(host);
  await act(async () => again.render(h(AskMomoBrain)));
  await settle();
  assert.equal(chip(), null);
  await act(() => again.unmount());
  host.remove();
});

test('a sent question shows at once in Quick Chat’s view, moves with a new main chat, goes on failure and once the chat holds it', async () => {
  const m = await mount();
  try {
    await m.click('Ask MoMo');
    await m.type('What drink do I prefer?');
    await m.click('Send to MoMo');
    const id = calls.find((c) => c[0] === 'send')![1].id;
    assert.deepEqual(
      calls.filter((c) => c[0] === 'showAsked'),
      [['showAsked', 'claude:momo-main', id, 'What drink do I prefer?']],
    );
    // the chat now holds the question itself (a read, or a harness that shows it here): the copy goes
    held = [id];
    await act(async () => update({ runtime: { 'claude:momo-main': { turns: [] } } }));
    assert.deepEqual(
      calls.filter((c) => c[0] === 'dropAsked'),
      [['dropAsked', 'claude:momo-main', id]],
    );
    // a brain change moved MoMo meanwhile: the copy moves to the new chat
    calls.length = 0;
    held = [];
    sendImpl = async () => ({ chatId: 'acp:momo-new', note: null });
    await m.type('And food?');
    await m.click('Send to MoMo');
    const id2 = calls.find((c) => c[0] === 'send')![1].id;
    assert.deepEqual(
      calls.filter((c) => c[0] === 'showAsked' || c[0] === 'dropAsked'),
      [
        ['showAsked', 'claude:momo-main', id2, 'And food?'],
        ['dropAsked', 'claude:momo-main', id2],
        ['showAsked', 'acp:momo-new', id2, 'And food?'],
      ],
    );
    // not sent: the copy goes and the text stays in the box
    calls.length = 0;
    sendImpl = async () => {
      throw new Error('MoMo is busy');
    };
    await m.type('Later?');
    await m.click('Send to MoMo');
    const id3 = calls.find((c) => c[0] === 'send')![1].id;
    assert.deepEqual(
      calls.find((c) => c[0] === 'dropAsked'),
      ['dropAsked', 'acp:momo-new', id3],
    );
    assert.equal(m.input().value, 'Later?');
  } finally {
    await m.unmount();
  }
});
