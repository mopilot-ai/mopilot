// Onboarding copy says what a person sees, not how MoPilot is built (#3518): no "ACP", "CLI", "endpoint", "Basic" or
// "billing type" in the text of the account, billing and other-agent surfaces or in the shared design copy (COPY, the
// capability reasons WHY and WHY_FALLBACK). A
// file is read with its comments, imports and console lines left out; the words are matched whole and case-sensitively,
// so identifiers (endpointLabel, recheckBasic, BasicHarness) don't count. The design copy is read as the values it exports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripComments } from './support/source-strings.ts';
import { treeFiles } from '../scripts/source-tree.mjs';

/** Words that name the plumbing. Case matters: "basic" and "cli" are not banned inside other words or ids. */
export const JARGON = [/\bACP\b/, /\bCLI\b/, /\b[Ee]ndpoints?\b/, /\bBasic\b/, /\b[Bb]illing type\b/];

/** A file holding user-facing account, billing or agent copy declares itself with this line; the check finds it by it. */
export const MARKER = '// @plain-copy:';

/** The files under src that carry the marker. */
export const surfaces = () => treeFiles('src', /\.tsx?$/).filter((f) => fs.readFileSync(f, 'utf8').includes(`\n${MARKER}`));

/** The lines of a source file that can hold copy, with their line numbers: not comments, imports or console output. */
export function textsOf(src: string): { line: number; text: string }[] {
  return stripComments(src)
    .split('\n')
    .map((text, i) => ({ line: i + 1, text }))
    .filter((l) => !/^\s*(?:import\b|export\s.*\bfrom\s)|\bconsole\.\w+\(/.test(l.text));
}

/** Every string a nested copy table holds, with the key path that leads to it. */
export function leaves(v: unknown, at = ''): { key: string; text: string }[] {
  if (typeof v === 'string') return [{ key: at, text: v }];
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => leaves(x, at ? `${at}.${k}` : k));
  return [];
}

const hits = (text: string) => JARGON.filter((w) => w.test(text)).map(String);

test('the jargon check finds each word in text only, never in code', () => {
  const src = [
    "import { recheckBasic, type BasicHarness } from './acp';",
    "export { ACP } from './x';",
    '// over ACP',
    "console.warn('ACP chats');",
    "const a = endpointLabel('acp:kimi', `a ${x} the CLI`);",
    'const b = <p>Basic harnesses run over ACP</p>; /* the CLI */',
    "const c = recheckBasic('API key · billed per token');",
  ].join('\n');
  const found = textsOf(src).flatMap((t) => hits(t.text).map((w) => `${t.line} ${w}`));
  assert.deepEqual(found, ['5 /\\bCLI\\b/', '6 /\\bACP\\b/', '6 /\\bBasic\\b/']);
  assert.deepEqual(hits('Two endpoints and a billing type'), ['/\\b[Ee]ndpoints?\\b/', '/\\b[Bb]illing type\\b/']);
  assert.deepEqual(
    leaves({ a: { b: 'x', c: 1 }, d: 'y' }).map((l) => l.key),
    ['a.b', 'd'],
  );
});

test('account, billing and other-agent surfaces say no ACP, CLI, endpoint, Basic or billing type', () => {
  const files = surfaces();
  // the account, billing and other-agent pages, their copy modules and the picker badge all declare themselves
  assert.ok(files.length >= 12, files.join(', '));
  const found = files.flatMap((f) =>
    textsOf(fs.readFileSync(f, 'utf8')).flatMap((t) => hits(t.text).map((w) => `${f}:${t.line} ${w}: ${t.text.trim()}`)),
  );
  assert.deepEqual(found, []);
});

test('the shared design copy says none of them either', async () => {
  const { COPY, WHY, WHY_FALLBACK } = await import('../src/harness/copy.ts');
  const found = [...leaves(COPY, 'COPY'), ...leaves(WHY, 'WHY'), ...leaves(WHY_FALLBACK, 'WHY_FALLBACK')].flatMap((l) =>
    hits(l.text).map((w) => `${l.key} ${w}: ${l.text}`),
  );
  assert.deepEqual(found, []);
});
