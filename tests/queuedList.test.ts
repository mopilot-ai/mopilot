// The queue tray above the composer (src/components/composer/QueuedList.tsx), rendered with happy-dom.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mockSource, stubStore } from './support/stubs.ts';

const calls: unknown[][] = [];
mockSource('src/components/pages/settings/Connections.tsx', {
  openSshTerminal: () => assert.fail('The queue renderer must not open a terminal.'),
});
let queue: any[] = [];
// the chat's turn phase: a turn is running unless a test says otherwise
let turn = 'running';
let removed = true;
// what removing a message throws
let removeError: unknown = null;
let delivery: () => any = () => ({ status: 'sent' });
const notices: any[] = [];
// how the chat's meta shows an input no human wrote (src/lib/authoredInput.ts)
let authoredInputs: Record<string, any> = {};
mock.module('../src/store/session/useSession.ts', {
  namedExports: {
    flushSessionPatches: () => {},
    useSession: () => ({ queue, turn }),
    useSessionField: (id: any, pick: any) => pick(((() => ({ queue, turn })) as (id: any) => any)(id)),
  },
});
stubStore({
  removeQueued: async (t: string, id: string) => {
    calls.push(['remove', t, id]);
    if (removeError) throw removeError;
    return removed;
  },
  sendQueuedNow: (t: string, id: string) => {
    calls.push(['steer', t, id]);
    return delivery();
  },
  toast: (...args: any[]) => notices.push(args),
  useStore: (sel: (s: any) => unknown) => sel({ authoredInputs }),
});
// copying confirms only after the write (src/session/clipboard.ts, tests/clipboard.test.ts)
mock.module('../src/session/clipboard.ts', {
  namedExports: { copyText: (t: string, done: unknown) => calls.push(['copy', t, done]) },
});
const { createElement, act, StrictMode } = await import('react');
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { QueuedList } = await import('../src/components/composer/QueuedList.tsx');

const msg = (id: string, text: string, attachments: any[] = [], waitingFor?: string) => ({
  id,
  text,
  attachments,
  opts: {},
  origin: null,
  queuedAt: 0,
  ...(waitingFor ? { waitingFor } : {}),
});
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement;
async function render(props: Record<string, unknown>) {
  host ??= document.createElement('div');
  if (!host.isConnected) document.body.append(host);
  root ??= createRoot(host);
  await act(async () => root!.render(createElement(QueuedList, { threadId: 'chat', ...props } as any)));
}
const click = async (el: Element | null | undefined) => {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
};
const menuItem = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((e) => e.textContent!.includes(name));
const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent);
const q$ = <T extends Element = HTMLButtonElement>(sel: string) => host.querySelector<T>(sel)!;
const contextMenu = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }));
  });
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = undefined as any;
  calls.length = 0;
  removed = true;
  removeError = null;
  delivery = () => ({ status: 'sent' });
  notices.length = 0;
  authoredInputs = {};
  turn = 'running';
});

test('an empty queue renders nothing; each message is its own row with the glyph, its text, Steer, Remove and ⋯', async () => {
  queue = [];
  await render({});
  assert.equal(host.innerHTML, '');
  queue = [msg('m1', 'First', [], 'compaction'), msg('m2', 'Second'), msg('m3', 'Third', [], 'compactionRetry')];
  await render({ onEdit: () => {} });
  const list = q$('.queue-tray > .queue-list');
  assert.equal(list.getAttribute('role'), 'list');
  assert.equal(list.getAttribute('aria-label'), 'Queued messages');
  assert.deepEqual(
    [...host.querySelectorAll('.queue-list > .queue-row')].map((r) => [
      r.getAttribute('role'),
      r.querySelector('.queue-text')!.textContent,
    ]),
    [
      ['listitem', 'Will send after compaction · First'],
      ['listitem', 'Second'],
      ['listitem', 'Retry when ready · Third'],
    ],
  );
  // no count header, no fold: the rows are the tray
  assert.equal(host.querySelector('.queue-count, .queue-fold, .queue-clear'), null);
  const row = host.querySelectorAll('.queue-row')[1];
  assert.ok(row.querySelector('svg.queue-icon'));
  assert.equal(row.querySelector('.queue-text')!.getAttribute('title'), 'Second');
  assert.deepEqual(
    [...row.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent),
    ['Preview queued message: Second', 'Steer', 'Remove from queue', 'Queued message actions'],
  );
  // the one held for a compaction retry offers Retry instead
  assert.deepEqual(
    [...host.querySelectorAll('.queue-steer')].map((b) => b.textContent),
    ['Steer', 'Steer', 'Retry'],
  );
  await click(row.querySelector('.queue-steer'));
  await click(row.querySelector('[aria-label="Remove from queue"]'));
  assert.deepEqual(calls, [
    ['steer', 'chat', 'm2'],
    ['remove', 'chat', 'm2'],
  ]);
});

