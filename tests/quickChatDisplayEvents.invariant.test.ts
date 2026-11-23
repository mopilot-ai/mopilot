// The events that draw a message in the window it came from are the ones Quick Chat gets for its own sends (#2316):
// every turnStarting / steered a harness adapter emits must be in electron/app/windows.cjs DISPLAY_EVENTS, and nothing
// else is, so a new "show the message" event cannot skip Quick Chat and an execution event cannot reach it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const windows = fs.readFileSync(path.join(root, 'electron/app/windows.cjs'), 'utf8');
const declared = [...(/DISPLAY_EVENTS = new Set\(\[([^\]]*)\]\)/.exec(windows)?.[1] ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();

test('the display events named in windows.cjs are exactly the message-showing events the adapters emit', () => {
  const dir = path.join(root, 'electron/harness');
  const emitted = new Set<string>();
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.cjs')))
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/kind: '(turnStarting|steered)'/g)) emitted.add(m[1]);
  assert.deepEqual([...emitted].sort(), ['steered', 'turnStarting'], 'the adapters still emit the two message-showing events');
  assert.deepEqual(declared, [...emitted].sort());
});
