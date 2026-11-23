// The side panel's message box (electron/chrome-extension/src/panelAutosize.mjs, sidepanel.css): it grows with its text and has no drag handle, as Claude's and ChatGPT's boxes (#3046).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tick } from './support/extension-background/fixture.ts';
import { panelPage } from './support/side-panel-page.ts';

const { autosize } = await import('../electron/chrome-extension/src/panelAutosize.mjs');
const { startSidePanel } = await import('../electron/chrome-extension/src/sidePanel.mjs');

const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'electron', 'chrome-extension', 'sidepanel.css'), 'utf8');

test('the box is as tall as its content, and a shorter text shrinks it again', () => {
  const box = { style: { height: '' }, scrollHeight: 96 };
  autosize(box);
  assert.equal(box.style.height, '96px');
  // the height is reset before it is read, so the shorter content is measured, not the old height
  const heights: string[] = [];
  const shrinking = {
    style: {
      get height() {
        return heights.at(-1) ?? '';
      },
      set height(v: string) {
        heights.push(v);
      },
    },
    scrollHeight: 44,
  };
  autosize(shrinking);
  assert.deepEqual(heights, ['auto', '44px']);
});

test('the panel sizes the box whenever its text changes', async () => {
  const p = panelPage();
  await startSidePanel(p.g).ready;
  await tick();
  p.els.text.scrollHeight = 120;
  p.els.text.value = 'a\nb\nc\nd';
  p.els.text.listeners.input();
  assert.equal(p.els.text.style.height, '120px');
  p.els.text.scrollHeight = 44;
  p.els.text.value = '';
  p.els.text.listeners.input();
  assert.equal(p.els.text.style.height, '44px');
});

test('the box has no resize handle, and is bounded in height by its CSS', () => {
  const rule = css.split('\n').find((l) => l.startsWith('.composer textarea {')) ?? '';
  assert.match(rule, /resize: none;/);
  assert.doesNotMatch(rule, /resize: (vertical|both|horizontal)/);
  assert.match(rule, /min-height: 44px;/);
  assert.match(rule, /max-height: 180px;/);
});
