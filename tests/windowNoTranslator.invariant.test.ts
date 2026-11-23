// Whole-repository invariant: the Rust core is the only translator (core/crates/translate), so no translation module comes
// back (shared/acpTranslate.mjs, shared/claudeTranslate.mjs and shared/claudeTranslate/), and nothing a window loads reaches
// one, directly or through a shared helper. One import would quietly bring a second translator into the window, where it drifts.
// Item helpers a window needs live in shared/acpItems/ and shared/claudeItems/ and depend on no translator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { treeFiles } from '../scripts/source-tree.mjs';

export const GUARDS = ['src/', 'shared/'];

const root = fileURLToPath(new URL('../', import.meta.url));
const TRANSLATION = /^shared\/(?:acpTranslate|claudeTranslate)(?:\/|\.|$)/;
const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;
/** Every way a file names another: import, export-from, a type import, import(), require() and a module-relative URL. */
const SPECIFIER = /\b(?:from|import|require)\s*\(?\s*['"`]([^'"`]+)['"`]|\bnew URL\(\s*['"`]([^'"`]+)['"`]\s*,\s*import\.meta\.url/g;

/** The relative specifiers in `text`. */
const specifiers = (text: string) =>
  [...text.matchAll(SPECIFIER)].map((m) => (m[1] ?? m[2]).replace(/[?#].*$/, '')).filter((spec) => spec.startsWith('.'));

const CANDIDATES = ['', '.ts', '.tsx', '.mjs', '.cjs', '.js', '.d.mts', '/index.ts', '/index.mjs', '/index.cjs', '/index.js'];

/** The files `spec` may load: a module and its declaration file, which is what a type import reads. */
function targetsOf(spec: string, from: string, exists: (file: string) => boolean) {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const declared = target.endsWith('.mjs') ? [target.replace(/\.mjs$/, '.d.mts')] : [];
  return { target, files: [...CANDIDATES.map((ext) => target + ext), ...declared].filter(exists) };
}

/**
 * What `entries` reach of the translation modules, each as `file -> module`, following imports through every file they
 * load. A name that matches is reported whether or not such a file exists, so a templated path or a typo counts too.
 */
function translationReach(entries: string[], read: (file: string) => string, exists: (file: string) => boolean) {
  const found = new Set<string>();
  const seen = new Set(entries);
  const queue = [...entries];
  for (const file of queue)
    for (const spec of specifiers(read(file))) {
      const { target, files } = targetsOf(spec, file, exists);
      if (TRANSLATION.test(target)) {
        found.add(`${file} -> ${target}`);
        continue;
      }
      for (const next of files)
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
    }
  return [...found].sort();
}

const onDisk = (file: string) => existsSync(path.join(root, file)) && SOURCE.test(file);
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const below = (dir: string) => treeFiles(path.join(root, dir), SOURCE).map((p) => path.relative(root, p).split(path.sep).join('/'));

test('nothing a window loads reaches a translation module', () => {
  const entries = below('src');
  assert.ok(entries.length > 100, 'the scan found the window');
  assert.ok(entries.includes('src/harness/acpTranslate.ts'));
  assert.deepEqual(translationReach(entries, read, onDisk), []);
});

test('the item helpers depend on no translator', () => {
  const helpers = [...below('shared/acpItems'), ...below('shared/claudeItems')];
  assert.ok(helpers.includes('shared/acpItems/toolItems.mjs') && helpers.includes('shared/claudeItems/failures.mjs'));
  assert.deepEqual(translationReach(helpers, read, onDisk), []);
});

test('the translation modules the guard names are gone', () => {
  for (const file of ['shared/acpTranslate.mjs', 'shared/claudeTranslate.mjs', 'shared/claudeTranslate/translator.mjs']) {
    assert.ok(TRANSLATION.test(file) && !existsSync(path.join(root, file)), file);
  }
  for (const file of ['shared/acpItems/toolItems.mjs', 'shared/claudeItems/tools.mjs', 'shared/claudeTranslateNotes.mjs'])
    assert.ok(!TRANSLATION.test(file), file);
});

test('the guard sees every way of importing a translator, and a helper that brings one along', () => {
  const module = '../shared/claudeTranslate.mjs';
  const forms = [
    `import { buildTurns } from '${module}';`,
    `import type { Emit } from '${module}';`,
    `import '${module}';`,
    `export * from '${module}';`,
    `export { buildTurns } from '${module}';`,
    `const m = await import('${module}');`,
    `const m = await import(\`${module}\`);`,
    `const m = require('${module}');`,
    `const url = new URL('${module}', import.meta.url).href;`,
    `import x from '../shared/claudeTranslate';`,
    `import x from '../shared/claudeTranslate/translator.mjs?raw';`,
    `import x from "../shared/acpTranslate.mjs";`,
  ];
  for (const form of forms) {
    const files: Record<string, string> = { 'src/a.ts': form };
    assert.equal(
      translationReach(
        ['src/a.ts'],
        (f) => files[f],
        (f) => f in files,
      ).length,
      1,
      form,
    );
  }
  const chained: Record<string, string> = {
    'src/a.ts': `import { x } from '../shared/helper.mjs';`,
    'shared/helper.mjs': `import './nested.mjs';`,
    'shared/nested.mjs': `// the types say it\n`,
    'shared/nested.d.mts': `import type { ClaudeTranslator } from './claudeTranslate.mjs';`,
  };
  assert.deepEqual(
    translationReach(
      ['src/a.ts'],
      (f) => chained[f],
      (f) => f in chained,
    ),
    ['shared/nested.d.mts -> shared/claudeTranslate.mjs'],
  );
  const clean: Record<string, string> = {
    'src/a.ts': `// shared/claudeTranslate.mjs is main's\nimport { y } from './claudeTranslate';\nimport pkg from 'claudeTranslate';`,
    'src/claudeTranslate.ts': `import { z } from '../shared/acpItems/toolItems.mjs';`,
    'shared/acpItems/toolItems.mjs': '',
  };
  assert.deepEqual(
    translationReach(
      ['src/a.ts'],
      (f) => clean[f],
      (f) => f in clean,
    ),
    [],
  );
});
