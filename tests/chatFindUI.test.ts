// The chat's find bar in the DOM: the ranges a term covers in rendered prompts and replies, the page's highlights for
// every open find, stepping between matches (a turn not rendered is jumped to first), and which view ⌘F opens it in.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { animationFrames } from './support/animationFrames.ts';
import { createElement as h, useRef } from 'react';

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { findRanges, showFindHighlights } = await import('../src/components/thread/view/chatFindRanges.ts');
const { ChatFind, useChatFindRequest } = await import('../src/components/thread/view/ChatFind.tsx');
const { navigationItems } = await import('../src/session/threadNavigation.ts');

// the page's highlights, as Chromium keeps them
class FakeHighlight {
  ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}
const highlights = new Map<string, FakeHighlight>();
let paints = 0;
const registry = {
  set: (name: string, value: FakeHighlight) => (paints++, highlights.set(name, value)),
  delete: (name: string) => (paints++, highlights.delete(name)),
};
const css = (globalThis as any).CSS;
const roots = new Set<ReturnType<typeof createRoot>>();
let clock: ReturnType<typeof animationFrames>;
beforeEach(() => {
  clock = animationFrames();
  highlights.clear();
  paints = 0;
  (globalThis as any).CSS = { highlights: registry };
  (globalThis as any).Highlight = FakeHighlight;
});
afterEach(async () => {
  try {
    await act(() => {
      for (const root of roots) root.unmount();
    });
    assert.equal(highlights.size, 0, 'Every mounted find must release its highlight owner');
  } finally {
    roots.clear();
    clock.restore();
    (globalThis as any).CSS = css;
    delete (globalThis as any).Highlight;
    document.body.innerHTML = '';
  }
});
const texts = (name: string) => highlights.get(name)?.ranges.map((r) => r.toString()) ?? [];
function mountRoot(host: HTMLElement) {
  const root = createRoot(host);
  roots.add(root);
  return root;
}

/** A rendered turn as TurnView draws it: the user's words, chrome, and the reply's Markdown. */
function turnEl(id: string, said: string, replyHtml: string) {
  const el = document.createElement('div');
  el.className = 'turn';
  el.dataset.turnId = id;
  el.innerHTML = `<div class="user-message"><div class="user-bubble"><div class="fold-text">${said}</div></div><button>cache</button></div><div class="work">cache</div><div class="assistant-message"><div class="md">${replyHtml}</div></div>`;
  return el;
}

test('ranges follow the rendered text across elements, by turn, leaving chrome and unowned text out', () => {
  const root = document.createElement('div');
  root.append(
    turnEl(
      't1',
      'Where is the Cache?',
      '<p>The <strong>ca</strong>che 😀x lives</p><div class="code-header"><span>cache</span></div><pre>cache</pre>',
    ),
  );
  // a region outside any turn is no reply of the chat's
  const stray = document.createElement('div');
  stray.innerHTML = '<div class="user-message"><div class="fold-text">cache</div></div>';
  root.append(stray);
  document.body.append(root);
  const ranges = findRanges(root, 'cache');
  assert.deepEqual([...ranges.keys()], ['t1']);
  assert.deepEqual(
    ranges.get('t1')!.map((r) => r.toString()),
    ['Cache', 'cache', 'cache'],
  );
  // an end just past a character outside the basic plane takes both of its units
  assert.deepEqual(
    findRanges(root, 'che 😀')
      .get('t1')!
      .map((r) => r.toString()),
    ['che 😀'],
  );
  assert.equal(findRanges(root, '').size, 0);
});

test("every open find shares the page's highlights, its current match set apart, and clearing one keeps the others", () => {
  const a = document.createRange();
  const b = document.createRange();
  const c = document.createRange();
  const one = {};
  const two = {};
  try {
    showFindHighlights(one, { all: [a, b], current: b });
    showFindHighlights(two, { all: [c], current: null });
    assert.deepEqual(highlights.get('chat-find')!.ranges, [a, c]);
    assert.deepEqual(highlights.get('chat-find-current')!.ranges, [b]);
    showFindHighlights(one, null);
    assert.deepEqual(highlights.get('chat-find')!.ranges, [c]);
    assert.equal(highlights.has('chat-find-current'), false);
    showFindHighlights(two, null);
    assert.equal(highlights.size, 0);
    // clearing a find that shows nothing paints nothing
    const before = paints;
    showFindHighlights(two, null);
    assert.equal(paints, before);
    // a page without the highlight API still finds; it just draws no highlight
    (globalThis as any).CSS = {};
    showFindHighlights(one, { all: [a], current: a });
    showFindHighlights(one, null);
  } finally {
    showFindHighlights(one, null);
    showFindHighlights(two, null);
  }
});

