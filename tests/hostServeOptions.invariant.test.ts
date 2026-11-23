// The serve entry (host/src/cli.mjs) hands `createProtocol` every option the protocol declares, or names why one stays out: an option left out silently turns a feature off in the real Host while its unit tests pass (approvalTimes, then the push notifier, #4576).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** The `o.name` parameters of createProtocol's JSDoc. */
function declared(): string[] {
  const src = read('host/src/protocol.mjs');
  const doc = src.slice(
    src.lastIndexOf('/**', src.indexOf('export function createProtocol(')),
    src.indexOf('export function createProtocol('),
  );
  return [...doc.matchAll(/@param \{[^\n]*?\} \[?o\.(\w+)\]?/g)].map((m) => m[1]);
}

/** The keys of the object createProtocol is called with in the serve entry: `key:`, shorthand and spreads (a spread names the option object it adds). */
function passed(): { keys: Set<string>; spreads: string[] } {
  const src = read('host/src/cli.mjs');
  const start = src.indexOf('createProtocol({') + 'createProtocol('.length;
  let depth = 0;
  let end = start;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{' || src[i] === '(' || src[i] === '[') depth++;
    if (src[i] === '}' || src[i] === ')' || src[i] === ']') depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }
  const body = src.slice(start + 1, end);
  // only the top level of the object: nested braces and parentheses are skipped
  let level = 0;
  let top = '';
  for (const ch of body) {
    if ('{(['.includes(ch)) level++;
    if (level === 0) top += ch;
    if ('})]'.includes(ch)) level--;
  }
  const keys = new Set<string>();
  const spreads: string[] = [];
  for (const part of top.split(',')) {
    const t = part.trim();
    if (t.startsWith('...')) spreads.push(t.slice(3));
    else if (t) keys.add(/^(\w+)/.exec(t)?.[1] ?? t);
  }
  return { keys, spreads };
}

/** Options the serve entry leaves out, each with why; a new entry here is a decision, not a convenience. */
const LEFT_OUT: Record<string, string> = {
  approvalClock: 'the time and timers of the approval engine, which only tests drive; the real ones are the default',
};
/** What each spread in the entry adds. */
const SPREADS: Record<string, string[]> = { 'approvalPush.options': ['notify', 'approvalTimes'] };

test('the serve entry passes every option createProtocol declares, or names why not', () => {
  const names = declared();
  assert.ok(names.length > 20, 'the declared options were read');
  const { keys, spreads } = passed();
  for (const s of spreads) assert.ok(SPREADS[s], `the spread ${s} in the serve entry says which options it adds`);
  const given = new Set([...keys, ...spreads.flatMap((s) => SPREADS[s] ?? [])]);
  const missing = names.filter((n) => !given.has(n) && !(n in LEFT_OUT));
  assert.deepEqual(missing, [], `the serve entry (host/src/cli.mjs) does not pass: ${missing.join(', ')}`);
  for (const n of Object.keys(LEFT_OUT)) assert.ok(names.includes(n) && !given.has(n), `${n} is left out and declared, or its entry goes`);
  for (const k of given) assert.ok(names.includes(k), `${k} is passed but the protocol does not declare it`);
});
