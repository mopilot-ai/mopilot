// The side panel's two banners from the harness (B9): the usage banner's "approaching" state (a window is nearly used up: dismissible, gone at its reset, the account's limit wins) and the "Stopped by a safety check" refusal card (idle chats only, above the usage banner).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { HTMLElement } from 'happy-dom';
import { window } from './support/dom.ts';
import { PanelChrome } from '../electron/chrome-extension/src/panelChrome.mjs';
import { PanelBanners } from '../electron/chrome-extension/src/panelBanners.mjs';
import {
  WARNING_TEXT,
  REFUSAL,
  MAX_DISMISSED,
  Dismissals,
  warningBanner,
  expiryWait,
} from '../electron/chrome-extension/src/panelSignals.mjs';

const views: any[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.close());
  window.document.body.replaceChildren();
});

function fixture(refusalCard = true) {
  const doc = window.document;
  doc.body.innerHTML = `<button id="more"></button><div id="header-menu" hidden><button id="app"></button><button id="more-settings"></button><button id="more-tasks"></button></div>
    <button id="side-settings"></button><button id="side"></button><aside id="sidebar" hidden></aside><div id="tasks"></div><section id="chat" data-chat-id="a" data-turn="idle"><div id="rows"></div><span id="progress-dot"></span><span id="progress-text"></span></section>
    <button id="jump"></button><span id="elapsed"></span><span id="activity-count"></span>
    <div id="composer"><div id="error" hidden></div>
    ${refusalCard ? '<div id="refusal" hidden><div><strong class="refusal-title"></strong><span class="refusal-body"></span></div><button id="refusal-off" type="button"></button></div>' : ''}
    <div id="usage" hidden><span id="usage-text"></span><button id="usage-off"></button></div></div>
    <img id="activity-thumbnail" /><div id="live"></div><div id="cards"></div><div id="pin-tip"></div><p id="copy-notice"></p>`;
  const $ = (id: string) => doc.getElementById(id)! as HTMLElement;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let id = 0;
  let changed: () => void = () => {};
  const clock = { now: 1_000_000 };
  class Observer {
    constructor(fn: () => void) {
      changed = fn;
    }
    observe() {}
    disconnect() {}
  }
  const g: any = {
    document: doc,
    navigator: {},
    MutationObserver: Observer,
    setTimeout: (fn: () => void, ms: number) => (timers.set(++id, { fn, ms }), id),
    clearTimeout: (i: number) => timers.delete(i),
    now: () => clock.now,
  };
  const chrome = new PanelChrome(g);
  views.push(chrome);
  // the pending expiry wait of the usage warning, if one is scheduled
  const wait = () => [...timers.values()].filter((t) => t.ms !== 1000);
  return { $, chrome, clock, timers, wait, changed: () => changed() };
}

const warning = (window: string, resetsAt: number | null) => JSON.stringify({ kind: 'approaching', window, resetsAt, utilization: 0.9 });

test('the banner words: Claude’s for its two plan windows, none for a window it has no words for, none for a warning that already reset or is no JSON', () => {
  assert.equal(WARNING_TEXT['5h'], '5-hour limit almost used up');
  assert.equal(WARNING_TEXT['7d'], 'Weekly limit almost used up');
  const now = 1000;
  assert.deepEqual(warningBanner(warning('5h', 5000), now), { key: '["5h",5000]', text: '5-hour limit almost used up', until: 5000 });
  assert.deepEqual(warningBanner(warning('7d', null), now), { key: '["7d",null]', text: 'Weekly limit almost used up', until: null });
  // extra usage has no words in Claude's inventory: no banner
  assert.equal(warningBanner(warning('overage', 5000), now), null);
  assert.equal(warningBanner(warning('5h', 1000), now), null);
  assert.equal(warningBanner(warning('2d', 5000), now), null);
  assert.equal(warningBanner(warning('toString', 5000), now), null);
  assert.equal(warningBanner(JSON.stringify({ window: '5h', resetsAt: 'soon' }), now)?.until, null);
  for (const raw of ['', undefined, 'null', '{', '7']) assert.equal(warningBanner(raw, now), null, String(raw));
  assert.equal(expiryWait(5000, 1000), 4050);
  assert.equal(expiryWait(900, 1000), 50, 'a reset already past is read again at once');
  assert.equal(expiryWait(1e15, 0), 2 ** 31 - 1, 'a far reset waits as long as a timer can');
});