test('with no turn running the row says Send, not Steer (#2503)', async () => {
  queue = [msg('m1', 'First'), msg('m2', 'Second', [], 'compactionRetry')];
  turn = 'crashed';
  await render({});
  assert.deepEqual(
    [...host.querySelectorAll('.queue-steer')].map((b) => b.textContent),
    ['Send', 'Retry'],
  );
  turn = 'idle';
  await render({});
  assert.equal(q$('.queue-steer').textContent, 'Send');
  turn = 'awaitingUser';
  await render({});
  assert.equal(q$('.queue-steer').textContent, 'Steer');
});

test('without an editor (Mini) the menu offers no Edit; an attachment-only message shows its file', async () => {
  queue = [msg('a', '', [{ kind: 'file', path: '/w/a.txt', name: 'a.txt' }])];
  await render({});
  assert.equal(q$('.queue-text').textContent, 'a.txt');
  await contextMenu(q$('.queue-row'));
  assert.deepEqual(menuItems(), ['Copy']);
});

test('⋯ and a right-click open the same menu: Edit message and Copy', async () => {
  queue = [msg('m1', 'First'), msg('m2', 'Second')];
  const edited: unknown[] = [];
  await render({ onEdit: (q: unknown) => edited.push(q) });
  const [row1, row2] = host.querySelectorAll('.queue-row');
  const more = row2.querySelector<HTMLButtonElement>('[aria-label="Queued message actions"]')!;
  assert.equal(more.getAttribute('aria-haspopup'), 'menu');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  await click(more);
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.ok(more.classList.contains('on'));
  assert.ok(row2.classList.contains('menu-open'));
  assert.ok(!row1.classList.contains('menu-open'));
  assert.deepEqual(menuItems(), ['Edit message', 'Copy']);
  await click(menuItem('Copy'));
  assert.deepEqual(calls, [['copy', 'Second', 'Copied message']]);
  assert.ok(!row2.classList.contains('menu-open'));
  calls.length = 0;
  // a right-click on the row opens it at the pointer, without the system menu
  let prevented = false;
  await act(async () => {
    const e = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
    row1.dispatchEvent(e);
    prevented = e.defaultPrevented;
  });
  assert.ok(prevented);
  assert.ok(row1.classList.contains('menu-open'));
  await click(menuItem('Edit message'));
  assert.deepEqual(calls, [['remove', 'chat', 'm1']]);
  assert.deepEqual(edited, [queue[0]]);
  // the ⋯ after a right-click opens at its button again, and toggles closed
  await click(row1.querySelector('[aria-label="Queued message actions"]'));
  assert.ok(row1.classList.contains('menu-open'));
  await click(row1.querySelector('[aria-label="Queued message actions"]'));
  assert.ok(!row1.classList.contains('menu-open'));
});

test('a right-click inside the open menu stays the menu’s own; Shift-F10 or the Context Menu key opens it from the keyboard', async () => {
  queue = [msg('m1', 'First')];
  await render({});
  const row = q$('.queue-row');
  const more = row.querySelector<HTMLButtonElement>('[aria-label="Queued message actions"]')!;
  await click(more);
  // React bubbles events from the portaled menu to the row: not reopened at the pointer, not suppressed
  let prevented = true;
  await act(async () => {
    const e = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1, clientY: 2 });
    menuItem('Copy')!.dispatchEvent(e);
    prevented = e.defaultPrevented;
  });
  assert.equal(prevented, false);
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  await click(more);
  const key = (init: Record<string, unknown>) =>
    act(async () => {
      more.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    });
  await key({ key: 'F10' });
  await key({ key: 'a', shiftKey: true });
  assert.ok(!row.classList.contains('menu-open'), 'other keys are the button’s');
  await key({ key: 'F10', shiftKey: true });
  assert.ok(row.classList.contains('menu-open'));
  await click(menuItem('Copy'));
  await key({ key: 'ContextMenu' });
  assert.ok(row.classList.contains('menu-open'));
});

