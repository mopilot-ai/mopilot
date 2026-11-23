// Native turn-state refreshes preserve the current running presentation until the actual turn state changes.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { PanelThread } from '../electron/chrome-extension/src/panelThread.mjs';

afterEach(() => window.document.body.replaceChildren());

test('an unchanged running snapshot cannot replace the proven Chrome activity label', () => {
  const doc = window.document;
  doc.body.innerHTML =
    '<button id="load-again"></button><div id="cards"></div><div id="live"></div><span id="progress-dot"></span><span id="progress-text"></span>';
  const thread = new PanelThread({ document: doc, request: async () => ({}), onError: () => {}, onOpen: () => {} });
  const text = doc.getElementById('progress-text')!;
  thread.turn('running');
  assert.equal(text.textContent, 'Working…');
  text.textContent = 'Using your Chrome';
  thread.turn('running', false);
  assert.equal(text.textContent, 'Using your Chrome');
  thread.turn('waiting');
  assert.equal(text.textContent, 'Waiting for you');
  thread.turn('running');
  assert.equal(text.textContent, 'Working…');
  text.textContent = '';
  thread.turn('running', false);
  assert.equal(text.textContent, 'Working…');
});