test('an approaching warning shows Claude’s words as an info banner; the X dismisses it for that window, and the next window warns again', () => {
  const f = fixture();
  assert.equal(f.$('usage').hidden, true);
  f.$('chat').dataset.warning = warning('5h', f.clock.now + 3_600_000);
  f.changed();
  assert.equal(f.$('usage').hidden, false);
  assert.equal(f.$('usage-text').textContent, '5-hour limit almost used up');
  assert.equal(f.$('usage').dataset.kind, 'approaching');
  f.$('usage-off').click();
  assert.equal(f.$('usage').hidden, true);
  // the same window again (an update with a new used fraction): still dismissed
  f.$('chat').dataset.warning = JSON.stringify({ kind: 'approaching', window: '5h', resetsAt: f.clock.now + 3_600_000, utilization: 0.95 });
  f.changed();
  assert.equal(f.$('usage').hidden, true);
  // the weekly window warns on its own, and so does the next five-hour window (a later reset)
  f.$('chat').dataset.warning = warning('7d', f.clock.now + 86_400_000);
  f.changed();
  assert.deepEqual([f.$('usage').hidden, f.$('usage-text').textContent], [false, 'Weekly limit almost used up']);
  f.$('usage-off').click();
  f.$('chat').dataset.warning = warning('5h', f.clock.now + 5 * 3_600_000);
  f.changed();
  assert.equal(f.$('usage').hidden, false);
  // another chat's dismissal is its own: opening another chat shows its warning
  f.$('usage-off').click();
  f.$('chat').dataset.chatId = 'b';
  f.changed();
  assert.equal(f.$('usage').hidden, false);
  // no warning, or no chat open: no banner
  f.$('chat').dataset.warning = '';
  f.changed();
  assert.equal(f.$('usage').hidden, true);
  f.$('chat').dataset.warning = warning('5h', f.clock.now + 3_600_000);
  f.$('chat').hidden = true;
  f.changed();
  assert.equal(f.$('usage').hidden, true);
});

test('a warning goes by itself when its window resets, without any new read; one with no reset time stays', () => {
  const f = fixture();
  f.$('chat').dataset.warning = warning('5h', f.clock.now + 60_000);
  f.changed();
  assert.equal(f.$('usage').hidden, false);
  const [pending] = f.wait();
  assert.equal(pending.ms, 60_050, 'it waits for the reset, a moment past it');
  // the wait ends after the window reset
  f.clock.now += 60_050;
  pending.fn();
  assert.equal(f.$('usage').hidden, true);
  assert.equal(f.wait().length, 0, 'nothing is left waiting');
  f.$('chat').dataset.warning = warning('7d', null);
  f.changed();
  assert.equal(f.$('usage').hidden, false);
  assert.equal(f.wait().length, 0, 'no reset time: nothing to wait for');
  // closing the panel cancels the wait
  f.$('chat').dataset.warning = warning('7d', f.clock.now + 60_000);
  f.changed();
  assert.equal(f.wait().length, 1);
  f.chrome.close();
  assert.equal(f.wait().length, 0);
});

test('the account’s limit, when main says it is reached, wins over a warning and keeps its own text and kind', () => {
  const f = fixture();
  f.$('chat').dataset.warning = warning('5h', f.clock.now + 3_600_000);
  f.$('chat').dataset.limitKey = 'pin';
  f.$('chat').dataset.limitText = 'Usage limit reached on Pinned.';
  f.changed();
  assert.deepEqual(
    [f.$('usage').hidden, f.$('usage-text').textContent, f.$('usage').dataset.kind],
    [false, 'Usage limit reached on Pinned.', 'reached'],
  );
  delete f.$('chat').dataset.limitKey;
  f.changed();
  assert.deepEqual([f.$('usage-text').textContent, f.$('usage').dataset.kind], ['5-hour limit almost used up', 'approaching']);
});