test('editing gives the message back only once it has left the queue', async () => {
  queue = [msg('q1', 'pull me back')];
  const edited: unknown[] = [];
  await render({ onEdit: (q: unknown) => edited.push(q) });
  // already sent or removed elsewhere: nothing comes back
  removed = false;
  await contextMenu(q$('.queue-row'));
  await click(menuItem('Edit message'));
  assert.deepEqual(calls, [['remove', 'chat', 'q1']]);
  assert.equal(edited.length, 0);
  removed = true;
  await contextMenu(q$('.queue-row'));
  await click(menuItem('Edit message'));
  assert.deepEqual(edited, [queue[0]]);
});

test('Steer waits for delivery, blocks duplicate clicks and reports actual retained or missing results', async () => {
  queue = [msg('q', 'Please steer')];
  let release!: (value: any) => void;
  delivery = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  await render({ onEdit: () => {} });
  const send = () => q$('.queue-steer');
  assert.equal(send().getAttribute('aria-busy'), null);
  await act(() => {
    send().click();
    send().click();
  });
  assert.equal(calls.length, 1);
  assert.equal(send().disabled, true);
  assert.equal(send().getAttribute('aria-busy'), 'true');
  assert.ok(q$('.queue-row').classList.contains('queue-sending'));
  assert.equal(q$('[aria-label="Remove from queue"]').disabled, true);
  // the menu still copies, but edits nothing while sending
  await contextMenu(q$('.queue-row'));
  assert.deepEqual(
    ['Edit message', 'Copy'].map((n) => menuItem(n)!.getAttribute('aria-disabled') === 'true'),
    [true, false],
  );
  await click(menuItem('Copy'));
  calls.length = 0;
  await act(async () => release({ status: 'queued', error: 'turn refused' }));
  assert.equal(send().disabled, false);
  assert.equal(send().getAttribute('aria-busy'), null);
  assert.ok(!q$('.queue-row').classList.contains('queue-sending'));
  assert.deepEqual(notices.pop(), ['Message kept in queue: Turn refused.', 'error']);
  for (const [result, expected] of [
    [{ status: 'queued' }, ['Message moved to the front of the queue. It will send after the current turn.', 'info']],
    [{ status: 'queued', waitingFor: 'compaction' }, ['Message queued. It will send after compaction finishes.', 'info']],
    [{ status: 'queued', waitingFor: 'compactionRetry' }, ['Message kept in the queue. Retry when you’re ready.', 'info']],
    [{ status: 'missing' }, ['This message is no longer in the queue.', 'error']],
    [{ status: 'failed', error: 'peer refused' }, ['Could not send queued message: Peer refused.', 'error']],
    [{ status: 'failed' }, ['Could not send queued message: The harness did not accept the message.', 'error']],
    [{ status: 'sent' }, null],
  ] as const) {
    delivery = () => result;
    await click(send());
    assert.deepEqual(notices.pop() ?? null, expected);
  }
  delivery = () => Promise.reject(new Error('bridge disconnected'));
  await click(send());
  assert.deepEqual(notices.pop(), ['Could not send queued message: Bridge disconnected.', 'error']);
  for (const [error, line] of [
    ['plain failure', 'Plain failure.'],
    [null, 'Something went wrong.'],
    // a sentence, never the system code or the path (#1863)
    [new Error("ENOENT: no such file or directory, open '/tmp/x'"), 'File or program not found.'],
  ] as const) {
    delivery = () => Promise.reject(error);
    await click(send());
    assert.deepEqual(notices.pop(), [`Could not send queued message: ${line}`, 'error']);
  }
  assert.equal(send().disabled, false);
  assert.equal(q$('.queue-text').textContent, 'Please steer');
});

test('a failed removal says so; a recovery callback failure after removal is reported without retrying either effect', async () => {
  queue = [msg('q1', 'accepted')];
  let recoveries = 0;
  await render({
    onEdit: () => {
      recoveries++;
      throw new Error('recovery failed');
    },
  });
  await contextMenu(q$('.queue-row'));
  await click(menuItem('Edit message'));
  assert.deepEqual(calls, [['remove', 'chat', 'q1']]);
  assert.equal(recoveries, 1);
  assert.deepEqual(notices, [['Message removed, but could not restore its draft: Recovery failed.', 'error']]);
  notices.length = 0;
  removeError = new Error('queue locked');
  await click(q$('[aria-label="Remove from queue"]'));
  assert.deepEqual(notices, [['Could not remove queued message: Queue locked.', 'error']]);
});

