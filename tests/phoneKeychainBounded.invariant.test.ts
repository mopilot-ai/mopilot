// Whole-repository rule: every keychain call in the phone app (expo-secure-store's get/set/deleteItemAsync under mobile/src) runs inside keychain(...) from mobile/src/bounded.ts, so a keychain that never answers fails with a reason instead of leaving a screen loading forever (#3644: a fresh iOS 27.0 simulator stayed on "Loading your account…").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const GUARDS = ['mobile/src/bounded.ts'];

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'mobile', 'src');
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(path.join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(dir, entry.name)] : [],
  );

/** The name of the call whose argument list encloses `at`: walk back to the unmatched "(" and read the identifier before it. */
function enclosingCall(text: string, at: number): string | null {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = text[i];
    if (c === ')') depth++;
    else if (c === '(') {
      if (depth === 0) return /([A-Za-z_$][\w$]*)\s*$/.exec(text.slice(0, i))?.[1] ?? null;
      depth--;
    }
  }
  return null;
}

/** Keychain calls in one file's text that are not inside keychain(...), as "line: code". Comments are skipped. */
export function unboundedKeychainCalls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/SecureStore\.(?:get|set|delete)ItemAsync\(/g)) {
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const line = text.slice(lineStart, text.indexOf('\n', m.index) >>> 0 || undefined);
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    if (enclosingCall(text, m.index) !== 'keychain') out.push(`${text.slice(0, m.index).split('\n').length}: ${line.trim()}`);
  }
  return out;
}

test('every keychain call in the phone app has a bound', () => {
  const offenders = sources(root).flatMap((file) =>
    unboundedKeychainCalls(readFileSync(file, 'utf8')).map((hit) => `${path.relative(root, file)}:${hit}`),
  );
  assert.deepEqual(offenders, [], 'wrap it in keychain(...) from mobile/src/bounded.ts');
});

test('the rule sees a bare call, a call inside another call and a ternary, and accepts keychain(...) around any of them', () => {
  assert.equal(unboundedKeychainCalls('const a = await SecureStore.getItemAsync(KEY);').length, 1);
  assert.equal(unboundedKeychainCalls('read: () => wrap(SecureStore.getItemAsync(KEY)),').length, 1);
  assert.equal(unboundedKeychainCalls('keychain(SecureStore.getItemAsync(KEY))').length, 0);
  assert.equal(unboundedKeychainCalls('keychain(\n  SecureStore.setItemAsync(KEY, v, { a: f(1) }),\n)').length, 0);
  assert.equal(unboundedKeychainCalls('keychain(v === null ? SecureStore.deleteItemAsync(n) : SecureStore.setItemAsync(n, v))').length, 0);
  assert.equal(unboundedKeychainCalls('// SecureStore.getItemAsync(KEY) in a comment').length, 0);
  assert.equal(unboundedKeychainCalls('const x = SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY;').length, 0);
});