const user = (id: string, text: string) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] });
const reply = (id: string, text: string) => ({ id, type: 'agentMessage', text, phase: 'final_answer' });
const turn = (id: string, said: string, answer: string) =>
  ({ id, status: 'completed', items: [user(`${id}u`, said), reply(`${id}a`, answer)] }) as any;
const frame = () => act(() => clock.frame());
const flush = async () => {
  await act(async () => {});
  for (let delivered = 0; clock.pending; delivered++) {
    assert.ok(delivered < 10, 'Find must settle its queued animation frames');
    await frame();
  }
};

async function mountFind(options: { rendered?: string[]; hasOlder?: boolean; loadingOlder?: boolean; turns?: any[] } = {}) {
  const turns = options.turns ?? [
    turn('t1', 'Where is the cache?', 'The **cache** is here'),
    turn('t2', 'thanks', 'You are welcome'),
    turn('t3', 'cache key?', 'key'),
  ];
  const scroll = document.createElement('div');
  scroll.className = 'thread-scroll';
  const rendered = new Set(options.rendered ?? ['t1', 't2', 't3']);
  for (const t of turns)
    if (rendered.has(t.id) && t.items.length > 1)
      scroll.append(turnEl(t.id, t.items[0].content[0].text, t.items[1].text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')));
  const host = document.createElement('div');
  document.body.append(scroll, host);
  const calls: string[] = [];
  const root = mountRoot(host);
  const props = (extra: object = {}) => ({
    turns,
    scrollRef: { current: scroll },
    hasOlder: !!options.hasOlder,
    loadingOlder: !!options.loadingOlder,
    focusKey: 1,
    onNavigate: (id: string) => calls.push(`navigate:${id}`),
    onLoadOlder: async () => void calls.push('older'),
    onClose: () => calls.push('close'),
    ...extra,
  });
  await act(() => root.render(h(ChatFind, props())));
  const input = host.querySelector<HTMLInputElement>('.chat-find-input')!;
  const type = async (value: string, settle = true) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }) as any);
    });
    if (settle) await flush();
  };
  const press = async (key: string, init: KeyboardEventInit = {}) => {
    await act(async () => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...(init as object) }) as any);
    });
    await flush();
  };
  const click = async (label: string) => {
    await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
    await flush();
  };
  const count = () => host.querySelector('.chat-find-count')!.textContent;
  return { turns, scroll, host, root, input, type, press, click, count, calls, props, rendered };
}

test('a term counts its matches in prompts and replies, starts at the newest, and Enter and the arrows go round', async () => {
  const view = await mountFind();
  assert.equal(document.activeElement, view.input);
  assert.equal(view.count(), '');
  await view.type('CACHE');
  assert.equal(view.count(), '3 of 3');
  // the newest match is current: the prompt of the last turn
  assert.deepEqual(texts('chat-find-current'), ['cache']);
  assert.equal(
    highlights.get('chat-find-current')!.ranges[0].startContainer.parentElement!.closest('.turn')!.getAttribute('data-turn-id'),
    't3',
  );
  assert.deepEqual(texts('chat-find'), ['cache', 'cache']);
  await view.press('Enter');
  assert.equal(view.count(), '1 of 3');
  await view.press('Enter', { shiftKey: true });
  assert.equal(view.count(), '3 of 3');
  await view.click('Previous match');
  assert.equal(view.count(), '2 of 3');
  // the reply's match is current now, inside its bold text
  assert.equal(highlights.get('chat-find-current')!.ranges[0].startContainer.parentElement!.tagName, 'STRONG');
  await view.click('Next match');
  assert.equal(view.count(), '3 of 3');
  // a key an input method is composing with is the input method's
  await view.press('Enter', { isComposing: true } as KeyboardEventInit);
  assert.equal(view.count(), '3 of 3');
  await view.type('nowhere');
  assert.equal(view.count(), 'No results');
  assert.equal(view.host.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!.disabled, true);
  await view.press('Enter');
  assert.equal(view.count(), 'No results');
  assert.equal(highlights.size, 0);
  await view.press('Escape');
  assert.deepEqual(view.calls, ['close']);
  // closing takes the highlights away
  await view.type('cache');
  assert.equal(highlights.size, 2);
  await act(() => view.root.unmount());
  assert.equal(highlights.size, 0);
});

