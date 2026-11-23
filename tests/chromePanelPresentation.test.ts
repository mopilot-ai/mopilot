// Minimal panel controls use real DOM semantics for menu dismissal, clipboard ownership, elapsed time, scrolling and long-message disclosures.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { HTMLElement } from 'happy-dom';
import { window } from './support/dom.ts';
import { PanelChrome } from '../electron/chrome-extension/src/panelChrome.mjs';
import { PanelCards } from '../electron/chrome-extension/src/panelCards.mjs';
import { messageTools } from '../electron/chrome-extension/src/panelMessage.mjs';

const views: any[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.close());
  window.document.body.replaceChildren();
});
const tick = () => new Promise((r) => setImmediate(r));
function fixture(customTime = true, withResize = false) {
  const doc = window.document;
  doc.body.innerHTML = `<button id="more"></button><div id="header-menu" hidden><button id="app"></button><button id="more-settings"></button><button id="more-tasks"></button></div>
    <button id="side-settings"></button><button id="side"></button><aside id="sidebar" hidden></aside><div id="tasks"></div><section id="chat" data-chat-id="a"><div id="rows"></div><span id="progress-dot"></span><span id="progress-text"></span></section>
    <button id="jump"></button><span id="elapsed"></span><span id="activity-count"></span><p id="error" hidden></p>
    <div id="usage"><span id="usage-text"></span><button id="usage-off"></button></div><img id="activity-thumbnail" /><div id="composer"></div><div id="live"></div><div id="cards"></div><div id="pin-tip"></div><p id="copy-notice"></p>`;
  const $ = (id: string) => doc.getElementById(id)! as HTMLElement;
  const timers = new Map<number, () => void>();
  let id = 0,
    now = 10000,
    changed: () => void = () => {},
    resized: () => void = () => {},
    disconnected = false;
  const copied: string[] = [];
  const clipboard = {
    writeText: async (s: string) => {
      copied.push(s);
    },
  };
  class Observer {
    constructor(fn: () => void) {
      changed = fn;
    }
    observe() {}
    disconnect() {
      disconnected = true;
    }
  }
  const g: any = {
    document: doc,
    navigator: { clipboard },
    MutationObserver: Observer,
    setTimeout: (fn: () => void) => (timers.set(++id, fn), id),
    clearTimeout: (i: number) => timers.delete(i),
    ...(customTime ? { now: () => now } : {}),
    ResizeObserver: withResize
      ? class {
          constructor(fn: () => void) {
            resized = fn;
          }
          observe() {}
          disconnect() {}
        }
      : undefined,
  };
  const view = new PanelChrome(g);
  views.push(view);
  return {
    view,
    g,
    $,
    copied,
    clipboard,
    timers,
    changed: () => changed(),
    resized: () => resized(),
    time: (n: number) => {
      now = n;
    },
    disconnected: () => disconnected,
  };
}

test('the compact header menu routes settings and tasks, and dismisses only on outside click or Escape', () => {
  const f = fixture();
  let settings = 0,
    history = 0,
    scrolled = 0;
  f.$('side-settings').addEventListener('click', () => settings++);
  f.$('side').addEventListener('click', () => history++);
  f.$('tasks').scrollIntoView = () => {
    scrolled++;
  };
  f.$('more').click();
  assert.equal(f.$('header-menu').hidden, false);
  for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', ...init }));
    assert.equal(f.$('header-menu').hidden, false, 'composition Escape belongs to the input method');
  }
  f.$('app').dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
  assert.equal(f.$('header-menu').hidden, false);
  f.$('more').dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' }));
  assert.equal(f.$('header-menu').hidden, false);
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(f.$('header-menu').hidden, true);
  f.$('more').click();
  f.$('more-settings').click();
  assert.equal(settings, 1);
  f.$('more').click();
  f.$('more-tasks').click();
  assert.equal(history, 1);
  assert.equal(scrolled, 1);
  f.$('sidebar').hidden = false;
  f.$('more').click();
  f.$('more-tasks').click();
  assert.equal(history, 1, 'Scheduled tasks keeps an already open sidebar open');
  assert.equal(scrolled, 2);
  f.$('more').click();
  window.document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
  assert.equal(f.$('more').getAttribute('aria-expanded'), 'false');
  f.$('more').click();
  f.$('app').click();
  assert.equal(f.$('header-menu').hidden, true);
  f.view.close();
  assert.equal(f.disconnected(), true);
  f.$('more').click();
  assert.equal(f.$('header-menu').hidden, true);
});

