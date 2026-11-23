// The usage banner's "limit reached" words (electron/chrome-extension/src/panelSignals.mjs reachedText) and how the thread hands main's `limit` to the banner (panelThread.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { el } from './support/side-panel-page.ts';

const { reachedText, LIMIT_REACHED } = await import('../electron/chrome-extension/src/panelSignals.mjs');
const { PanelThread } = await import('../electron/chrome-extension/src/panelThread.mjs');

const NOW = Date.UTC(2026, 10, 3, 12, 0);
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

test('the five-hour window says its reset time, the weekly one adds the weekday, anything less says the plain limit', () => {
  const at = NOW + 3600_000;
  assert.equal(reachedText({ window: '5h', resetsAt: at }, NOW), `5-hour limit reached · resets ${time(at)}`);
  const day = new Date(at).toLocaleDateString([], { weekday: 'long' });
  assert.equal(reachedText({ window: '7d', resetsAt: at }, NOW), `Weekly limit reached · resets ${day} ${time(at)}`);
  // no window, no reset, a reset that has passed, or nonsense: Claude's plain words
  const plain = [
    { window: null, resetsAt: at },
    { window: '5h', resetsAt: null },
    { window: '5h', resetsAt: NOW - 1 },
    { window: '5h', resetsAt: NaN },
    { window: 'overage' },
    null,
    undefined,
  ];
  for (const limit of plain) assert.equal(reachedText(limit as any, NOW), LIMIT_REACHED);
  assert.equal(LIMIT_REACHED, 'Usage limit reached');
});

test('the thread puts main’s limit on the page as the banner’s key and words, and clears them when the chat did not stop on one', async () => {
  const els: Record<string, any> = {};
  const document = {
    getElementById: (id: string) => (els[id] ??= el()),
    createElement: (tag: string) => el(tag),
    createTextNode: (text: string) => ({ textContent: text }),
  };
  const answers: any[] = [];
  const t = new PanelThread({ document, request: async () => answers.shift(), onError: () => undefined, onOpen: () => undefined });
  const resetsAt = Date.now() + 3600_000;
  answers.push({ rows: [], state: 'idle', limit: { key: 'limit-1', window: '5h', resetsAt } });
  await t.open('c1', {});
  assert.equal(els.chat.dataset.limitKey, 'limit-1');
  assert.equal(els.chat.dataset.limitText, `5-hour limit reached · resets ${time(resetsAt)}`);
  answers.push({ rows: [], state: 'idle' });
  await t.read();
  assert.equal(els.chat.dataset.limitKey, '');
  assert.equal(els.chat.dataset.limitText, '');
});