test('a match in a turn the window has not rendered jumps there first, and is set apart once it renders', async () => {
  const view = await mountFind({ rendered: ['t2'] });
  await view.type('cache');
  const [, , third] = navigationItems(view.turns);
  assert.deepEqual(view.calls, [`navigate:${third.id}`]);
  assert.equal(view.count(), '3 of 3');
  assert.equal(highlights.size, 0);
  // the turn renders (the jump pinned it): the next frame finds and scrolls to it
  view.scroll.getBoundingClientRect = () => ({ top: 0, bottom: 300, height: 300 }) as DOMRect;
  const ranges = window.Range.prototype as any;
  const rangeBox = ranges.getBoundingClientRect;
  ranges.getBoundingClientRect = () => ({ top: 900, bottom: 920 }) as DOMRect;
  try {
    await act(async () => view.scroll.append(turnEl('t3', 'cache key?', 'key')));
    await frame();
    assert.deepEqual(texts('chat-find-current'), ['cache']);
    assert.equal(view.scroll.scrollTop, 0, 'Painting queues the scroll for the following frame');
    assert.equal(clock.pending, 1);
    await frame();
    assert.equal(view.scroll.scrollTop, 800);
    // it is scrolled to once: a streamed change repaints without moving the view
    view.scroll.scrollTop = 10;
    await act(async () => view.scroll.append(document.createElement('div')));
    await flush();
    assert.equal(view.scroll.scrollTop, 10);
  } finally {
    ranges.getBoundingClientRect = rangeBox;
  }
  // a match already in view is not scrolled to
  ranges.getBoundingClientRect = () => ({ top: 100, bottom: 120 }) as DOMRect;
  try {
    await act(async () => view.scroll.prepend(turnEl('t1', 'Where is the cache?', 'The <strong>cache</strong> is here')));
    await view.press('Enter');
    assert.equal(view.count(), '1 of 3');
    assert.equal(view.scroll.scrollTop, 10);
  } finally {
    ranges.getBoundingClientRect = rangeBox;
  }
  await act(() => view.root.unmount());
});

test('a test that leaves its find mounted still retires its highlight owner during cleanup', async () => {
  const view = await mountFind();
  await view.type('cache');
  assert.equal(highlights.size, 2);
  // Deliberately omit success-path unmount: afterEach must own cleanup after an early return or failed assertion too.
});

test('a turn on screen counts what it draws, one off screen its data, and a current match it no longer draws falls to its last', async () => {
  // a wake no one typed in: nothing to jump to, so it counts only while drawn
  const woken = { id: 'w', status: 'completed', items: [reply('wa', 'cache')] } as any;
  const turns = [turn('t1', 'Where is the cache?', 'The **cache** is here'), woken, turn('t3', 'cache key?', 'key')];
  const view = await mountFind({ rendered: [], turns });
  await view.type('cache');
  assert.equal(view.count(), '3 of 3');
  const [first] = navigationItems(turns);
  await view.click('Previous match');
  assert.equal(view.count(), '2 of 3');
  assert.equal(view.calls.at(-1), `navigate:${first.id}`);
  // t1 renders without its reply's match (a link's address, say): its count is what it draws, and the current match,
  // its second, falls to its last
  await act(async () => view.scroll.append(turnEl('t1', 'Where is the cache?', 'The thing is here')));
  await flush();
  assert.equal(view.count(), '1 of 2');
  assert.deepEqual(texts('chat-find-current'), ['cache']);
  // the wake renders (unfolded): its reply counts and is highlighted
  const wake = document.createElement('div');
  wake.className = 'turn';
  wake.dataset.turnId = 'w';
  wake.innerHTML = '<div class="assistant-message"><div class="md">cache</div></div>';
  await act(async () => view.scroll.append(wake));
  await flush();
  assert.equal(view.count(), '1 of 3');
  assert.equal(texts('chat-find').length, 1);
  await act(() => view.root.unmount());
});