test('scroll recovery appears away from the latest message and scrolls the actual chat', () => {
  const f = fixture();
  const box = f.$('chat');
  Object.defineProperties(box, { scrollHeight: { value: 1000, configurable: true }, clientHeight: { value: 300, configurable: true } });
  box.scrollTop = 0;
  box.dispatchEvent(new window.Event('scroll'));
  assert.equal(f.$('jump').hidden, false);
  let target: any;
  box.scrollTo = (o: any) => {
    target = o;
  };
  f.$('jump').click();
  assert.deepEqual(target, { top: 1000, behavior: 'auto' });
  box.scrollTop = 700;
  f.changed();
  assert.equal(f.$('jump').hidden, true);
  box.hidden = true;
  f.view.scroll();
  assert.equal(f.$('jump').hidden, true);
});

test('elapsed time and hidden-step counts belong to the current observed chat and never borrow an earlier turn', () => {
  const f = fixture();
  f.$('progress-dot').className = 'dot wait';
  f.$('progress-text').textContent = 'Working…';
  f.$('rows').innerHTML =
    '<details class="steps"><div class="step"></div><div class="step"></div></details><div class="you">New task</div>';
  f.changed();
  assert.equal(f.$('elapsed').textContent, 'Watching 0s');
  assert.equal(f.$('activity-count').textContent, '');
  f.time(12500);
  [...f.timers.values()][0]();
  assert.equal(f.$('elapsed').textContent, 'Watching 2s');
  f.$('rows').insertAdjacentHTML('beforeend', '<details class="steps"><div class="step"></div></details>');
  f.changed();
  assert.equal(f.$('activity-count').textContent, '');
  f.$('rows').lastElementChild!.insertAdjacentHTML('beforeend', '<div class="step"></div><div class="step"></div>');
  f.changed();
  assert.equal(f.$('activity-count').textContent, '+2');
  f.$('chat').dataset.chatId = 'b';
  f.changed();
  assert.equal(f.$('elapsed').textContent, 'Watching 0s');
  f.time(11000);
  f.changed();
  assert.equal(f.$('elapsed').textContent, 'Watching 0s');
  f.$('progress-dot').className = 'dot ok';
  f.changed();
  assert.equal(f.timers.size, 0);
  assert.equal(f.$('elapsed').textContent, '');
  f.$('progress-dot').className = 'dot wait';
  f.$('chat').hidden = true;
  f.changed();
  assert.equal(f.timers.size, 0);
  f.$('chat').hidden = false;
  f.$('progress-text').textContent = 'Waiting for your answer';
  f.changed();
  assert.equal(f.timers.size, 0);
  fixture(false).view.activity();
});

test('copy uses the exact text, shows actual failures and drops a late failure from another chat', async () => {
  const f = fixture();
  const button = window.document.createElement('button');
  button.dataset.panelCopy = '<not markup>';
  button.setAttribute('aria-label', 'Copy message');
  window.document.body.append(button);
  button.click();
  window.document.dispatchEvent(new window.Event('click'));
  await tick();
  assert.deepEqual(f.copied, ['<not markup>']);
  assert.equal(button.getAttribute('aria-label'), 'Copy message');
  assert.equal(f.$('copy-notice').textContent, 'Copied');
  [...f.timers.values()][0]();
  assert.equal(button.dataset.copyState, 'Copy');
  f.clipboard.writeText = async () => {
    throw new Error('Clipboard denied');
  };
  await f.view.copy(button);
  assert.equal(f.$('copy-notice').textContent, 'Clipboard denied');
  f.g.navigator.clipboard = null;
  await f.view.copy(button);
  assert.match(f.$('copy-notice').textContent, /unavailable/);
  f.g.navigator.clipboard = {};
  await f.view.copy(button);
  assert.match(f.$('copy-notice').textContent, /unavailable/);
  let reject: any;
  f.g.navigator.clipboard = {
    writeText: () =>
      new Promise((_r, no) => {
        reject = no;
      }),
  };
  const waiting = f.view.copy(button);
  f.$('chat').dataset.chatId = 'new-chat';
  f.$('copy-notice').textContent = 'Current notice';
  reject(new Error('Old error'));
  await waiting;
  assert.equal(f.$('copy-notice').textContent, 'Current notice');
});

