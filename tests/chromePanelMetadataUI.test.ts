// Current native titles and account notices reach only the open per-tab view, including a late read after New chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import type { HTMLElement } from 'happy-dom';
import { tick } from './support/extension-background/fixture.ts';
import { panelPage } from './support/side-panel-page.ts';
import { PanelThread } from '../electron/chrome-extension/src/panelThread.mjs';
import { startSidePanel } from '../electron/chrome-extension/src/sidePanel.mjs';

test('a live account notice is rendered from the main response and cleared when its view closes', async () => {
  window.document.body.innerHTML = [
    'chat',
    'rows',
    'cards',
    'live',
    'meta',
    'loading',
    'load-error',
    'load-again',
    'progress-dot',
    'progress-text',
  ]
    .map((id) => `<div id="${id}"></div>`)
    .join('');
  const thread = new PanelThread({
    document: window.document,
    request: async () => ({ rows: [], state: 'idle', limit: { key: 'pin', window: null, resetsAt: null } }),
    onError: () => {},
    onOpen: () => {},
  });
  await thread.open('chat');
  const chat = window.document.getElementById('chat') as HTMLElement;
  assert.equal(chat.dataset.limitKey, 'pin');
  assert.equal(chat.dataset.limitText, 'Usage limit reached');
  thread.close();
  assert.equal(chat.dataset.limitKey, '');
  window.document.body.replaceChildren();
});

for (const late of [false, true])
  test(`the panel adopts a canonical title only while its read still owns this view (late ${late})`, async () => {
    const p = panelPage();
    const reply = p.chrome.reply;
    let finish: any;
    p.chrome.reply = (m: any) =>
      m.type === 'panel' && m.method === 'read'
        ? new Promise((r) => {
            finish = r;
          })
        : reply(m);
    await startSidePanel(p.g).ready;
    await tick();
    p.els.text.value = 'A long initial question';
    await p.els.composer.listeners.submit({ preventDefault() {} });
    await tick();
    if (late) p.els.new.listeners.click();
    finish({ status: 'connected', result: { rows: [], title: 'Canonical task' } });
    await tick();
    assert.equal(p.els.title.textContent, late ? 'New chat' : 'Canonical task');
  });