test('a match inside a long prompt folded behind Show more unfolds it, then goes there', async () => {
  const view = await mountFind({ rendered: [] });
  view.scroll.append(turnEl('t3', 'cache key?', 'key'));
  const fold = view.scroll.querySelector('.fold-text')!;
  fold.classList.add('clamped');
  const more = document.createElement('button');
  more.className = 'fold-more';
  more.textContent = 'Show more';
  more.onclick = () => {
    fold.classList.remove('clamped');
    more.textContent = 'Show less';
  };
  fold.after(more);
  view.scroll.getBoundingClientRect = () => ({ top: 0, bottom: 300, height: 300 }) as DOMRect;
  const ranges = window.Range.prototype as any;
  const rangeBox = ranges.getBoundingClientRect;
  ranges.getBoundingClientRect = () => ({ top: 20, bottom: 40 }) as DOMRect;
  try {
    await view.type('cache');
    await flush();
    assert.equal(more.textContent, 'Show less');
    // under the bar at the top: scrolled down into view
    assert.equal(view.scroll.scrollTop, -80);
  } finally {
    ranges.getBoundingClientRect = rangeBox;
  }
  await act(() => view.root.unmount());
});

test('with earlier history unloaded, Search earlier loads it; asking again focuses the field and selects its term', async () => {
  const view = await mountFind({ hasOlder: true });
  const older = () => view.host.querySelector<HTMLButtonElement>('.chat-find-older')!;
  assert.equal(older().textContent, 'Search earlier');
  await view.type('cache');
  view.scroll.scrollTop = 500;
  view.scroll.getBoundingClientRect = () => ({ top: 0, bottom: 300, height: 300 }) as DOMRect;
  const ranges = window.Range.prototype as any;
  const rangeBox = ranges.getBoundingClientRect;
  ranges.getBoundingClientRect = () => ({ top: 700, bottom: 720 }) as DOMRect;
  try {
    await act(async () => older().click());
    await flush();
  } finally {
    ranges.getBoundingClientRect = rangeBox;
  }
  assert.deepEqual(view.calls, ['older']);
  // the page went in where the last jump left it: the current match is gone to again
  assert.equal(view.scroll.scrollTop, 1100);
  await act(() => view.root.render(h(ChatFind, view.props({ hasOlder: true, loadingOlder: true }))));
  assert.equal(older().textContent, 'Loading…');
  assert.equal(older().disabled, true);
  view.input.blur();
  await act(() => view.root.render(h(ChatFind, view.props({ focusKey: 2, hasOlder: false }))));
  assert.equal(document.activeElement, view.input);
  assert.equal(view.input.selectionStart, 0);
  assert.equal(view.input.selectionEnd, 5);
  assert.equal(view.host.querySelector('.chat-find-older'), null);
  await act(() => view.root.unmount());
});