test('long user messages preserve their disclosure state and code copies carry the code alone', () => {
  const doc = window.document;
  const open = new Set<string>();
  const build = () => {
    const el = doc.createElement('div');
    el.textContent = 'x'.repeat(700);
    messageTools(doc, el, { role: 'user', text: 'x'.repeat(700) }, 'message', open);
    return el;
  };
  const first = build();
  const details = first.querySelector('details')!;
  assert.equal(details.open, false);
  details.open = true;
  details.dispatchEvent(new window.Event('toggle'));
  assert.equal(build().querySelector('details')!.open, true);
  details.open = false;
  details.dispatchEvent(new window.Event('toggle'));
  assert.equal(open.size, 0);
  const reply = doc.createElement('div');
  reply.innerHTML = '<pre><code>echo test</code></pre><pre>plain</pre>';
  messageTools(doc, reply, { role: 'assistant', text: 'Full message' }, 'reply', open);
  assert.deepEqual(
    [...reply.querySelectorAll('button')].map((b) => b.dataset.panelCopy),
    ['echo test', 'plain', 'Full message'],
  );
  const step = doc.createElement('div');
  const short = doc.createElement('div');
  messageTools(doc, short, { role: 'user', text: 'Short' }, 'short', open);
  assert.equal(short.querySelector('details'), null);
  messageTools(doc, step, { role: 'step', text: 'Read page' }, 'step', open);
  assert.equal(step.querySelectorAll('button').length, 0);
  const fake: any = { append() {} };
  messageTools(doc, fake, { role: 'step', text: 'Read page' }, 'step', open);
});

test('an actual account-limit notice can be dismissed, and a different chat, account or new limit resets it', () => {
  const f = fixture();
  assert.equal(f.$('usage').hidden, true);
  f.$('chat').dataset.limitKey = 'pin';
  f.$('chat').dataset.limitText = 'Usage limit reached on Pinned.';
  f.changed();
  assert.equal(f.$('usage').hidden, false);
  assert.equal(f.$('usage-text').textContent, 'Usage limit reached on Pinned.');
  f.$('usage-off').click();
  assert.equal(f.$('usage').hidden, true);
  f.changed();
  assert.equal(f.$('usage').hidden, true);
  f.$('chat').dataset.chatId = 'b';
  f.changed();
  assert.equal(f.$('usage').hidden, false);
  f.$('usage-off').click();
  f.$('chat').dataset.limitKey = 'other';
  f.changed();
  assert.equal(f.$('usage').hidden, false);
  f.$('chat').hidden = true;
  f.changed();
  assert.equal(f.$('usage').hidden, true);
  f.$('chat').hidden = false;
  delete f.$('chat').dataset.limitKey;
  delete f.$('chat').dataset.limitText;
  f.changed();
  assert.equal(f.$('usage-text').textContent, '');
  f.$('chat').dataset.limitKey = 'other';
  f.changed();
  assert.equal(f.$('usage').hidden, false);
});

