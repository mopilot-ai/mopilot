// The default harness for new chats is one pref read through one resolver: nothing reads or writes the two old
// fields (`harness` + `basicHarness`) outside the migration, and nothing reads `prefs.defaultHarness` but the store.
// E2E persistence checks use the current schema; legacy seed objects and exact old-key absence assertions stay valid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { treeFiles } from '../scripts/source-tree.mjs';
import { parseSync, type ESTree } from 'vite';
import { invariantTestsFor } from '../scripts/related-tests.mjs';

export const GUARDS = ['electron/', 'shared/', 'src/', 'tests/e2e/'];

const ROOT = join(import.meta.dirname, '..');
const SOURCES = ['src', 'electron', 'shared'].flatMap((d) => treeFiles(join(ROOT, d), /\.(tsx?|jsx?|cjs|mjs|mts)$/));
const E2E_CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** The migration is the one place that knows the old fields. */
const MIGRATION = new Set(['shared/defaultHarness.mjs', 'shared/defaultHarness.d.mts']);
/** The store's accessors (savedDefaultHarness, setDefaultHarness) are the one place that touches the pref itself. */
const OWNER = new Set(['src/store/chats.ts']);

/** Ignore syntax-only wrappers when identifying the value an assertion actually checks. */
function unwrapped(node: ESTree.Node): ESTree.Node {
  switch (node.type) {
    case 'ChainExpression':
    case 'ParenthesizedExpression':
    case 'TSAsExpression':
    case 'TSTypeAssertion':
    case 'TSNonNullExpression':
      return unwrapped(node.expression);
    default:
      return node;
  }
}

function memberName(node: ESTree.Node): string | undefined {
  if (node.type !== 'MemberExpression') return;
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.property.type === 'Literal' && typeof node.property.value === 'string') return node.property.value;
}

/** A direct prefs object/accessor, including optional and bracket access; arbitrary aliases still need review. */
function isPrefs(node: ESTree.Node): boolean {
  node = unwrapped(node);
  if (node.type === 'CallExpression') node = node.callee;
  return (node.type === 'Identifier' && node.name === 'prefs') || memberName(node) === 'prefs';
}

function legacyRead(node: ESTree.Node): boolean {
  return node.type === 'MemberExpression' && ['harness', 'basicHarness'].includes(memberName(node) ?? '') && isPrefs(node.object);
}

/** Only an assertion on the raw field's absence is safe; a fallback or a negated assertion is a live-value read. */
function absenceArgument(node: ESTree.Node): ESTree.Node | undefined {
  if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
  const matcher = memberName(node.callee);
  const expected = node.arguments[0];
  const absent = matcher === 'toBeUndefined' && node.arguments.length === 0;
  const undefinedValue = expected?.type === 'Identifier' && expected.name === 'undefined';
  if (!absent && !(matcher === 'toBe' && node.arguments.length === 1 && undefinedValue)) return;
  const actual = node.callee.object;
  if (actual.type !== 'CallExpression' || actual.callee.type !== 'Identifier' || actual.callee.name !== 'expect') return;
  if (actual.arguments.length !== 1) return;
  return unwrapped(actual.arguments[0]);
}

/** E2E checks observe the persisted schema, never the retired default fields. Seed objects and absence checks are safe. */
function staleE2EDefaultReads(source: string, file = 'default-pref-spec.ts'): number[] {
  const parsed = parseSync(file, source);
  assert.deepEqual(parsed.errors, [], `Could not parse ${file}`);
  const allowed = new Set<ESTree.Node>();
  const found: number[] = [];
  const walk = (node: ESTree.Node) => {
    const absent = absenceArgument(node);
    if (absent) allowed.add(absent);
    if (legacyRead(node) && !allowed.has(node)) found.push(node.start);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((child) => child && typeof child === 'object' && 'type' in child && walk(child));
      else if (value && typeof value === 'object' && 'type' in value) walk(value as ESTree.Node);
    }
  };
  walk(parsed.program);
  return found;
}