test('the refusal card says “Stopped by a safety check” while the chat is idle and its last row is the refusal; it goes with a running turn, another chat, or the X', () => {
  const f = fixture();
  assert.equal(f.$('refusal').querySelector('.refusal-title')!.textContent, REFUSAL.title);
  assert.equal(REFUSAL.title, 'Stopped by a safety check');
  assert.match(f.$('refusal').querySelector('.refusal-body')!.textContent!, /^The agent's safety check stopped this chat\./);
  assert.equal(f.$('refusal').hidden, true);
  f.$('chat').dataset.refusalKey = 'refusal-t1';
  f.changed();
  assert.equal(f.$('refusal').hidden, false);
  // a turn runs (a message sent after it): the card is gone, and back is not it
  f.$('chat').dataset.turn = 'running';
  f.changed();
  assert.equal(f.$('refusal').hidden, true);
  f.$('chat').dataset.turn = 'idle';
  f.changed();
  assert.equal(f.$('refusal').hidden, false);
  f.$('refusal-off').click();
  assert.equal(f.$('refusal').hidden, true);
  f.changed();
  assert.equal(f.$('refusal').hidden, true, 'dismissed for this refusal');
  // a later refusal, or the same note in another chat, shows again
  f.$('chat').dataset.refusalKey = 'refusal-t2';
  f.changed();
  assert.equal(f.$('refusal').hidden, false);
  f.$('refusal-off').click();
  f.$('chat').dataset.chatId = 'b';
  f.changed();
  assert.equal(f.$('refusal').hidden, false);
  // no refusal row last, or no chat open
  f.$('chat').dataset.refusalKey = '';
  f.changed();
  assert.equal(f.$('refusal').hidden, true);
  f.$('chat').dataset.refusalKey = 'refusal-t3';
  f.$('chat').hidden = true;
  f.changed();
  assert.equal(f.$('refusal').hidden, true);
});

test('a page without the refusal card (an older page) still works', () => {
  const f = fixture(false);
  f.$('chat').dataset.refusalKey = 'refusal-t1';
  f.changed();
  f.$('chat').dataset.warning = warning('5h', f.clock.now + 3_600_000);
  f.changed();
  assert.equal(f.$('usage').hidden, false);
});

test('banners show one at a time in Claude’s order: error, refusal, usage limit, then the tab note', async () => {
  const doc = window.document;
  const ids = ['error', 'refusal', 'usage', 'notice'];
  doc.body.innerHTML = ids.map((id) => `<div id="${id}"></div>`).join('');
  const yielded = () => ids.filter((id) => doc.getElementById(id)!.hasAttribute('data-yielded'));
  const shown = new PanelBanners(window as any);
  assert.deepEqual(yielded(), ['refusal', 'usage', 'notice']);
  (doc.getElementById('error') as HTMLElement).hidden = true;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(yielded(), ['usage', 'notice'], 'the refusal card takes the slot above the usage banner');
  (doc.getElementById('refusal') as HTMLElement).hidden = true;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(yielded(), ['notice']);
  shown.close();
});

test('a dismissal is kept by its full key: leaving a chat and coming back does not bring the card or the banner back', () => {
  const f = fixture();
  f.$('chat').dataset.refusalKey = 'refusal-t1';
  f.$('chat').dataset.warning = warning('5h', f.clock.now + 3_600_000);
  f.changed();
  f.$('refusal-off').click();
  f.$('usage-off').click();
  // another chat with its own refusal and warning shows both
  f.$('chat').dataset.chatId = 'b';
  f.$('chat').dataset.refusalKey = 'refusal-b';
  f.changed();
  assert.deepEqual([f.$('refusal').hidden, f.$('usage').hidden], [false, false]);
  // and a chat with none in between
  f.$('chat').dataset.refusalKey = '';
  f.$('chat').dataset.warning = '';
  f.changed();
  assert.deepEqual([f.$('refusal').hidden, f.$('usage').hidden], [true, true]);
  // back in the first chat: both are still dismissed
  f.$('chat').dataset.chatId = 'a';
  f.$('chat').dataset.refusalKey = 'refusal-t1';
  f.$('chat').dataset.warning = warning('5h', f.clock.now + 3_600_000);
  f.changed();
  assert.deepEqual([f.$('refusal').hidden, f.$('usage').hidden], [true, true]);
  // a new refusal, or the next window, is not
  f.$('chat').dataset.refusalKey = 'refusal-t2';
  f.$('chat').dataset.warning = warning('5h', f.clock.now + 9 * 3_600_000);
  f.changed();
  assert.deepEqual([f.$('refusal').hidden, f.$('usage').hidden], [false, false]);
});

test('dismissals are bounded: the oldest is forgotten first, a key dismissed again is the newest, and none is no key', () => {
  const d = new Dismissals();
  d.add(null);
  assert.equal(d.has(null), false);
  d.add('first');
  for (let i = 0; i < MAX_DISMISSED - 1; i++) d.add(`k${i}`);
  assert.equal(d.has('first'), true);
  // dismissed again, it is the newest and outlives the next to go
  d.add('first');
  d.add('overflow');
  assert.equal(d.has('first'), true);
  assert.equal(d.has('k0'), false);
  assert.equal(d.keys.size, MAX_DISMISSED);
  assert.equal(d.has('overflow'), true);
});
