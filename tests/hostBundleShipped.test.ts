// What the Host bundle does with TypeScript, and that everything the real Host imports is in it (electron/host/bundle.cjs): types stripped at build time, files shipped as .mjs, nothing relied on from the machine's own Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hostEntries, hostFiles, shipped } = require('../electron/host/bundle.cjs');
const ROOT = path.join(import.meta.dirname, '..');
const ENTRY = 'host/bin/mopilot-host.mjs';
const tmp = (t: any, tag = 'bundle') => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const write = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
/** A repository root with the Host's entry and `files` (path → text). */
function fake(t: any, files: Record<string, string>) {
  const root = tmp(t, 'fake-root');
  write(root, 'host/package.json', JSON.stringify({ name: 'mopilot-host', version: '9.9.9' }));
  for (const [p, text] of Object.entries(files)) write(root, p, text);
  return root;
}

test('TypeScript the Host reaches ships as JavaScript: types stripped, specifiers pointing at the .mjs, its own imports followed, and it runs on a Node with no TypeScript support', async (t) => {
  const root = fake(t, {
    [ENTRY]: "import { a } from '../../shared/momoCore.ts';\nexport const out = a;\n",
    'shared/momoCore.ts':
      "import { b } from './momoB.ts';\nimport type { T } from './momoTypes.ts';\nexport const a: number = b + 1;\nexport type U = T;\nexport function f(x: string): void { void x; }\n",
    'shared/momoB.ts': 'export const b: number = 1;\n',
    'shared/momoTypes.ts': 'export type T = string;\n',
  });
  const entries = hostEntries(root) as { path: string; data: Buffer }[];
  const paths = entries.map((e) => e.path);
  assert.ok(paths.includes('shared/momoCore.mjs') && paths.includes('shared/momoB.mjs'), 'the .ts files ship as .mjs');
  assert.deepEqual(
    paths.filter((p) => p.endsWith('.ts')),
    [],
    'no TypeScript is shipped',
  );
  const text = (rel: string) => entries.find((e) => e.path === rel)!.data.toString('utf8');
  assert.match(text(ENTRY), /from '\.\.\/\.\.\/shared\/momoCore\.mjs'/);
  assert.match(text('shared/momoCore.mjs'), /from '\.\/momoB\.mjs'/);
  assert.doesNotMatch(text('shared/momoCore.mjs'), /: number|: string|import type|export type/);
  // it runs: written out and imported by a plain import, with no type stripping involved
  const out = tmp(t, 'unpacked');
  for (const e of entries) write(out, e.path, e.data.toString('utf8'));
  assert.equal((await import(path.join(out, 'shared/momoCore.mjs'))).a, 2);
  assert.equal(hostFiles(root).filter((f: string) => f.endsWith('.ts')).length, 3, 'the walk lists the sources it read');
});

test('TypeScript that is more than types (an enum, a namespace, a parameter property) is refused when the Host is built, naming the file', (t) => {
  for (const body of [
    'export enum E { A }',
    'export namespace N { export const x = 1; }',
    'export class C { constructor(private a: number) {} }',
  ]) {
    const root = fake(t, { [ENTRY]: "import '../../shared/momoBad.ts';\n", 'shared/momoBad.ts': `${body}\n` });
    assert.throws(() => hostEntries(root), /shared\/momoBad\.ts uses TypeScript that is more than types/);
  }
});

test('everything the real Host imports is in its bundle as JavaScript, whatever it is named: written imports, requires, and the files a template require can name', () => {
  const entries = hostEntries(ROOT) as { path: string; data: Buffer }[];
  const have = new Set(entries.map((e) => e.path));
  assert.deepEqual(
    [...have].filter((p) => p.endsWith('.ts')),
    [],
  );
  let checked = 0;
  let templated = 0;
  // the app's own files: a package under node_modules names its own files its own way (no extension, by folder)
  for (const e of entries.filter((x) => /\.(?:mjs|cjs|js)$/.test(x.path) && !x.path.startsWith('node_modules/'))) {
    const code = e.data
      .toString('utf8')
      .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.[^'"\s]*)['"]/g)) {
      const spec = m[1];
      if (/\.d\.[cm]?ts$/.test(spec)) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(e.path), spec));
      assert.ok(have.has(target), `${e.path} reads ${spec}, which is not in the Host bundle`);
      checked++;
    }
    // `req(`./momoServices/${name}`)`: the packager cannot name the file, so it takes every code file of that folder; each must be there
    for (const m of code.matchAll(/\(\s*`(\.[^`$]*)\$\{[^`]*?\}([^`$}]*)`\s*[,)]/g)) {
      const dir = path.dirname(path.join(ROOT, path.dirname(e.path), `${m[1]}x`));
      const stem = path.basename(`${m[1]}x`).slice(0, -1);
      for (const name of fs
        .readdirSync(dir)
        .filter((n) => n.startsWith(stem) && /\.(?:mjs|cjs|js|ts)$/.test(n) && n.endsWith(m[2]) && !/\.d\.[cm]?ts$/.test(n))) {
        const shippedAs = path.posix.normalize(
          path.posix.join(path.posix.dirname(e.path), path.posix.dirname(`${m[1]}x`), name.replace(/\.ts$/, '.mjs')),
        );
        assert.ok(have.has(shippedAs), `${e.path} can load ${name}, which is not in the Host bundle`);
        templated++;
      }
    }
  }
  assert.ok(checked > 100, 'there are imports to check');
  assert.ok(templated > 0, 'there are template requires to check (the Host’s methods folder)');
});

test('the shipped output of every real TypeScript module the Host reaches under shared/momo* links: a value import of a type-only export, or a missing file, fails here and not on a Host', async (t) => {
  // only what the Host's entry reaches ships; a module no Host imports (the clients' own, with their packages and generated data) is not checked here, and is the day it becomes reachable
  const reached = new Set((hostFiles(ROOT) as string[]).map((f) => path.relative(ROOT, f).split(path.sep).join('/')));
  const real = (fs.readdirSync(path.join(ROOT, 'shared'), { recursive: true }) as string[])
    .map((f) => `shared/${f}`.split(path.sep).join('/'))
    .filter((f) => /^shared\/momo[^/]*(?:\/.*)?\.ts$/.test(f) && !/\.d\.ts$/.test(f) && reached.has(f));
  // none yet is a fact, not a failure: the first TypeScript module a Host imports is checked from that day (the fake-root test above proves the bundler on TypeScript)
  if (real.length === 0) return;
  const out = tmp(t, 'shipped-ts');
  // the module and what it imports, shipped the way the bundle ships them
  const seen = new Set<string>();
  const add = (rel: string) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const made = shipped(rel, fs.readFileSync(path.join(ROOT, rel))) as { path: string; data: Buffer };
    write(out, made.path, made.data.toString('utf8'));
    for (const m of fs
      .readFileSync(path.join(ROOT, rel), 'utf8')
      .matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"\s]*\.(?:ts|mjs|cjs|js))['"]/g)) {
      if (/\.d\.[cm]?ts$/.test(m[1])) continue;
      add(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
    }
  };
  for (const rel of real) add(rel);
  for (const rel of real) await import(path.join(out, rel.replace(/\.ts$/, '.mjs')));
});
