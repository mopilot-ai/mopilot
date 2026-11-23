// The control matrix (docs/control-plane/matrix.md): a page that fails to load is told in words, to the user and the
// agent, on every path that loads one. Every agent load wait that waits for the page to stop loading reads the tab's
// failure (Back onto a form result was a plain success, #1834's ERR_CACHE_MISS report), and no browser code puts
// Chromium's raw errorText or errorDescription into a message: shared/browserNotice.mjs and shared/netErrors.mjs say it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { treeFiles } from '../scripts/source-tree.mjs';

export const GUARDS = ['electron/capabilities/browser/', 'src/components/panels/', 'src/lib/'];

/** The executors whose calls load a page and wait for it. */
const LOADERS = ['electron/capabilities/browser/hostNavigation.cjs', 'electron/capabilities/browser/cdp.cjs'];

/** Each method of a class file, by the indentation the repository's classes use. */
const methods = (src: string) => src.split(/\n {2}(?=(?:async )?[a-zA-Z#]+\([^)]*\) \{)/).slice(1);

test('every agent load wait that waits for the page to stop loading reports its failure', () => {
  let waits = 0;
  for (const file of LOADERS)
    for (const body of methods(fs.readFileSync(file, 'utf8'))) {
      if (!/waitEvent\([^)]*'did-stop-loading'/.test(body)) continue;
      waits++;
      assert.match(body, /\.failure\b/, `${file}: ${body.slice(0, body.indexOf('('))} waits for a load but never reads its failure`);
    }
  assert.ok(waits >= 4, 'navigate, history and loaded in the host, navigate in the panel');
});

test("no browser message carries Chromium's raw errorText or errorDescription in place of words", () => {
  const files = [
    ...treeFiles('electron/capabilities/browser', /\.cjs$/),
    ...treeFiles('src/components/panels', /\.tsx?$/),
    ...treeFiles('src/lib', /^.*browser.*\.ts$/i),
  ];
  const raw = files.flatMap((file) =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) => (/\$\{[\w.]+\.(?:errorText|errorDescription)\}/.test(line) ? [`${file}:${i + 1} ${line.trim()}`] : [])),
  );
  assert.deepEqual(raw, []);
});
