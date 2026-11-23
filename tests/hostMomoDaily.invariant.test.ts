// The day record has one writer (host/src/momoDaily.mjs): a tick resumes any claimed or ready brief, so two instances over one home's directory would both deliver. Exactly one place in the Host makes one, and it makes one per home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('createMomoDaily is called in one place in host/src, momoHomeFor, once', () => {
  const dir = path.join(import.meta.dirname, '..', 'host', 'src');
  const calls: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.mjs$/.test(e.name))
        for (const _ of fs.readFileSync(f, 'utf8').matchAll(/\bcreateMomoDaily\(/g)) calls.push(path.relative(dir, f));
    }
  };
  walk(dir);
  // the definition itself is `export function createMomoDaily(`, which this pattern also matches
  assert.deepEqual(calls.sort(), ['momoDaily.mjs', 'momoWiring.mjs']);
});
