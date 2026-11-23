// An E2E spec that sends a follow-up behind a SLOW turn waits for that turn to have started, not for Stop alone (#3139).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { treeFiles } from '../scripts/source-tree.mjs';

export const GUARDS = ['tests/e2e/'];

/** A message that keeps its fake turn running. */
const SLOW_SEND = /\bsend\w*\(page, (['"`])[^'"`]*SLOW[^'"`]*\1/;
/** Stop shown: the only check between the SLOW send and the next one. */
const STOP_ONLY = /^await expect\((?:stop\(page\)|page\.getByRole\('button', \{ name: 'Stop'[^)]*\))\)\.toBeVisible\((?:\{[^}]*\})?\);$/;
const NEXT_SEND = /\b(?:send\w*|fill)\(|\.fill\(|keyboard\.(?:type|press)\(/;

/**
 * The lines of `source` where a SLOW send is followed by a Stop check alone and then another send. Stop also shows while
 * main still holds the previous turn's end (it snapshots the turn's changes first), so the follow-up can queue behind
 * the SLOW message and steer into the turn that already ended; wait for the SLOW turn's own reply first.
 */
export function stopOnlyFollowUps(source: string): number[] {
  const lines = source.split('\n').map((l) => l.trim());
  const hits: number[] = [];
  lines.forEach((line, i) => {
    if (!SLOW_SEND.test(line)) return;
    const [check, next] = lines.slice(i + 1).filter(Boolean);
    if (check && next && STOP_ONLY.test(check) && NEXT_SEND.test(next)) hits.push(i + 1);
  });
  return hits;
}

test('the check finds a follow-up sent on Stop alone and passes one sent once the SLOW turn replied', () => {
  const stopOnly = ["await send(page, 'take it SLOW');", 'await expect(stop(page)).toBeVisible();', "await send(page, 'also');"];
  assert.deepEqual(stopOnlyFollowUps(stopOnly.join('\n')), [1]);
  const named = [
    "await send(page, 'x SLOW');",
    "await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();",
    '',
    "await fill(page, '/x');",
  ];
  assert.deepEqual(stopOnlyFollowUps(named.join('\n')), [1]);
  // other quotes, a timeout on the Stop check, and a follow-up typed into the composer
  const typed = [
    'await send(page, `go SLOW`);',
    'await expect(stop(page)).toBeVisible({ timeout: 20_000 });',
    "await composer(page).fill('more');",
  ];
  assert.deepEqual(stopOnlyFollowUps(typed.join('\n')), [1]);
  const replied = ["await send(page, 'take it SLOW');", "await slowTurnRunning(page, 'fake-codex');", "await send(page, 'also');"];
  assert.deepEqual(stopOnlyFollowUps(replied.join('\n')), []);
  // Stop pressed, not a follow-up: the turn the user stops is whichever runs
  const stopped = ["await send(page, 'take it SLOW');", 'await expect(stop(page)).toBeVisible();', 'await stop(page).click();'];
  assert.deepEqual(stopOnlyFollowUps(stopped.join('\n')), []);
  assert.deepEqual(stopOnlyFollowUps("await send(page, 'take it SLOW');"), []);
});

test('no E2E spec sends a follow-up behind a SLOW turn on Stop alone', () => {
  const hits = treeFiles('tests/e2e', /\.spec\.ts$/).flatMap((f: string) =>
    stopOnlyFollowUps(fs.readFileSync(f, 'utf8')).map((line) => `${f}:${line}`),
  );
  assert.deepEqual(hits, []);
});
