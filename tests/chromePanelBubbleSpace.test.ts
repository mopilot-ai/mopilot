// A user message's bubble in the Chrome side panel (electron/chrome-extension/sidepanel.css) is as tall as its text: its Copy button
// takes no room inside it (the always-there, clear button was a blank row under every message, #3046).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'electron', 'chrome-extension', 'sidepanel.css'), 'utf8');

/** The declarations of the one rule with exactly this selector. */
function rule(selector: string): Record<string, string> {
  const found = [...css.matchAll(/(^|\n)([^{}\n]+)\{([^}]*)\}/g)].filter((m) => m[2].trim() === selector);
  assert.equal(found.length, 1, `one rule for ${selector}`);
  return Object.fromEntries(
    found[0][3]
      .split(';')
      .map((d) => d.split(/:(.*)/s).map((x) => x.trim()))
      .filter(([k]) => k),
  );
}

test('a message bubble’s Copy is out of the bubble’s flow, and out of the way of what is under it until the bubble is hovered', () => {
  assert.equal(rule('.you').position, 'relative');
  const copy = rule('.you > .message-copy');
  // beside the bubble's text, not in it: no height of its own inside the bubble
  assert.equal(copy.position, 'absolute');
  assert.equal(copy.top, '100%');
  assert.equal(copy.display, undefined, 'never a block row of the bubble');
  // clear until hovered, and then it must not catch clicks meant for the next message either
  assert.equal(copy['pointer-events'], 'none');
  assert.equal(rule('.you:hover > .message-copy, .you > .message-copy:focus-visible')['pointer-events'], 'auto');
  assert.match(css, /\.you:hover \.message-copy[^{]*\{ opacity: 1; \}/);
});

test('a reply keeps its Copy row, which has no bubble to leave blank', () => {
  assert.equal(rule('.reply > .message-copy').display, 'block');
});