test('a row queued while the tray shows rises in; a removed row drops away for its exit; reduced motion keeps none', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    queue = [msg('q1', 'already there'), msg('q2', 'also there')];
    await render({});
    const classes = () => [...host.querySelectorAll('.queue-row')].map((r) => r.className);
    assert.deepEqual(classes(), ['queue-row', 'queue-row'], 'there when the chat opened: no entrance');
    queue = [msg('q1', 'already there'), msg('q2', 'also there'), msg('q3', 'queued now')];
    await render({});
    assert.deepEqual(classes(), ['queue-row', 'queue-row', 'queue-row queue-enter']);
    const firstRow = host.querySelector('.queue-row')!;
    queue = [msg('q2', 'also there'), msg('q3', 'queued now')];
    await render({});
    assert.deepEqual(classes(), ['queue-row queue-leaving', 'queue-row', 'queue-row queue-enter']);
    const gone = host.querySelector('.queue-leaving')!;
    // the same element, so its opacity and translate transition from where it was (a remounted one would start hidden)
    assert.equal(gone, firstRow);
    assert.equal(gone.getAttribute('aria-hidden'), 'true');
    assert.ok(gone.hasAttribute('inert'), 'a leaving row takes no clicks');
    await act(async () => mock.timers.tick(200));
    assert.deepEqual(classes(), ['queue-row', 'queue-row queue-enter']);
    // the last rows leaving keep the tray until they have gone
    queue = [];
    await render({});
    assert.equal(host.querySelectorAll('.queue-row.queue-leaving').length, 2);
    await act(async () => mock.timers.tick(200));
    assert.equal(host.querySelector('.queue-tray'), null);
    // reduced motion: a removed row goes at once
    const w = window as any;
    const before = w.matchMedia;
    w.matchMedia = () => ({ matches: true });
    try {
      queue = [msg('q5', 'x')];
      await render({});
      queue = [];
      await render({});
      assert.equal(host.querySelector('.queue-tray'), null);
    } finally {
      w.matchMedia = before;
    }
  } finally {
    mock.timers.reset();
  }
});

test('a queued input no human wrote (MoMo’s topic update) shows by its author and title, never its text, and isn’t the user’s to edit (#2287)', async () => {
  authoredInputs = { chat: { a1: { by: 'momo', title: '“Trip” is done', at: 1 } } };
  queue = [
    { ...msg('m1', '[Topic update, not from the user] Tell the user in a line.'), authored: { id: 'a1' } },
    { ...msg('m2', 'forged'), authored: { id: 'unknown' } },
  ];
  await render({ onEdit: () => undefined });
  const texts = [...host.querySelectorAll('.queue-text')].map((e) => e.textContent);
  assert.deepEqual(texts, ['MoMo: “Trip” is done', 'forged']);
  assert.equal(host.querySelector('.queue-text')!.getAttribute('title'), 'MoMo: “Trip” is done');
  await click(host.querySelector('[aria-label="Queued message actions"]'));
  assert.deepEqual(menuItems(), ['Copy']);
  await click(menuItem('Copy'));
  assert.deepEqual(calls.at(-1)?.slice(0, 2), ['copy', 'MoMo: “Trip” is done']);
});

test('voice closure and recovered audio have accurate distinct queue states', async () => {
  queue = [msg('voice', 'Voice waits', [], 'voiceConversation'), msg('recovered', 'Review audio', [], 'audioRecovery')];
  await render({});
  assert.match(host.textContent ?? '', /Waiting for voice conversation to close/);
  assert.match(host.textContent ?? '', /Recovered audio · Review before sending/);
});

