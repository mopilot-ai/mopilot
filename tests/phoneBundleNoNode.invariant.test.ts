// The phone bundle has no Node: Metro cannot resolve `node:*`, `createRequire` or a file read relative to `import.meta.url`, so any
// of them in a module the phone reaches breaks the release archive (X3, #2709: shared/host/schema.mjs began loading method files from disk).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { phoneReachable, packageName } from './phoneBundleDependencies.invariant.test.ts';

const ROOT = resolve('.');
const NODE_ONLY = [
  /\bcreateRequire\b/,
  /\bimport\.meta\.url\b/,
  /\bimport\.meta\.(?:dirname|filename)\b/,
  /\b__dirname\b/,
  /\b__filename\b/,
];

/** The ways one source file reaches for Node: a built-in import, `createRequire`, a path made from its own location. */
export function nodeUses(source: string, specs: string[]): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [
    ...specs.filter((s) => s.startsWith('node:') || packageName(s) === 'electron').map((s) => `imports ${s}`),
    ...NODE_ONLY.filter((re) => re.test(code)).map((re) => `uses ${re.source.replace(/\\b|\\/g, '')}`),
  ];
}

test('no module the phone reaches uses a Node built-in, createRequire or its own file location', () => {
  const bad: string[] = [];
  for (const [file, specs] of phoneReachable()) {
    for (const use of nodeUses(readFileSync(file, 'utf8'), specs)) bad.push(`${relative(ROOT, file)} ${use}`);
  }
  assert.deepEqual(bad, []);
});

test('the scan names each way a file reaches for Node, and skips comments', () => {
  const src = '// createRequire(import.meta.url)\nconst r = createRequire(import.meta.url);\nconst d = __dirname;';
  assert.deepEqual(nodeUses(src, ['node:fs', 'electron', 'react']), [
    'imports node:fs',
    'imports electron',
    'uses createRequire',
    'uses import.meta.url',
    'uses __dirname',
  ]);
  assert.deepEqual(nodeUses('// createRequire\nexport const x = 1;', []), []);
});
