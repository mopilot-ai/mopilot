// Selection fixture ownership and completion against DOM-backed, controlled Playwright locator boundaries.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { window } from './support/dom.ts';
import { deferred } from './support/async-scenarios.ts';
import { selectCompletedReply } from './e2e/fixtures/replySelection.ts';

type State = {
  changed: ReturnType<typeof deferred<void>>;
  waits: string[];
  evaluations: number;
  scrolls: number;
  scroll?: (el: Element) => void | Promise<void>;
};

class Locator {
  private state: State;
  private pick: () => Element[];
  private kind: string;

  constructor(state: State, pick: () => Element[], kind: string) {
    this.state = state;
    this.pick = pick;
    this.kind = kind;
  }

  private children(selector: string, kind: string) {
    return new Locator(this.state, () => this.pick().flatMap((el) => [...el.querySelectorAll(selector)]), kind);
  }

  getByRole(role: string, options?: { name: string; exact: boolean }) {
    if (role === 'main') return this.children('main', 'main');
    assert.equal(role, 'button');
    assert.deepEqual(options, { name: 'Fork chat from here', exact: true });
    return this.children('button[aria-label="Fork chat from here"]', 'completed');
  }

  locator(selector: string) {
    return this.children(selector, 'turn');
  }

  getByText(text: string, options: { exact: boolean }) {
    assert.deepEqual(options, { exact: true });
    const paragraphs = this.children('p', 'reply');
    return new Locator(this.state, () => paragraphs.pick().filter((el) => el.textContent === text), 'reply');
  }

  filter({ has }: { has: Locator }) {
    return new Locator(this.state, () => this.pick().filter((el) => has.pick().some((reply) => el.contains(reply))), this.kind);
  }

  async waitFor(options: { state: string }) {
    assert.deepEqual(options, { state: 'visible' });
    this.state.waits.push(this.kind);
    if (this.pick().length === 0) await this.state.changed.promise;
    assert.equal(this.pick().length, 1, 'strict locator requires one owner/control');
  }

  async evaluate(fn: (el: Element) => unknown) {
    const elements = this.pick();
    assert.equal(elements.length, 1, 'selection must resolve one reply after completion');
    this.state.evaluations++;
    return fn(elements[0]);
  }

  async scrollIntoViewIfNeeded() {
    const elements = this.pick();
    assert.equal(elements.length, 1, 'scroll must resolve one completed reply');
    this.state.scrolls++;
    await this.state.scroll?.(elements[0]);
  }
}

function fixture() {
  const state: State = { changed: deferred<void>(), waits: [], evaluations: 0, scrolls: 0 };
  return { state, page: new Locator(state, () => [document.body], 'page') as unknown as Page };
}

function transcript() {
  const main = document.createElement('main');
  const content = document.createElement('div');
  content.className = 'main-content';
  main.append(content);
  document.body.append(main);
  return { main, content };
}

function addReply(parent: Element, text: string, complete = false) {
  const turn = document.createElement('div');
  turn.className = 'turn';
  const assistant = document.createElement('div');
  assistant.className = 'assistant-message';
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  assistant.append(paragraph);
  turn.append(assistant);
  parent.append(turn);
  if (complete) finish(turn);
  return turn;
}

function finish(turn: Element) {
  const action = document.createElement('button');
  action.setAttribute('aria-label', 'Fork chat from here');
  turn.append(action);
}

beforeEach(() => {
  document.body.replaceChildren();
  window.getSelection().removeAllRanges();
});

test('visible text waits for its own completion and selects fresh DOM once, ignoring earlier/later turns and the side pane', async () => {
  const text = `fake-codex: a 'quoted' [reply] \\ path`;
  const { main, content } = transcript();
  const side = document.createElement('aside');
  side.className = 'side-pane';
  main.append(side);
  addReply(content, 'older', true);
  const current = addReply(content, text);
  addReply(content, `${text} suffix`, true);
  addReply(content, 'newer', true);
  addReply(side, text, true);
  const { state, page } = fixture();
  const pending = selectCompletedReply(page, text);
  await Promise.resolve();
  assert.deepEqual(state.waits, ['turn', 'completed']);
  assert.equal(state.evaluations, 0);
  assert.equal(window.getSelection().toString(), '');
  // Completion may replace the rendered paragraph. The helper must not retain its pre-await node.
  const fresh = document.createElement('p');
  fresh.textContent = text;
  current.querySelector('p')!.replaceWith(fresh);
  finish(current);
  state.changed.resolve();
  await pending;
  assert.equal(state.evaluations, 1);
  assert.equal(window.getSelection().toString(), text);
  assert.equal(window.getSelection().getRangeAt(0).commonAncestorContainer, fresh);
});

