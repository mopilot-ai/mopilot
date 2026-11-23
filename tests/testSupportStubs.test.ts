// The shared stub helpers other tests rely on: tests/support/source-modules.ts reads imports and exports
// with a parser, and tests/support/stubs.ts refuses a stub for an export the real module doesn't have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { importsToStub, resolveSource, sourceExports, sourceImports } from './support/source-modules.ts';
import { fakeStore, iconNames, iconStubs, mockSource, nullIcon, popoverStubs, taggedIcon } from './support/stubs.ts';

function fixture(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'source-modules-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  return (name: string) => pathToFileURL(path.join(dir, name));
}

const at = fixture({
  'unit.tsx': [
    'import Default, { a, type T, b as c,',
    '} from "./dep";',
    'import type { Only } from "./types";',
    'import * as ns from "./ns";',
    'import "./side.css";',
    'import { useState } from "react";',
    'import { own } from "./unit2";',
    'export const x = <div />;',
  ].join('\n'),
  'unit2.ts': 'export const own = 1;',
  'dep.ts': 'export default 1; export const a = 1, b = 2; export type T = 1;',
  'types.ts': 'export interface Only {}',
  'ns/index.ts': 'export * from "./more"; export function n() {}',
  'ns/more.ts': 'export const m = 1; export default 2;',
  'side.css': '',
  'pkg.ts': 'export * from "node:path"; export { a as renamed, type T } from "./dep"; export class K {}',
  'broken.ts': 'export const = ;',
});

test('imports: default, named and aliased names, without type-only or side-effect imports', () => {
  assert.deepEqual(sourceImports(at('unit.tsx')), [
    { specifier: './dep', names: ['default', 'a', 'b'] },
    { specifier: './ns', names: ['m', 'n'] },
    { specifier: 'react', names: ['useState'] },
    { specifier: './unit2', names: ['own'] },
  ]);
});

test('exports: re-exports from files and packages, renames, classes; types left out', () => {
  assert.deepEqual(sourceExports(at('ns/index.ts')).sort(), ['m', 'n']);
  const pkg = sourceExports(at('pkg.ts'));
  assert.ok(pkg.includes('join') && pkg.includes('renamed') && pkg.includes('K'));
  assert.ok(!pkg.includes('T') && !pkg.includes('default'));
  assert.throws(() => sourceExports(at('broken.ts')), /broken\.ts/);
});

test('what to stub: relative modules other than the units and those kept, merged by file', () => {
  const stubs = importsToStub([at('unit.tsx'), at('unit2.ts')], (m) => m.pathname.endsWith('/ns/index.ts'));
  assert.deepEqual([...stubs], [[at('dep.ts').href, new Set(['default', 'a', 'b'])]]);
  assert.equal([...importsToStub([at('unit.tsx')])].length, 3);
  assert.throws(() => resolveSource('./missing', at('unit.tsx')), /cannot resolve \.\/missing/);
});

test('mockSource rejects a stub for an export the module does not have', () => {
  assert.throws(
    () => mockSource('src/lib/platform.ts', { isWin: false, notAnExport: 1 }),
    /src\/lib\/platform\.ts has no export named notAnExport/,
  );
});

test('icon stand-ins cover every icon, lucide included, and can be tagged or overridden', () => {
  assert.ok(iconNames.includes('SideChatIcon') && iconNames.includes('ChevronDown'));
  const icons = iconStubs(taggedIcon, { X: nullIcon });
  assert.equal(Object.keys(icons).length, iconNames.length);
  assert.deepEqual((icons.Check({ 'aria-label': 'ok' }) as any).props, { 'data-icon': 'Check', 'aria-label': 'ok' });
  assert.equal(icons.X({}), null);
  assert.equal(iconStubs().Check({}), null);
});

test('the store stand-in merges updates, notifies through `notify`, and resets', () => {
  const ran: string[] = [];
  const store = fakeStore({ a: 1, b: 1 }, (run) => (ran.push('notify'), run()));
  let seen = 0;
  const off = store.subscribe(() => seen++);
  store.set({ a: 2 });
  store.setState((s) => ({ b: s.a + 1 }));
  assert.deepEqual(store.get(), { a: 2, b: 3 });
  assert.equal(store.useStore.getState(), store.getState());
  store.reset({ a: 0, b: 0 });
  off();
  store.set({ a: 5 });
  assert.equal(seen, 3);
  assert.equal(ran.length, 4);
  assert.deepEqual(fakeStore({ n: 1 }).getState(), { n: 1 });
});

test('the Popover stand-ins name only what Popover.tsx exports', () => {
  const real = new Set(sourceExports(new URL('../src/components/ui/Popover.tsx', import.meta.url)));
  for (const name of Object.keys(popoverStubs())) assert.ok(real.has(name), name);
});
