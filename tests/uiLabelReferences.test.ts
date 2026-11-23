// Text that sends someone to a Settings page or tells them to press a button names one that exists (#1860): the model
// was told to press "Check again" on a card whose button said "Try again", and to fix things in "Settings → Harnesses"
// and "Settings → Account", pages that are not in the sidebar. Every `Settings → X` in code names a sidebar page
// (src/lib/settingsNav.ts NAV), and every quoted label after press/click/choose/tap is drawn by the renderer, or is
// interpolated from a shared constant (shared/uiLabels.mjs, shared/doneContinue.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { treeFiles } from '../scripts/source-tree.mjs';
import { stripComments } from './support/source-strings.ts';
import { NAV } from '../src/lib/settingsNav.ts';
import { CHECK_FOR_UPDATES, TRY_AGAIN } from '../shared/uiLabels.mjs';

export const GUARDS = ['electron/', 'shared/', 'src/'];

const FILES = ['src', 'electron', 'shared'].flatMap((r) => treeFiles(r, /\.(ts|tsx|cjs|mjs)$/)).filter((f) => !f.endsWith('.d.ts'));
const PAGES = NAV.map((n) => n.label).sort((a, b) => b.length - a.length);

/** Labels quoted from someone else's UI, which no MoPilot file draws, with whose they are. */
const FOREIGN: Record<string, string> = {
  'Allow & select': "the Playwright Extension's own connect page in Chrome",
  'Reset for free': "Claude's Usage page on the website",
};

/** `Settings → X` (macOS's System Settings left out) whose X starts with no sidebar page, as "file:line X". */
export function badPaths(file: string, text: string): string[] {
  return stripComments(text)
    .split('\n')
    .flatMap((line, i) =>
      [...line.matchAll(/(System )?Settings ?(?:→|\\u2192) ?([^'"`<]{0,40})/g)]
        .filter(
          ([, system, rest]) =>
            !system && !rest.startsWith('${') && !PAGES.some((p) => rest.startsWith(p) && !/\w/.test(rest[p.length] ?? '')),
        )
        .map(([, , rest]) => `${file}:${i + 1} ${rest.trim()}`),
    );
}

/** Labels quoted after press/click/choose/tap, as [file:line, label]; an interpolated one reads a constant. */
export function quotedLabels(file: string, text: string): [string, string][] {
  return stripComments(text)
    .split('\n')
    .flatMap((line, i) =>
      [...line.matchAll(/\b(?:press|click|choose|tap)(?:es|s)?(?: on)? \\?["“]([^"”\\]{2,40})\\?["”]/gi)]
        .filter(([, label]) => !label.startsWith('${'))
        .map(([, label]): [string, string] => [`${file}:${i + 1}`, label]),
    );
}

/** Every label the renderer draws as a whole string or JSX text. */
function drawn(): Set<string> {
  const out = new Set<string>();
  for (const f of treeFiles('src', /\.(ts|tsx)$/)) {
    const t = stripComments(fs.readFileSync(f, 'utf8'));
    for (const m of t.matchAll(/(['"`])([^'"`\n]{2,40})\1/g)) out.add(m[2]);
    for (const m of t.matchAll(/>\s*([^<>{}\n]{2,40}?)\s*</g)) out.add(m[1]);
  }
  return out;
}

const sources = FILES.map((f) => [f, fs.readFileSync(f, 'utf8')] as const);

test('every Settings → X in code names a page in the Settings sidebar', () => {
  assert.deepEqual(
    sources.flatMap(([f, t]) => badPaths(f, t)),
    [],
  );
});

test('every button label text tells someone to press is one the app draws', () => {
  const have = drawn();
  assert.deepEqual(
    sources.flatMap(([f, t]) => quotedLabels(f, t)).filter(([, label]) => !have.has(label) && !FOREIGN[label]),
    [],
  );
  // each foreign label is still quoted somewhere, so the list only shrinks
  const quoted = new Set(sources.flatMap(([f, t]) => quotedLabels(f, t)).map(([, l]) => l));
  assert.deepEqual(
    Object.keys(FOREIGN).filter((l) => !quoted.has(l)),
    [],
  );
});

test('the shared labels are the ones their buttons draw', () => {
  const have = drawn();
  // the renderer draws them through the constant, so they show up as {TRY_AGAIN}, not as text: check the sources
  const card = fs.readFileSync('src/components/thread/ComputerPermissionCard.tsx', 'utf8');
  assert.match(card, /\{TRY_AGAIN\}/);
  assert.match(fs.readFileSync('src/components/pages/settings/About.tsx', 'utf8'), /\{CHECK_FOR_UPDATES\}/);
  assert.equal(TRY_AGAIN, 'Try again');
  assert.equal(CHECK_FOR_UPDATES, 'Check for updates');
  assert.ok(have.size > 100, 'the renderer strings are read');
});

test('the scanners catch a wrong page or label and leave the rest alone', () => {
  assert.deepEqual(badPaths('x.cjs', "const a = 'Fix it in Settings → Harnesses.';"), ['x.cjs:1 Harnesses.']);
  assert.deepEqual(badPaths('x.cjs', "const a = 'Fix it in Settings → Account.';"), ['x.cjs:1 Account.']);
  assert.deepEqual(badPaths('x.cjs', "const a = 'See Settings → Computer use, then Blocked apps';"), []);
  assert.deepEqual(badPaths('x.cjs', "const a = 'Open System Settings → Privacy & Security';"), []);
  assert.deepEqual(badPaths('x.cjs', 'const a = `Switch back in Settings → ${label}.`;'), []);
  assert.deepEqual(badPaths('x.cjs', '// a comment about Settings → Nowhere'), []);
  assert.deepEqual(quotedLabels('x.cjs', `const a = 'then press "Check again" on the card';`), [['x.cjs:1', 'Check again']]);
  assert.deepEqual(quotedLabels('x.cjs', 'const a = `click \\"${DONE}\\" in the chat`;'), []);
  assert.deepEqual(quotedLabels('x.cjs', `const a = "choose \\"Do it here\\"";`), [['x.cjs:1', 'Do it here']]);
});