test('an already completed reply selects once without tool-work controls', async () => {
  const { content } = transcript();
  addReply(content, 'fake-claude: reply', true);
  const { state, page } = fixture();
  await selectCompletedReply(page, 'fake-claude: reply');
  assert.equal(state.evaluations, 1);
  assert.equal(window.getSelection().toString(), 'fake-claude: reply');
});

test('a quote in a user message does not compete with the original assistant reply', async () => {
  const { content } = transcript();
  const reply = addReply(content, 'original answer', true);
  const followUp = addReply(content, 'follow-up answer', true);
  const quote = document.createElement('p');
  quote.className = 'user-annotation-quote';
  quote.textContent = 'original answer';
  reply.prepend(quote.cloneNode(true));
  followUp.prepend(quote);
  const { page } = fixture();
  await selectCompletedReply(page, 'original answer');
  assert.equal(window.getSelection().getRangeAt(0).commonAncestorContainer, reply.querySelector('.assistant-message p'));
});

test('duplicate exact main-transcript replies fail before borrowing the only completed action', async () => {
  const { content } = transcript();
  addReply(content, 'same', true);
  addReply(content, 'same');
  const { state, page } = fixture();
  await assert.rejects(selectCompletedReply(page, 'same'), /strict locator/);
  assert.deepEqual(state.waits, ['turn']);
  assert.equal(state.evaluations, 0);
});

test('missing owner and failed completion propagate without selecting or retrying', async () => {
  for (const present of [false, true]) {
    document.body.replaceChildren();
    const { content } = transcript();
    addReply(content, 'other completed reply', true);
    if (present) addReply(content, 'current');
    const { state, page } = fixture();
    const pending = selectCompletedReply(page, 'current');
    await Promise.resolve();
    state.changed.reject(new Error('completion wait failed'));
    await assert.rejects(pending, /completion wait failed/);
    assert.equal(state.evaluations, 0);
    assert.equal(window.getSelection().toString(), '');
  }
});

test('a completed reply outside the viewport is scrolled before its text is selected', async () => {
  const { content } = transcript();
  const turn = addReply(content, 'offscreen reply', true);
  const paragraph = turn.querySelector('p')!;
  let top = -100;
  paragraph.getBoundingClientRect = () => new window.DOMRect(10, top, 300, 20) as DOMRect;
  const { state, page } = fixture();
  state.scroll = (el) => {
    assert.equal(el, paragraph);
    assert.equal(state.evaluations, 0, 'scrolling must precede selection');
    assert.deepEqual(state.waits, ['turn', 'completed']);
    top = 100;
  };
  await selectCompletedReply(page, 'offscreen reply');
  assert.equal(state.scrolls, 1);
  assert.equal(window.getSelection().getRangeAt(0).commonAncestorContainer, paragraph);
  assert.equal(paragraph.getBoundingClientRect().top, 100);
  assert.equal(window.getSelection().toString(), 'offscreen reply');
});

test('scrolling waits before selecting and resolves the reply again after a scroll-triggered replacement', async () => {
  const { content } = transcript();
  const turn = addReply(content, 'reply replaced by scrolling', true);
  const scroll = deferred<void>();
  const { state, page } = fixture();
  state.scroll = () => scroll.promise;
  const pending = selectCompletedReply(page, 'reply replaced by scrolling');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(state.scrolls, 1);
  assert.equal(state.evaluations, 0);
  const fresh = document.createElement('p');
  fresh.textContent = 'reply replaced by scrolling';
  turn.querySelector('p')!.replaceWith(fresh);
  scroll.resolve();
  await pending;
  assert.equal(state.evaluations, 1);
  assert.equal(window.getSelection().getRangeAt(0).commonAncestorContainer, fresh);
});

test('scroll failure and duplicate owners after scrolling fail without selecting or retrying', async () => {
  for (const duplicate of [false, true]) {
    document.body.replaceChildren();
    const { content } = transcript();
    addReply(content, 'current reply', true);
    const { state, page } = fixture();
    state.scroll = () => {
      if (!duplicate) throw new Error('scroll failed');
      addReply(content, 'current reply', true);
    };
    await assert.rejects(selectCompletedReply(page, 'current reply'), duplicate ? /one reply after completion/ : /scroll failed/);
    assert.equal(state.scrolls, 1);
    assert.equal(state.evaluations, 0);
    assert.equal(window.getSelection().toString(), '');
  }
});
