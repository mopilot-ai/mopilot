// Every field the side panel reads from a chat's read answer is one main sends: the usage banner read `r.limit` for months while main never sent it, so its "limit reached"
// state was dead code that no test caught (each side's test fed the other's missing half). The panel's reads of `r.<field>` in PanelThread.read() are checked against
// the sources that build that answer (electron/app/chromePanel.cjs and the helpers it spreads in).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file: string) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

/** The body of PanelThread.read(): from its declaration to the next method. */
function readBody(source: string) {
  const start = source.indexOf('async read() {');
  assert.ok(start > 0, 'PanelThread.read() is still where this test looks for it');
  const end = source.indexOf('\n  }\n', start);
  return source.slice(start, end);
}

test('every field PanelThread.read() takes from the answer is sent by main’s read', () => {
  const fields = new Set(
    [...readBody(read('electron/chrome-extension/src/panelThread.mjs')).matchAll(/\br\??\.([a-zA-Z]+)/g)].map((m) => m[1]),
  );
  // what the panel reads off the answer's rows (their own fields, not the answer's) are not the answer's
  for (const own of ['role', 'text']) fields.delete(own);
  assert.ok(fields.size >= 8, `found the panel's reads: ${[...fields].join(', ')}`);
  const main = ['electron/app/chromePanel.cjs', 'electron/app/chromePanelSignals.cjs', 'electron/capabilities/browser/chromePanelLive.cjs']
    .map(read)
    .join('\n');
  const unsent = [...fields].filter((f) => !new RegExp(`(^|[\\s{,(])${f}\\s*(,|:|\\}|\\)|$)`, 'm').test(main));
  assert.deepEqual(unsent, [], `the panel reads these fields of the chat's read, which main never sends: ${unsent.join(', ')}`);
});
