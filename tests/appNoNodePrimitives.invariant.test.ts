// The app never seals with Node's crypto primitives (shared/remote/nodePrimitives.mjs): they use node:crypto's chacha20-poly1305, which Electron's BoringSSL does not have, so a module of the app that builds them fails in the running app while its tests (under Node) pass (#5734). The app uses libsodium's (electron/platform/sodiumPrimitives.cjs); the Host, which runs on Node, keeps Node's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');

/** Every file under a folder whose name ends in one of `exts`. */
const filesUnder = (dir: string, exts: string[]): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return filesUnder(rel, exts);
    return exts.some((x) => e.name.endsWith(x)) ? [rel] : [];
  });

test('no module of the app uses Node’s crypto primitives: in Electron they cannot seal', () => {
  const users = filesUnder('electron', ['.cjs', '.mjs', '.js']).filter((f) =>
    /nodePrimitives/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')),
  );
  assert.deepEqual(users, [], 'use createSodiumPrimitives (electron/platform/sodiumPrimitives.cjs) in the app');
});

/** The relative modules a source file loads (require, import, dynamic import). */
const loadsOf = (file: string): string[] => {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const specs = [...text.matchAll(/(?:require\(|import\(|from\s+|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]);
  return specs
    .map((s) => path.normalize(path.join(path.dirname(file), s)))
    .filter((p) => fs.existsSync(path.join(ROOT, p)) && fs.statSync(path.join(ROOT, p)).isFile());
};

test('nothing the app loads, its own modules or the Host and shared modules they import, seals with node:crypto’s chacha20-poly1305', () => {
  const seen = new Set<string>();
  const queue = filesUnder('electron', ['.cjs', '.mjs', '.js']);
  while (queue.length) {
    const f = queue.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const next of loadsOf(f)) if (!seen.has(next)) queue.push(next);
  }
  const users = [...seen].filter((f) => /create(?:De)?cipheriv\(\s*['"]chacha20/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepEqual(users, [], 'Electron has no chacha20-poly1305: seal with libsodium in what the app loads');
  // the walk reaches into the Host's and the shared modules the app imports, not only electron/
  assert.ok([...seen].some((f) => f.startsWith('shared/')));
});