function e2eViolations(files: { path: string; text: string }[]): string[] {
  return files.flatMap(({ path, text }) =>
    staleE2EDefaultReads(text, path).map((offset) => `${path}:${text.slice(0, offset).split('\n').length}`),
  );
}

const RULES: { name: string; pattern: RegExp; allowed: Set<string> }[] = [
  // the basic-harness pick as its own field (the list of basic harnesses, basicHarnesses, is something else)
  { name: 'basicHarness field', pattern: /\bbasicHarness\b(?!es)/, allowed: MIGRATION },
  // the first-tier default as its own field: prefs.harness, prefs?.harness, prefs().harness
  { name: 'prefs.harness read', pattern: /\bprefs(?:\(\))?\??\.harness\b/, allowed: MIGRATION },
  { name: 'harness written into prefs', pattern: /\bsetPrefs\(\s*\{[^}]*\bharness\s*:/, allowed: MIGRATION },
  // the new pref: read through defaultHarness()/savedDefaultHarness(), written through setDefaultHarness()
  { name: 'prefs.defaultHarness read', pattern: /\bprefs(?:\(\))?\??\.defaultHarness\b/, allowed: OWNER },
  { name: 'defaultHarness written into prefs', pattern: /\bsetPrefs\(\s*\{[^}]*\bdefaultHarness\s*:/, allowed: OWNER },
];

/** Every line that breaks a rule, as "file:line rule". */
function violations(files: { path: string; text: string }[]) {
  const out: string[] = [];
  for (const { path, text } of files)
    text.split('\n').forEach((line, i) => {
      for (const r of RULES) if (!r.allowed.has(path) && r.pattern.test(line)) out.push(`${path}:${i + 1} ${r.name}`);
    });
  return out;
}

test('no source reads the old default-harness fields or the new pref outside its owner', () => {
  const files = SOURCES.map((f) => ({ path: relative(ROOT, f).split('\\').join('/'), text: readFileSync(f, 'utf8') }));
  assert.deepEqual(violations(files), []);
});

test('the rules catch each old and direct form, and leave the list of basic harnesses and the accessors alone', () => {
  const at = (text: string, path = 'src/components/X.tsx') => violations([{ path, text }]);
  assert.deepEqual(at('const b = s.prefs.basicHarness;'), ['src/components/X.tsx:1 basicHarness field']);
  assert.deepEqual(at("setPrefs({ harness: 'claude' })"), ['src/components/X.tsx:1 harness written into prefs']);
  assert.deepEqual(at('if (prefs().harness === h) go();'), ['src/components/X.tsx:1 prefs.harness read']);
  assert.deepEqual(at('const k = get().prefs.defaultHarness;'), ['src/components/X.tsx:1 prefs.defaultHarness read']);
  assert.deepEqual(at("setPrefs({ model: null, defaultHarness: 'codex' })"), ['src/components/X.tsx:1 defaultHarness written into prefs']);
  assert.deepEqual(at('const all = s.basicHarnesses; const k = savedDefaultHarness(s); setDefaultHarness(k);'), []);
  // a pending switch's or a task's own harness is not the default
  assert.deepEqual(at('if (ps.harness === from) return; const h = task.harness;'), []);
  assert.deepEqual(at('const k = s.prefs.defaultHarness;', 'src/store/chats.ts'), []);
  assert.deepEqual(at('const b = p.basicHarness;', 'shared/defaultHarness.mjs'), []);
});

test('E2E guard catches retired live reads across optional, bracket, accessor and multiline spellings', () => {
  for (const source of [
    `JSON.parse(fs.readFileSync(file, 'utf8')).prefs?.harness`,
    `JSON.parse(fs.readFileSync(file, 'utf8')).prefs?.harness ?? 'codex'`,
    `state.prefs.harness`,
    `state?.prefs?.basicHarness`,
    `state['prefs']['harness']`,
    `prefs['basicHarness']`,
    `prefs().harness`,
    `store.prefs()?.harness`,
    `state.prefs\n  ?.harness`,
    `expect(prefs.harness).toBe('claude')`,
    `expect(prefs.harness ?? 'codex').toBeUndefined()`,
    `expect(prefs.harness).not.toBeUndefined()`,
    `expect(prefs.harness).toBeUndefined('extra')`,
    `expect(prefs.harness, 'extra').toBeUndefined()`,
    `other(prefs.harness).toBeUndefined()`,
    `expect.soft(prefs.harness).toBeUndefined()`,
    `expect(prefs.harness).toBe()`,
    `expect(prefs.harness).toBe(undefined, 'extra')`,
  ])
    assert.equal(staleE2EDefaultReads(source).length, 1, source);
});

test('E2E guard preserves migration seeds, exact old-key absence checks and unrelated harness values', () => {
  for (const source of [
    `test.use({ seed: { uiState: { prefs: { harness: 'claude', basicHarness: 'kimi' } } } })`,
    `expect(state.prefs.harness).toBeUndefined()`,
    `expect(state.prefs?.basicHarness).toBe(undefined)`,
    `expect((state.prefs?.harness as unknown)!).toBeUndefined()`,
    `expect(<unknown>prefs.harness).toBeUndefined()`,
    `expect(prefs['harness']).toBeUndefined()`,
    `expect(state.prefs.defaultHarness).toBe('claude')`,
    `const kind = task.harness; const current = segment.harness;`,
    `const seed = { prefs: { harness: 'claude' } }; const all = state.basicHarnesses;`,
    `const example = 'prefs.harness'; // state.prefs.harness`,
    `state.prefs[0]; state.prefs[dynamicKey];`,
    `expect('harness' in state.prefs).toBe(false)`,
    `const values = [null, , 1];`,
  ])
    assert.deepEqual(staleE2EDefaultReads(source), [], source);
  // A safe assertion must not exempt a live read beside it, or one inside the prefs receiver.
  assert.equal(staleE2EDefaultReads(`expect(prefs.harness).toBeUndefined(); use(prefs.harness);`).length, 1);
  assert.equal(staleE2EDefaultReads(`expect(load(prefs.harness).prefs.harness).toBeUndefined()`).length, 1);
  assert.deepEqual(e2eViolations([{ path: 'tests/e2e/example.spec.ts', text: '\nconst h = state.prefs\n  ?.harness;' }]), [
    'tests/e2e/example.spec.ts:2',
  ]);
  assert.throws(() => staleE2EDefaultReads('const = broken'), /Could not parse/);
});

test('E2E guard includes JavaScript and TypeScript specs and fixture extensions', () => {
  for (const extension of ['js', 'jsx', 'cjs', 'mjs', 'ts', 'tsx', 'cts', 'mts']) {
    const file = `tests/e2e/fixtures/defaultHarness.${extension}`;
    assert.ok(E2E_CODE.test(file), file);
    assert.equal(staleE2EDefaultReads('const h = state.prefs.harness;', file).length, 1, file);
  }
  for (const extension of ['json', 'md', 'js.map', 'ts.snap']) assert.equal(E2E_CODE.test(`fixture.${extension}`), false);
});

test('every E2E spec and fixture reads the current default-harness preference', () => {
  const files = treeFiles(join(ROOT, 'tests/e2e'), E2E_CODE).map((file) => ({
    path: relative(ROOT, file).split('\\').join('/'),
    text: readFileSync(file, 'utf8'),
  }));
  assert.deepEqual(
    e2eViolations(files),
    [],
    'Read the saved defaultHarness value; keep old fields only as migration input or absence assertions.',
  );
});

test('app, E2E and fixture changes retain the default-harness invariant in focused unit checks', () => {
  for (const changed of ['src/harness/defaultHarness.ts', 'tests/e2e/new.spec.ts', 'tests/e2e/fixtures/defaultHarness.ts'])
    assert.ok(invariantTestsFor([changed]).includes('tests/defaultHarnessReaders.test.ts'), changed);
});
