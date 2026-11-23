// Invariant: a harness's quirks start its binary only through spawnArgs (electron/platform/winbin.cjs). On Windows a bin is often npm's .cmd shim, which Node starts only through cmd.exe (EINVAL otherwise), so dsh's privacy gate, which ran `execFile(bin, …)` itself, refused dsh on every Windows machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const QUIRKS = path.resolve(import.meta.dirname, '../electron/harness/quirks');
/** A process started from a quirks module: child_process's spawn and execFile families, by any receiver. */
const START = /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(/g;

/** Each start in `text` whose arguments do not begin with `...spawnArgs(`, as `line: code`. */
export function rawStarts(text: string) {
  const out: string[] = [];
  for (const m of text.matchAll(START)) {
    const rest = text.slice((m.index ?? 0) + m[0].length).trimStart();
    if (!rest.startsWith('...spawnArgs(')) out.push(`${text.slice(0, m.index).split('\n').length}: ${m[0]}`);
  }
  return out;
}

test('the check finds a bin started directly and lets one started through spawnArgs pass', () => {
  assert.deepEqual(rawStarts('proc.execFile(\n  bin, [], cb)'), ['1: execFile(']);
  assert.deepEqual(rawStarts('x;\nchild.spawn(bin)'), ['2: spawn(']);
  assert.deepEqual(rawStarts('proc.execFile(\n  ...spawnArgs(bin, ["--v"], {}), cb)'), []);
});

test('every quirks module starts a harness binary through spawnArgs', () => {
  const found = fs
    .readdirSync(QUIRKS)
    .filter((f) => f.endsWith('.cjs'))
    .flatMap((f) => rawStarts(fs.readFileSync(path.join(QUIRKS, f), 'utf8')).map((s) => `${f}:${s}`));
  assert.deepEqual(found, [], 'start it with ...spawnArgs(bin, args, options) so a Windows .cmd shim runs');
});