test('the running line uses proven Chrome tool metadata and the latest actual screenshot only', () => {
  const f = fixture();
  f.$('progress-dot').className = 'wait';
  f.$('progress-text').textContent = 'Working…';
  f.$('rows').innerHTML = '<div class="step" data-surface="chrome"><img class="step-thumbnail" src="data:image/png;base64,AAAA" /></div>';
  f.changed();
  assert.equal(f.$('progress-text').textContent, 'Using your Chrome');
  assert.equal(f.$('activity-thumbnail').hidden, false);
  const thumbnail = f.$('activity-thumbnail');
  let changedSource = 0;
  const attribute = thumbnail.setAttribute.bind(thumbnail);
  thumbnail.setAttribute = (name, value) => {
    if (name === 'src') changedSource++;
    return attribute(name, value);
  };
  f.changed();
  assert.equal(changedSource, 0, 'the elapsed timer never reloads an unchanged screenshot');
  assert.equal(f.$('activity-count').textContent, '');
  f.changed();
  assert.equal(f.$('progress-text').textContent, 'Using your Chrome');
  f.$('rows').innerHTML = '<div class="you">Next turn</div><div class="step">A command</div>';
  f.changed();
  assert.equal(f.$('progress-text').textContent, 'Working…');
  assert.equal(f.$('activity-thumbnail').hidden, true);
  assert.equal(f.$('activity-thumbnail').getAttribute('src'), null);
  f.$('rows').innerHTML = '<details class="steps"><div class="step" data-surface="chrome"></div><div class="step"></div></details>';
  f.changed();
  assert.equal(f.$('progress-text').textContent, 'Using your Chrome');
  assert.equal(f.$('activity-count').textContent, '+1');
});

test('copy errors have their own notice and cannot replace a retained failed-send draft', async () => {
  const f = fixture(true, true);
  f.$('composer').getBoundingClientRect = () => ({ top: 100, height: 100 }) as any;
  Object.defineProperty(window.document.documentElement, 'clientHeight', { value: 200, configurable: true });
  f.resized();
  assert.equal(f.$('jump').style.bottom, '108px');
  Reflect.deleteProperty(window.document.documentElement, 'clientHeight');
  f.$('error').textContent = 'The message was not sent. Draft: keep these words';
  f.clipboard.writeText = async () => {
    throw new Error('Clipboard denied');
  };
  const button = window.document.createElement('button');
  button.dataset.panelCopy = 'visible text';
  button.dataset.copyDone = 'Copied shown text';
  await f.view.copy(button);
  assert.equal(f.$('error').textContent, 'The message was not sent. Draft: keep these words');
  assert.equal(f.$('copy-notice').textContent, 'Clipboard denied');
  f.clipboard.writeText = async () => {};
  await f.view.copy(button);
  assert.equal(f.$('copy-notice').textContent, 'Copied shown text');
  assert.equal(button.dataset.copyState, 'Copied shown text');
});

test('new content follows the bottom until the person scrolls away; switching chats resumes following', () => {
  const f = fixture();
  Object.defineProperties(f.$('chat'), { scrollHeight: { value: 1000, writable: true }, clientHeight: { value: 100, writable: true } });
  f.changed();
  assert.equal(f.$('chat').scrollTop, 1000);
  f.$('chat').scrollTop = 100;
  f.$('chat').dispatchEvent(new window.Event('scroll'));
  (f.$('chat') as any).scrollHeight = 2000;
  f.$('live').textContent = 'A growing streamed reply';
  f.changed();
  assert.equal(f.$('chat').scrollTop, 100);
  assert.equal(f.$('jump').hidden, false);
  f.$('chat').scrollTo = ({ top }: any) => {
    f.$('chat').scrollTop = top;
  };
  f.$('jump').click();
  (f.$('chat') as any).scrollHeight = 3000;
  f.changed();
  assert.equal(f.$('chat').scrollTop, 3000);
  f.$('chat').scrollTop = 100;
  f.$('chat').dispatchEvent(new window.Event('scroll'));
  f.$('chat').dataset.chatId = 'next';
  f.changed();
  assert.equal(f.$('chat').scrollTop, 3000);
});

test('message-copy controls also retain their text on the minimal append-only preview host', () => {
  const nodes: any[] = [];
  const host: any = { append: (node: any) => nodes.push(node) };
  messageTools(window.document, host, { role: 'assistant', text: 'Exact preview' }, 'preview', new Set());
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].dataset.panelCopy, 'Exact preview');
});

