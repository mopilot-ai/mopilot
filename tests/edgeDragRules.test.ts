// The raw-edge-drag lint guard (lint/rules/raw-edge-drag.grit) through the production Biome configuration, and the
// stylesheet scoping that keeps a drag's per-frame width from restyling a panel's content (#2049).
// docs/bug-prevention/render-cost.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

const hits = (input: string, path = 'src/components/Pane.tsx') =>
  lintFixtures({ [path]: input })
    .diagnostics.filter((d: any) => d.message.includes('[raw-edge-drag]'))
    .map((d: any) => d.location?.start?.line);

test("a drag's own window mousemove or pointermove listener warns", () => {
  for (const input of [
    "window.addEventListener('mousemove', move);",
    'window.addEventListener("mousemove", (e) => setWidth(e.clientX));',
    "window.addEventListener('pointermove', move);",
  ])
    assert.deepEqual(hits(`export const f = (move, setWidth) => {\n  ${input}\n};\n`), [2], input);
});

test('other listeners, the document, element handlers and the shared helper itself do not warn', () => {
  for (const input of [
    "window.addEventListener('mouseup', up);",
    "window.removeEventListener('mousemove', move);",
    "document.addEventListener('pointermove', hover, { passive: true });",
    "el.addEventListener('mousemove', move);",
  ])
    assert.deepEqual(hits(`export const f = (move, up, hover, el) => {\n  ${input}\n};\n`), [], input);
  assert.deepEqual(hits("export const f = (move) => window.addEventListener('mousemove', move);\n", 'src/lib/edgeDrag.ts'), []);
  assert.deepEqual(hits("export const f = (move) => window.addEventListener('mousemove', move);\n", 'electron/drag.cjs'), []);
});

const css = (file: string) => fs.readFileSync(new URL(`../src/styles/app/${file}`, import.meta.url), 'utf8');

test("a drag's lock keeps its cursor over the whole app and stops text selection, on either axis (#3833)", () => {
  const lock = css('side-pane.css');
  assert.match(lock, /html\[data-edge-drag\] \{\s*user-select: none;/);
  assert.match(lock, /html\[data-edge-drag='column'\] \* \{\s*cursor: col-resize !important;/);
  assert.match(lock, /html\[data-edge-drag='row'\] \* \{\s*cursor: row-resize !important;/);
});

test('the side pane width a drag sets each frame is not inherited past the pane its children', () => {
  const motion = css('motion.css');
  assert.match(motion, /@property --pane-w \{[^}]*inherits: false;/);
  assert.match(motion, /\.side-pane:not\(\.full\) > \*:not\(\.pane-resize\) \{\s*--pane-w: inherit;\s*min-width: var\(--pane-w\);/);
});

test("the sidebar's width stops at the chat column, and nothing inside it reads the width", () => {
  assert.match(css('main.css'), /\.main \{[^}]*--sidebar-w: initial;/);
  // every reader of --sidebar-w in src/ is outside .main: the sidebar, the title bar and the page navigation column
  const readers = new Set<string>();
  const src = new URL('../src/', import.meta.url);
  for (const file of fs.readdirSync(src, { recursive: true }) as string[]) {
    if (!/\.(css|tsx?)$/.test(file)) continue;
    const text = fs.readFileSync(new URL(file, src), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    if (!file.endsWith('.css')) {
      assert.doesNotMatch(text, /var\(--sidebar-w\)/, `${file} reads the sidebar's width in script`);
      continue;
    }
    for (const m of text.matchAll(/([^{}]+)\{[^}]*var\(--sidebar-w\)/g)) readers.add(m[1].trim().split(/\s+/)[0]);
  }
  assert.deepEqual([...readers].sort(), ['.page-nav-column', '.sidebar', '.sidebar.settings-nav', '.titlebar-main.sidebar-open']);
});
