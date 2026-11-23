// scripts/load-order.mjs: a module that reads, while it loads, a const/let/class it imports from a module in its own
// import cycle is a hazard; a function declaration, a read inside a function and a binding from outside the cycle are not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appFiles, hazardsIn, loadTimeReads, main, moduleFacts, resolveModule } from '../scripts/load-order.mjs';

// a and b import each other; c and d sit outside the cycle
const files: Record<string, string> = {
  'src/a.ts': [
    "import { bConst, bFn, BClass, fromC, aliased, viaLocal, missing } from './b';",
    "import type { BType } from './b';",
    "import './d';",
    "import React from 'react';",
    'export const readsConst = bConst;',
    'export const callsFn = bFn();',
    'export const makes = new BClass();',
    'export const outside = fromC;',
    'export const renamed = aliased;',
    'export const local = viaLocal;',
    'export const gone = missing;',
    'export const later = () => bConst;',
    'export function deferred() { return bConst + React.version; }',
    'export type Uses = BType;',
    'export const A = 1;',
  ].join('\n'),
  'src/b.ts': [
    "import { A } from './a';",
    'export const bConst = A + 1;',
    'export function bFn() { return 1; }',
    'export class BClass {}',
    'export type BType = number;',
    "export { fromC } from './c';",
    'const inner = 3;',
    'export { inner as aliased };',
    "import { cConst } from './c';",
    'export { cConst as viaLocal };',
  ].join('\n'),
  'src/c.ts': 'export const fromC = 2;\nexport const cConst = 4;',
  'src/d.ts': 'export const d = 1;',
};

function repo(t: { after: (fn: () => void) => void }) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'load-order-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

test('a load-time read of a const, class or unknown binding from the reader’s own cycle is a hazard; nothing else is', (t) => {
  const dir = repo(t);
  const hazards = hazardsIn(Object.keys(files), dir).map((h: any) => `${h.file} ${h.name} ${h.kind}`);
  // b reads a's A to make bConst while a is still waiting on b: the cycle's other side, a hazard too
  assert.deepEqual(hazards, [
    'src/a.ts aliased const',
    'src/a.ts BClass class',
    'src/a.ts bConst const',
    'src/a.ts missing unknown',
    'src/b.ts A const',
  ]);
});

test('resolveModule names repository code files only', (t) => {
  const dir = repo(t);
  assert.equal(resolveModule('./b', 'src/a.ts', dir), 'src/b.ts');
  assert.equal(resolveModule('react', 'src/a.ts', dir), null);
  assert.equal(resolveModule('./nope', 'src/a.ts', dir), null);
});

test('moduleFacts reads value imports, dependencies, declarations and exports, leaving types out', (t) => {
  const dir = repo(t);
  const b = moduleFacts('src/b.ts', files['src/b.ts'], dir);
  assert.deepEqual([...b.deps].sort(), ['src/a.ts', 'src/c.ts']);
  assert.deepEqual(Object.fromEntries(b.declared), { bConst: 'const', bFn: 'function', BClass: 'class', inner: 'const' });
  assert.deepEqual(b.exported.get('aliased'), { local: 'inner' });
  assert.deepEqual(b.exported.get('fromC'), { from: 'src/c.ts', name: 'fromC' });
  assert.equal(b.exported.has('BType'), false);
  const a = moduleFacts('src/a.ts', files['src/a.ts'], dir);
  assert.ok(a.deps.has('src/d.ts'), 'a side-effect import is a dependency');
  assert.equal(a.imports.has('BType'), false);
  assert.equal(a.imports.has('React'), false);
});

test('loadTimeReads skips function bodies, imports, function and type declarations', (t) => {
  const dir = repo(t);
  const { program } = moduleFacts('src/a.ts', files['src/a.ts'], dir);
  const names = new Set(['bConst', 'bFn']);
  const read = program.body.map((st: any) => [...loadTimeReads(st, names)]);
  assert.deepEqual(read.flat().sort(), ['bConst', 'bFn']);
  assert.deepEqual([...loadTimeReads({ type: 'ExportNamedDeclaration', declaration: null }, names)], []);
});

test('the check covers src and shared code, and the command reports this checkout', () => {
  const all = appFiles();
  assert.ok(all.includes('src/store/agentWiring.ts') && all.some((f: string) => f.startsWith('shared/')));
  assert.ok(!all.some((f: string) => f.endsWith('.d.ts') || f.includes('/protocol/')));
  const lines: string[] = [];
  assert.deepEqual(main([], { log: (s: string) => lines.push(s) }), []);
  const r = spawnSync(process.execPath, ['scripts/load-order.mjs'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('main names each hazard it finds', (t) => {
  const dir = repo(t);
  const lines: string[] = [];
  const hazards = main([], { log: (s: string) => lines.push(s), repoRoot: dir });
  assert.equal(hazards.length, 5);
  assert.match(lines[0], /^src\/a\.ts: reads aliased at load, a const from src\/b\.ts in its own import cycle$/);
});

// the edges: string export names, a hole in an array, a re-export loop, a module outside the files read, an undeclared export
const edges: Record<string, string> = {
  'src/e.ts': [
    "import { 'quoted' as quotedLocal, viaLoop, fromOutside, ghost } from './f';",
    'export const hole = [, quotedLocal];',
    'export const loop = viaLoop;',
    'export const outside = fromOutside;',
    'export const spooky = ghost;',
    'export const E = 1;',
  ].join('\n'),
  'src/f.ts': [
    "import { E } from './e';",
    'const inner = 1;',
    "export { inner as 'quoted' };",
    "export { 'viaLoop' as viaLoop } from './g';",
    "export { fromOutside } from './outside';",
    "export { fromOutside as 'outsideQuoted' } from './outside';",
    'export { ghost };',
    'export function useE() { return E; }',
  ].join('\n'),
  'src/g.ts': "export { viaLoop } from './f';\nimport './f';",
  'src/outside.ts': 'export const fromOutside = 1;',
};

test('string export names, holes, re-export loops, unread modules and undeclared exports are each judged', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'load-order-edges-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(edges)) {
    mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  // outside.ts is not among the files read: its binding is from outside the cycle
  const hazards = hazardsIn(['src/e.ts', 'src/f.ts', 'src/g.ts'], dir).map((h: any) => `${h.name} ${h.kind}`);
  assert.deepEqual(hazards, ['ghost unknown', 'quotedLocal const', 'viaLoop unknown']);
});
