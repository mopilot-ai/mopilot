// Vite's dev server serves a .cjs file as-is, so an ESM `import { x } from './y.cjs'` throws "does not provide an
// export named x" in `npm run dev` while `vite build` (which converts CommonJS) still works (#2505). Shared code that
// the renderer imports is therefore ESM (.mjs with a .d.mts); a .cjs file is only loaded with require().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
// What `vite` serves to the renderer: src/ and everything it reaches in shared/. Node tests, Electron main (.cjs) and
// Next.js (webpack) load a .cjs with their own interop.
const RENDERER_ROOTS = ['src', 'shared'];
const ESM_SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** Value imports of a .cjs module from ESM/TypeScript source: static, re-export, side-effect and dynamic. */
export function cjsImports(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?!type\b)[^'";]*?\bfrom\s*['"]([^'"]+\.cjs)['"]/g,
    /\bimport\s*['"]([^'"]+\.cjs)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+\.cjs)['"]/g,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) found.push(m[1]);
  return found;
}

test('the detector finds value imports of a .cjs and ignores require, type imports and comments-free text', () => {
  assert.deepEqual(cjsImports("import { a } from './x.cjs';"), ['./x.cjs']);
  assert.deepEqual(cjsImports('import x from "../y.cjs"'), ['../y.cjs']);
  assert.deepEqual(cjsImports("export { a } from './x.cjs';"), ['./x.cjs']);
  assert.deepEqual(cjsImports("import './x.cjs';"), ['./x.cjs']);
  assert.deepEqual(cjsImports("const m = await import('./x.cjs');"), ['./x.cjs']);
  assert.deepEqual(cjsImports("const { a } = require('./x.cjs');"), []);
  assert.deepEqual(cjsImports("import type { A } from './x.cjs';"), []);
  assert.deepEqual(cjsImports("import { a } from './x.mjs';"), []);
});

test('no renderer-reachable ESM or TypeScript file imports a .cjs module (use .mjs; a .cjs consumer can require() it)', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', ...RENDERER_ROOTS], { cwd: ROOT, maxBuffer: 1 << 26 })
    .toString()
    .split('\0')
    .filter((f) => ESM_SOURCE.test(f) && !f.endsWith('.cjs') && !f.endsWith('.d.mts') && !f.endsWith('.d.ts'));
  const offenders = files.flatMap((f) => cjsImports(readFileSync(path.join(ROOT, f), 'utf8')).map((s) => `${f} imports ${s}`));
  assert.deepEqual(offenders, []);
});
