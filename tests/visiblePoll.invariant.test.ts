// The renderer polls through lib/visiblePoll (one keyed timer, parked while hidden), never a setInterval of its own (#2506).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const src = new URL('../src', import.meta.url).pathname;

/** Existing timers outside components, each with why it may stay. A new entry needs a reason a hidden window still needs it. */
const ALLOWED: Record<string, string> = {
  'src/lib/visiblePoll.ts': 'the shared scheduler itself',
  'src/session/perf.ts': 'the profiler samples while a capture is on; off otherwise',
  'src/lib/tasks.ts': 'the tasks clock ticks only while a task shows its elapsed time, and its subscribers are the visible rows',
  'src/store/prewarm.ts': 'heartbeat that keeps a warm session alive; it must run while the window is hidden',
  // #2565 moved the Claude presence scan here; it parks while hidden itself and takes an injected document for its tests
  'src/harness/claude/presencePolling.ts': 'presence scan with its own hidden/focus gating (4 s in front, 20 s behind)',
  'src/session/harness/claude/accounts.ts': 'background usage refresh that feeds notifications while the window is hidden',
};

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );

/** The code with block comments and line comments removed, so a mention in prose never counts. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('only the reasoned allow-list starts its own setInterval', () => {
  const found = files(src)
    .filter((file) => /\bsetInterval\b/.test(code(readFileSync(file, 'utf8'))))
    .map((file) => `src/${relative(src, file)}`)
    .filter((file) => !(file in ALLOWED));
  assert.deepEqual(found, [], 'use visiblePoll(key, ms, run) from src/lib/visiblePoll.ts');
});

test('the allow-list names only files that still start a timer', () => {
  for (const file of Object.keys(ALLOWED)) {
    const text = readFileSync(join(src, '..', file), 'utf8');
    assert.ok(/\bsetInterval\b/.test(code(text)), `${file} no longer needs its entry`);
  }
});

test('components never start a timer of their own', () => {
  assert.deepEqual(
    Object.keys(ALLOWED).filter((file) => file.startsWith('src/components/')),
    [],
  );
});