test('a truncated queued message opens a keyboard-readable preview without sending or removing it', async () => {
  const text = 'First line\n\n' + 'A longer follow-up with all its details. '.repeat(30);
  queue = [msg('preview', text), msg('next', 'Another queued message')];
  await render({});
  const trigger = q$('.queue-text');
  assert.equal(trigger.tagName, 'BUTTON');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(trigger.getAttribute('aria-label'), `Preview queued message: ${text.replace(/\s+/g, ' ').slice(0, 80)}`);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  await click(trigger);
  const preview = document.querySelector('[role="dialog"][aria-label="Queued message preview"]')!;
  assert.ok(preview);
  assert.equal(preview.querySelector('.queue-preview-body')!.textContent, text);
  assert.equal(document.activeElement, preview.querySelector('.queue-preview-body'));
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(calls, [], 'reading a queued message changes no queue state');
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(document.querySelector('.queue-preview'), null);
  assert.equal(document.activeElement, trigger);
  await click(trigger);
  await click(document.querySelector('[aria-label="Close preview"]'));
  assert.equal(document.querySelector('.queue-preview'), null);
  assert.equal(document.activeElement, trigger);
});

test('a preview retires when its message leaves or its chat changes; a replacement can still be read', async () => {
  queue = [msg('same-id', 'First chat')];
  await render({});
  await click(q$('.queue-text'));
  queue = [];
  await render({});
  assert.equal(document.querySelector('.queue-preview'), null, 'leaving rows cannot keep an interactive preview');
  queue = [msg('same-id', 'First chat')];
  await render({});
  await click(q$('.queue-text'));
  assert.ok(document.querySelector('.queue-preview'));
  queue = [msg('same-id', 'Second chat')];
  await render({ threadId: 'other-chat' });
  assert.equal(document.querySelector('.queue-preview'), null, 'a reused queue id does not carry a preview between chats');
  await click(q$('.queue-text'));
  assert.equal(document.querySelector('.queue-preview-body')!.textContent, 'Second chat');
  await act(async () => document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
  assert.equal(document.querySelector('.queue-preview'), null);
  assert.deepEqual(calls, []);
});

for (const [surface, field] of [
  ['composer-wrap', 'composer-input'],
  ['quick-chat-compose', 'quick-chat-input'],
])
  test(`retiring a focused preview in ${surface} preserves its live queue, composer, newer focus and chat`, async () => {
    queue = [msg('one', 'First'), msg('two', 'Second')];
    await render({});
    const scope = document.createElement('div');
    scope.className = surface;
    scope.dataset.composerChat = 'chat';
    host.before(scope);
    const input = document.createElement('textarea');
    input.className = field;
    scope.append(host, input);
    try {
      await click(q$('.queue-text'));
      (document.querySelector('[aria-label="Close preview"]') as HTMLElement).focus();
      queue = [queue[1]];
      await render({});
      assert.equal(document.activeElement, host.querySelector('.queue-row:not([inert]) .queue-text'));
      await click(host.querySelector('.queue-row:not([inert]) .queue-text'));
      queue = [];
      await render({});
      assert.equal(document.activeElement, input);
      queue = [msg('three', 'Third')];
      await render({});
      await click(host.querySelector('.queue-row:not([inert]) .queue-text'));
      await act(async () => {
        queue = [];
        flushSync(() => root!.render(createElement(QueuedList, { threadId: 'chat' })));
        input.focus();
      });
      assert.equal(document.activeElement, input, 'a newer focus wins over deferred recovery');
      queue = [msg('four', 'Fourth')];
      await render({});
      await click(host.querySelector('.queue-row:not([inert]) .queue-text'));
      input.focus();
      queue = [];
      await render({});
      assert.equal(document.activeElement, input, 'retiring an unfocused preview does not steal focus');
      queue = [msg('old', 'Old chat')];
      await render({});
      await click(host.querySelector('.queue-row:not([inert]) .queue-text'));
      scope.dataset.composerChat = 'different-chat';
      queue = [];
      await render({ threadId: 'different-chat' });
      assert.notEqual(document.activeElement, input, 'a new chat owns its own focus');
    } finally {
      scope.before(host);
      scope.remove();
    }
  });

test('a Strict Mode preview keeps its keyboard focus through setup, cleanup and setup', async () => {
  queue = [msg('strict', 'Read the full prompt')];
  await render({});
  await act(async () => root!.render(createElement(StrictMode, null, createElement(QueuedList, { threadId: 'chat' }))));
  await click(host.querySelector('.queue-row:not([inert]) .queue-text'));
  assert.equal(document.activeElement, document.querySelector('.queue-preview-body'));
});
