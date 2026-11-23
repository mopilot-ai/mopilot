// "Watching Ns" in Chrome's side panel counts from the running turn's own start when MoPilot could say it (electron/chrome-extension/src/panelChrome.mjs activity, panelThread.mjs), else from when the panel first saw the turn run (#3046, B2).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { HTMLElement } from 'happy-dom';
import { window } from './support/dom.ts';
import { PanelChrome } from '../electron/chrome-extension/src/panelChrome.mjs';

const views: any[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.close());
  window.document.body.replaceChildren();
});

function fixture() {
  const doc = window.document;
  doc.body.innerHTML = `<button id="more"></button><div id="header-menu" hidden><button id="app"></button><button id="more-settings"></button><button id="more-tasks"></button></div>
    <button id="side-settings"></button><button id="side"></button><aside id="sidebar" hidden></aside><div id="tasks"></div><section id="chat" data-chat-id="a"><div id="rows"></div><span id="progress-dot" class="dot wait"></span><span id="progress-text">Working…</span></section>
    <button id="jump"></button><span id="elapsed"></span><span id="activity-count"></span><p id="error" hidden></p>
    <div id="usage"><span id="usage-text"></span><button id="usage-off"></button></div><img id="activity-thumbnail" /><div id="composer"></div><div id="live"></div><div id="cards"></div><div id="pin-tip"></div><p id="copy-notice"></p>`;
  const $ = (id: string) => doc.getElementById(id)! as HTMLElement;
  let now = 100_000;
  let changed: () => void = () => {};
  class Observer {
    constructor(fn: () => void) {
      changed = fn;
    }
    observe() {}
    disconnect() {}
  }
  const view = new PanelChrome({
    document: doc,
    navigator: {},
    MutationObserver: Observer,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    now: () => now,
  });
  views.push(view);
  return {
    $,
    time: (n: number) => (now = n),
    /** The page's `data-turn-start`, then one tick of the counter */
    tick: (turnStart?: string) => {
      if (turnStart !== undefined) $('chat').dataset.turnStart = turnStart;
      changed();
      return $('elapsed').textContent;
    },
  };
}

test('the counter starts from the turn’s own start, not from when the panel first saw it', () => {
  const f = fixture();
  // the turn began 42 s ago, in a chat the panel just opened
  assert.equal(f.tick(String(100_000 - 42_000)), 'Watching 42s');
  f.time(105_000);
  assert.equal(f.tick(), 'Watching 47s');
  // a later read with the same start changes nothing
  assert.equal(f.tick(String(100_000 - 42_000)), 'Watching 47s');
});

test('without the turn’s start the counter counts from first sight, and the start then moves it back', () => {
  const f = fixture();
  assert.equal(f.tick(''), 'Watching 0s');
  f.time(104_000);
  assert.equal(f.tick(), 'Watching 4s');
  // a read that could say the start arrives: the counter follows it
  assert.equal(f.tick(String(104_000 - 20_000)), 'Watching 20s');
  // a read that could not (the turn has no row yet) leaves the counter where it was
  f.time(105_000);
  assert.equal(f.tick(''), 'Watching 21s');
});

test('a start that is not a time, or one ahead of the clock, never makes the counter negative', () => {
  const f = fixture();
  assert.equal(f.tick('nonsense'), 'Watching 0s');
  assert.equal(f.tick('0'), 'Watching 0s');
  // a start a second ahead of this window's clock
  assert.equal(f.tick(String(101_000)), 'Watching 0s');
});

test('another turn counts from its own start; an ended turn leaves no counter', () => {
  const f = fixture();
  assert.equal(f.tick(String(100_000 - 30_000)), 'Watching 30s');
  f.$('progress-dot').className = 'dot ok';
  f.$('progress-text').textContent = 'Stopped';
  assert.equal(f.tick(''), '');
  f.$('progress-dot').className = 'dot wait';
  f.$('progress-text').textContent = 'Working…';
  f.time(110_000);
  assert.equal(f.tick(String(110_000 - 3_000)), 'Watching 3s');
  // another chat: its own start, not this one's
  f.$('chat').dataset.chatId = 'b';
  assert.equal(f.tick(String(110_000 - 9_000)), 'Watching 9s');
});
