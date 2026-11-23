// The dev host's fake app answers every `svc.ops` call a phone can reach through the Mac's methods, so a method added for the real Mac cannot be missing from the host a phone is tested against.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';

/** Provided by the host around the fake app (its own review and mirror services) or optional on the Mac (`?.` at the call). */
const BY_HOST = new Set(['review', 'mirror']);

test('every svc.ops function the Mac service and its methods call without a guard exists on the fake app', () => {
  const root = path.join(import.meta.dirname, '..', 'electron', 'remote');
  const files = [
    ...readdirSync(root)
      .filter((f) => f.endsWith('.cjs'))
      .map((f) => path.join(root, f)),
    ...readdirSync(path.join(root, 'methods'))
      .filter((f) => f.endsWith('.cjs'))
      .map((f) => path.join(root, 'methods', f)),
  ];
  const called = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    // svc.ops.read, this.ops.read (a call with ?. is optional on the Mac), and const { older } = svc.ops
    for (const m of text.matchAll(/\b(?:svc|this)\.ops\.(\w+)(\?\.)?/g)) if (!m[2]) called.add(m[1]);
    for (const m of text.matchAll(/\{([^{}]*)\}\s*=\s*(?:svc|this)\.ops\b/g))
      for (const name of m[1].split(',')) if (name.trim()) called.add(name.trim().split(':')[0].trim());
  }
  for (const name of ['read', 'older', 'cardsOf', 'items']) assert.ok(called.has(name), `the scan finds ${name}`);
  const app = createFakeApp({ repo: '/repo', log: () => undefined, now: () => 1, sleep: async () => undefined, status: async () => '' });
  const missing = [...called].filter((name) => !BY_HOST.has(name) && !(name in app.ops));
  assert.deepEqual(missing, [], 'the dev host cannot answer these calls a phone makes');
});