test('⌘F opens find in the view of the chat holding focus, else its first view, and closing gives focus back', async () => {
  const state: Record<string, { focusKey: number | null; close: () => void }> = {};
  function View({ name, threadId }: { name: string; threadId: string }) {
    const scrollRef = useRef<HTMLDivElement>(null);
    state[name] = useChatFindRequest(threadId, scrollRef);
    return h(
      'div',
      { className: 'thread-view', 'data-thread-id': threadId },
      h('div', { ref: scrollRef, tabIndex: 0, className: 'scroll' }),
      h('input', { className: name }),
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = mountRoot(host);
  const render = (second = 'a') =>
    act(() => root.render(h('div', null, h(View, { name: 'one', threadId: 'a' }), h(View, { name: 'two', threadId: second }))));
  await render();
  const find = (threadId: string) =>
    act(async () => window.dispatchEvent(new window.CustomEvent('find-in-chat', { detail: { threadId } }) as any));
  await find('other');
  assert.equal(state.one.focusKey, null);
  // no view of the chat holds focus: its first view opens it
  await find('a');
  assert.deepEqual([state.one.focusKey, state.two.focusKey], [1, null]);
  // the focused view opens it, and asking again there only refocuses
  const field = host.querySelector<HTMLInputElement>('.two')!;
  field.focus();
  await find('a');
  await find('a');
  assert.deepEqual([state.one.focusKey, state.two.focusKey], [1, 2]);
  await act(async () => state.two.close());
  assert.equal(state.two.focusKey, null);
  assert.equal(document.activeElement, field);
  // with what had focus gone, the transcript takes it
  const scrolls = host.querySelectorAll<HTMLElement>('.scroll');
  await act(async () => state.one.close());
  assert.equal(document.activeElement, scrolls[0]);
  field.focus();
  await find('a');
  field.remove();
  await act(async () => state.two.close());
  assert.equal(document.activeElement, scrolls[1]);
  // another chat in the view closes its find
  await find('a');
  assert.deepEqual([state.one.focusKey, state.two.focusKey], [null, 1]);
  await render('b');
  assert.equal(state.two.focusKey, null);
  // focus in a view of another chat: the chat's own view opens it
  await find('a');
  assert.equal(state.one.focusKey, 1);
  await act(() => root.render(h('div', null, h(View, { name: 'one', threadId: 'c' }))));
  assert.equal(state.one.focusKey, null);
  await act(() => root.unmount());
});

test('a hidden view of the chat is passed over, and a view that moves to another chat and back has find closed', async () => {
  const state: Record<string, { focusKey: number | null }> = {};
  function View({ name, threadId, hidden = false }: { name: string; threadId: string; hidden?: boolean }) {
    const scrollRef = useRef<HTMLDivElement>(null);
    state[name] = useChatFindRequest(threadId, scrollRef);
    return h('div', { hidden }, h('div', { className: 'thread-view', 'data-thread-id': threadId }, h('div', { ref: scrollRef })));
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = mountRoot(host);
  const render = (chat: string) =>
    act(() =>
      root.render(h('div', null, h(View, { name: 'behind', threadId: 'a', hidden: true }), h(View, { name: 'pane', threadId: chat }))),
    );
  const find = () => act(async () => window.dispatchEvent(new window.CustomEvent('find-in-chat', { detail: { threadId: 'a' } }) as any));
  await render('a');
  await find();
  assert.deepEqual([state.behind.focusKey, state.pane.focusKey], [null, 1]);
  await render('b');
  await render('a');
  assert.equal(state.pane.focusKey, null);
  await act(() => root.unmount());
});

test('find without a transcript to read finds nothing and paints nothing, and a match gone before its frame is not scrolled to', async () => {
  const bare = await mountFind();
  await act(() => bare.root.render(h(ChatFind, bare.props({ scrollRef: { current: null } }))));
  await bare.type('cache');
  assert.equal(bare.count(), '3 of 3');
  await act(() => bare.root.unmount());
  document.body.innerHTML = '';
  // the frame that would scroll runs after the turn has gone (a chat switch, a rewind)
  const view = await mountFind();
  view.scroll.scrollTop = 7;
  await view.type('cache', false);
  assert.equal(clock.pending, 1, 'The scroll callback must still be pending when its turn disappears');
  view.scroll.replaceChildren();
  await frame();
  assert.equal(view.scroll.scrollTop, 7);
  await act(() => view.root.unmount());
});

test('find asked for from inside a find bar of another chat gives focus back to the transcript', async () => {
  const state: Record<string, { focusKey: number | null; close: () => void }> = {};
  function View() {
    const scrollRef = useRef<HTMLDivElement>(null);
    state.view = useChatFindRequest('a', scrollRef);
    return h('div', { className: 'thread-view', 'data-thread-id': 'a' }, h('div', { ref: scrollRef, tabIndex: 0, className: 'scroll' }));
  }
  const bar = document.createElement('div');
  bar.className = 'chat-find';
  const field = document.createElement('input');
  bar.append(field);
  const host = document.createElement('div');
  document.body.append(bar, host);
  const root = mountRoot(host);
  await act(() => root.render(h(View)));
  field.focus();
  await act(async () => window.dispatchEvent(new window.CustomEvent('find-in-chat', { detail: { threadId: 'a' } }) as any));
  assert.equal(state.view.focusKey, 1);
  await act(async () => state.view.close());
  assert.equal(document.activeElement, host.querySelector('.scroll'));
  await act(() => root.unmount());
});
