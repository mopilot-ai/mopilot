// Whole-repository rule: the phone's web preview (mobile/preview) has a double for every native module mobile/src imports, exporting each name the app imports, so the preview keeps starting (#3465).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { commonJsSources, LOCAL_DOUBLES, NATIVE_DOUBLES } from '../mobile/preview/vite.config.mjs';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const preview = path.join(root, 'mobile/preview');
/** Packages that run under react-native-web as they are (the preview defines the globals they read). */
const WEB_READY = new Set(['react-native-reanimated', 'react-native-web']);
const NATIVE = /^(expo-|@expo\/|react-native-)/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return sources(file);
    return /\.(ts|tsx)$/.test(name) ? [file] : [];
  });
}

/** Each module a file imports, with the value names it takes by name (`default` for a default import). */
export function importsOf(text: string): Array<{ module: string; names: string[] }> {
  const out: Array<{ module: string; names: string[] }> = [];
  for (const m of text.matchAll(/import\s+(type\s+)?([^'";]*?)\s*from\s*'([^']+)'/g)) {
    if (m[1]) continue;
    const clause = m[2];
    const names: string[] = [];
    const braces = clause.match(/\{([^}]*)\}/);
    for (const part of braces?.[1].split(',') ?? []) {
      const name = part.trim();
      if (name && !name.startsWith('type ')) names.push(name.split(/\s+as\s+/)[0]);
    }
    const head = clause
      .replace(/\{[^}]*\}/, '')
      .replace(/,/g, ' ')
      .trim();
    if (head && !head.startsWith('*')) names.push('default');
    out.push({ module: m[3], names });
  }
  for (const m of text.matchAll(/import\(\s*'([^']+)'\s*\)/g)) out.push({ module: m[1], names: [] });
  return out;
}

/** The names a double exports. */
export function exportsOf(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/export\s+(?:const|let|class|function|type|interface)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of text.matchAll(/export\s+\{([^}]*)\}/g))
    for (const part of m[1].split(','))
      if (part.trim())
        names.add(
          part
            .trim()
            .split(/\s+as\s+/)
            .at(-1) as string,
        );
  if (/export\s+default\b/.test(text)) names.add('default');
  return names;
}

const doubles: Record<string, string> = {
  ...Object.fromEntries(Object.entries(LOCAL_DOUBLES).map(([name, file]) => [name, path.join(preview, file as string)])),
  ...Object.fromEntries(Object.entries(NATIVE_DOUBLES).map(([name, file]) => [name, path.join(preview, 'native', file as string)])),
};

test('every native module mobile/src imports has a preview double that exports what the app imports', () => {
  const problems: string[] = [];
  for (const file of sources(path.join(root, 'mobile/src'))) {
    for (const { module, names } of importsOf(readFileSync(file, 'utf8'))) {
      if (!NATIVE.test(module) || WEB_READY.has(module)) continue;
      const double = doubles[module];
      const where = path.relative(root, file);
      if (!double) {
        problems.push(`${where}: ${module} has no double in mobile/preview/vite.config.mjs`);
        continue;
      }
      const exported = exportsOf(readFileSync(double, 'utf8'));
      for (const name of names) if (!exported.has(name)) problems.push(`${where}: ${path.relative(root, double)} does not export ${name}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every double the preview names exists', () => {
  for (const file of Object.values(doubles)) assert.ok(existsSync(file), file);
});

test('the import and export readers see each form, and skip type-only imports', () => {
  assert.deepEqual(importsOf("import Animated, { Easing, type X, FadeIn as In } from 'react-native-reanimated';"), [
    { module: 'react-native-reanimated', names: ['Easing', 'FadeIn', 'default'] },
  ]);
  assert.deepEqual(importsOf("import * as Haptics from 'expo-haptics';"), [{ module: 'expo-haptics', names: [] }]);
  assert.deepEqual(importsOf("import type { A } from 'expo-audio';"), []);
  assert.deepEqual(importsOf("const C = await import('expo-clipboard');"), [{ module: 'expo-clipboard', names: [] }]);
  assert.deepEqual(
    [...exportsOf('export const a = 1;\nexport class B {}\nexport type C = 1;\nexport { d, e as f };\nexport default {};')],
    ['a', 'B', 'C', 'd', 'f', 'default'],
  );
});

test('the preview serves the CommonJS files the app imports as ESM, and refuses any other CommonJS shape', () => {
  const plugin = commonJsSources();
  const source = "// lines\nconst { A, B } = require('../x.mjs');\nconst f = () => A;\nmodule.exports = { f, B };\n";
  assert.deepEqual(plugin.transform(source, '/repo/electron/lines.cjs?import'), {
    code: "// lines\nimport { A, B } from '../x.mjs';\nconst f = () => A;\nexport { f, B };\n",
    map: null,
  });
  assert.equal(plugin.transform(source, '/repo/src/lines.mjs'), null, 'not CommonJS');
  assert.equal(plugin.transform(source, '/repo/node_modules/x/index.cjs'), null, 'dependencies are pre-bundled');
  assert.throws(() => plugin.transform("const x = require('y');\nexports.a = 1;\n", '/repo/a.cjs'), /cannot serve \/repo\/a\.cjs/);
  // the real file the app reaches today converts cleanly
  const real = path.join(root, 'electron/capabilities/browser/chromePanelToolLines.cjs');
  assert.match(plugin.transform(readFileSync(real, 'utf8'), real)?.code ?? '', /^export \{ toolLine, stateOfCall, say, line \};$/m);
});
