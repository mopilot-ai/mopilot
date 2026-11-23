// Text the model reads is never cut with a bare "…" (#3571 Codex × IAB): read_page cut an email's body at 300 characters
// and Codex took the cut for the page's own end, so the start date, manager and bank details "were not in the email". A cut
// in the tools' code says how much it left out (`clip` in shared/clippedText.mjs, "… [+N chars]"). This test fails on a
// new bare-ellipsis cut under electron/capabilities; a file whose cuts only reach people (cards, panels, cursor labels) or
// cut an identifier rather than content is listed below with why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GUARDS = ['electron/capabilities/', 'shared/clippedText.mjs'];

const root = fileURLToPath(new URL('../', import.meta.url));

/** Files whose bare-ellipsis cuts are not content the model reads, and why. */
const NOT_MODEL_CONTENT: Record<string, string> = {
  'electron/capabilities/browser/agentCursorLabels.cjs': 'the agent cursor label people see on the page',
  'electron/capabilities/browser/agentCursorOverlay.cjs': 'the agent cursor label people see on the page',
  'electron/capabilities/browser/chromePanelLive.cjs': "the Chrome side panel's step lines, for people",
  'electron/capabilities/contract/chromePanelStep.cjs': "the Chrome side panel's step details, for people",
  'electron/capabilities/contract/policy.cjs': 'approval card text, for people',
  'electron/capabilities/contract/taintLedger.cjs': 'confirmation card text, for people',
  'electron/capabilities/browser/hostUtil.cjs':
    'oneLine: a tab title or URL in a result header, an identifier read whole with browser_script',
  'electron/capabilities/tools/chatList.cjs': 'a chat title as the sidebar shows it, an identifier',
  'electron/capabilities/browser/devtools/a11yAudit.cjs': "a violating element's opening tag, an identifier of the element",
  'electron/capabilities/browser/devtools/harRecorder.cjs': 'a request body inside the saved HAR file, not a tool result',
};

/** A cut that ends in an ellipsis with nothing after it: `${…}…` closing a template, or + '…' / + '…'. */
const BARE_CUT = /\}(?:…|\\u2026)`|\+\s*(['"])(?:…|\\u2026)\1/g;

function* sources(dir: string): Generator<string> {
  for (const e of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) yield* sources(rel);
    else if (/\.(c|m)?js$/.test(e.name)) yield rel;
  }
}

test('no tool code under electron/capabilities cuts text for the model with a bare ellipsis', () => {
  const found: string[] = [];
  for (const file of sources('electron/capabilities')) {
    if (NOT_MODEL_CONTENT[file]) continue;
    const lines = readFileSync(path.join(root, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (line.match(BARE_CUT)) found.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, [], 'mark the cut with clip() from shared/clippedText.mjs ("… [+N chars]")');
});

test('every file listed as not model content still exists and still cuts', () => {
  for (const file of Object.keys(NOT_MODEL_CONTENT)) {
    const text = readFileSync(path.join(root, file), 'utf8');
    assert.match(text, new RegExp(BARE_CUT.source), `${file} no longer cuts with a bare ellipsis: remove it from the list`);
  }
});

test('the pattern finds the cuts it is for and passes a marked one', () => {
  const hits = (s: string) => (s.match(BARE_CUT) ?? []).length;
  assert.equal(hits('const c = `${prefixUnits(t, n - 1)}…`;'), 1);
  assert.equal(hits("return chars.slice(0, 9).join('') + '\\u2026';"), 1);
  assert.equal(hits('return `${kept}… [+${n} chars]`;'), 0);
  assert.equal(hits("const more = ', …';"), 0);
});
