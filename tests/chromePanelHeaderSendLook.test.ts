// The Chrome side panel's toolbar hairline and disabled Send (electron/chrome-extension/sidepanel.css, #3046 batch B1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'electron', 'chrome-extension', 'sidepanel.css'), 'utf8');
const rule = (selector: string) => css.split('\n').find((l) => l.startsWith(`${selector} {`)) ?? '';

test('the toolbar has a 1px hairline under it, in the panel line color', () => {
  assert.match(rule('.bar'), /border-bottom: 1px solid var\(--line\);/);
});

test('a disabled Send is drawn at 50%', () => {
  assert.match(rule('.send:disabled'), /opacity: 0\.5;/);
});