test('copy feedback expires, preserves its accessible action and handles non-Error failures', async () => {
  const f = fixture();
  const button = window.document.createElement('button');
  button.dataset.panelCopy = 'Text';
  button.dataset.copyIdle = 'Copy shown text';
  button.setAttribute('aria-label', 'Copy message');
  await f.view.copy(button);
  const expire = [...f.timers.values()][0];
  expire();
  assert.equal(button.dataset.copyState, 'Copy shown text');
  assert.equal(button.getAttribute('aria-label'), 'Copy message');
  assert.equal(f.$('copy-notice').textContent, '');
  for (const reason of ['Bare rejection', null]) {
    f.clipboard.writeText = async () => {
      throw reason;
    };
    await f.view.copy(button);
    assert.equal(f.$('copy-notice').textContent, reason ?? 'Copy failed');
  }
  f.clipboard.writeText = async () => {};
  await f.view.copy(button);
  const old = [...f.timers.values()].at(-1)!;
  f.$('chat').dataset.chatId = 'other';
  f.changed();
  f.$('copy-notice').textContent = 'Current';
  old();
  assert.equal(f.$('copy-notice').textContent, 'Current');
  f.$('rows').dispatchEvent(new window.Event('toggle'));
  f.$('rows').innerHTML = '<details><summary>Inspect this step</summary></details>';
  (f.$('rows').querySelector('summary') as HTMLElement).click();
  assert.equal(f.view.follow, false);
});

test('autofollow does not move a live held confirmation while history or layout refreshes', async (t) => {
  const f = fixture();
  const box = f.$('chat');
  Object.defineProperties(box, { scrollHeight: { value: 1000, configurable: true }, clientHeight: { value: 300, configurable: true } });
  f.view.close();
  f.g.MutationObserver = window.MutationObserver;
  const presentation = new PanelChrome(f.g);
  views.push(presentation);
  box.scrollTop = 100;
  let answers = 0;
  const cards = new PanelCards({
    document: window.document,
    container: f.$('cards'),
    timers: f.g,
    onError: () => {},
    onOpen: () => {},
    request: async () => {
      answers++;
    },
    onAnswered: async () => {},
  });
  t.after(() => cards.render(null, []));
  cards.render('a', [{ id: 'confirm', version: 'one', choices: [{ key: 'once', label: 'Allow once', hold: true }] }]);
  const button = f.$('cards').querySelector('button')!;
  const press = new window.PointerEvent('pointerdown', { button: 0, bubbles: true });
  Object.defineProperty(press, 'isTrusted', { value: true });
  button.dispatchEvent(press);
  assert.equal(button.classList.contains('holding'), true);
  f.$('rows').append(window.document.createElement('div'));
  await tick();
  presentation.layout();
  assert.equal(box.scrollTop, 100, 'layout must not move an actively held button out from under the pointer');
  button.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true }));
  assert.equal(button.classList.contains('holding'), false);
  await tick();
  assert.equal(box.scrollTop, 1000, 'normal follow resumes after the gesture ends');
  box.scrollTop = 100;
  button.dispatchEvent(press);
  assert.equal(button.classList.contains('holding'), true);
  [...f.timers.values()][0]();
  await tick();
  assert.equal(answers, 1);
  assert.equal(button.classList.contains('holding'), false);
  assert.equal(button.disabled, true, 'the answered card still waits for its next native snapshot');
  assert.equal(box.scrollTop, 1000, 'timer completion releases following before the card is removed');
});

test('a late clipboard success cannot replace a newer copy or another chat notice', async () => {
  const f = fixture();
  const button = window.document.createElement('button');
  button.dataset.panelCopy = 'Earlier message';
  let finish: () => void;
  f.clipboard.writeText = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  const pending = f.view.copy(button);
  f.clipboard.writeText = async () => {};
  const newer = window.document.createElement('button');
  newer.dataset.panelCopy = 'Newer message';
  newer.dataset.copyDone = 'Newer copied';
  await f.view.copy(newer);
  finish!();
  await pending;
  assert.equal(button.dataset.copyState, undefined);
  assert.equal(f.$('copy-notice').textContent, 'Newer copied');
});
