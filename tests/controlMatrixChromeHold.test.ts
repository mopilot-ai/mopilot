// CM-Y05a and CM-Y05c (#1403, #1830): an idle Claude Code CLI whose Claude in Chrome group holds the chat's pages is never
// ended sooner than any other, nor by an eviction; a site MoPilot handed to the user's Chrome only for a sign-in holds nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { claude, ipc, until, tick, claudeChrome, groupHolds } from './support/claude-chrome-kit.ts';

export const GUARDS = ['electron/', 'shared/'];

const require = createRequire(import.meta.url);
const { IDLE_MS, CHROME_IDLE_MS, MIN_VICTIM_IDLE_MS } = require('../electron/harness/claude/governor.cjs');
const MIN = 60_000;

/* ====================================================================== */
/* Claude in Chrome: an idle CLI with the chat's pages is not reaped early */
/* ====================================================================== */

test("CM-Y05a: an idle CLI whose Claude in Chrome group holds the chat's pages is kept at least as long as any (never under 30 minutes); then it ends gracefully", async () => {
  const { key, q } = await claudeChrome('y05', 'chat-y05');
  groupHolds(q, 't1', ['https://shop.test/cart', 'chrome://newtab/']);
  await tick(30);
  const now = Date.now();
  const hold = Math.max(IDLE_MS, CHROME_IDLE_MS);
  claude.reap(now + 31 * MIN);
  await tick(30);
  assert.equal(claude.turnApi.isLive(key), true, 'its tab group and session permissions stay past the half hour (#1403)');
  claude.reap(now + hold - MIN);
  await tick(30);
  assert.equal(claude.turnApi.isLive(key), true, 'not before an idle CLI without pages would end');
  // no eviction ends it: closing it would close the pages the user may be looking at
  assert.equal(
    claude.governor.victims(0, now + hold - MIN).some((s: any) => s.key === key),
    false,
  );
  claude.reap(now + hold + MIN);
  await until('the reaper to end it', () => q.log.includes('close'));
  assert.deepEqual(q.log, ['eof', 'exit hooks', 'close'], 'ended gracefully: the exit hooks ran first');

  // a group of blank tabs is reaped at the usual time
  const blank = await claudeChrome('y05-blank', 'chat-y05-blank');
  groupHolds(blank.q, 't1', ['chrome://newtab/']);
  blank.q.push({ type: 'result', subtype: 'success' });
  await until('the blank group retire', () => blank.q.log.includes('close'));
  assert.deepEqual(blank.q.log, ['eof', 'exit hooks', 'close']);
});

test("CM-Y05c: a page MoPilot handed to the user's Chrome only for a sign-in does not hold the CLI; a page of the chat's own does", async () => {
  const { noteHandoff, forgetHandoffs } = require('../electron/capabilities/browser/handoffPages.cjs');
  // the passkey hand-off opened the site in the user's Chrome, and the agent picked it up in its group
  noteHandoff('chat-y05c', 'https://shop.test/login?next=%2Faccount');
  const { key, q } = await claudeChrome('y05c', 'chat-y05c');
  groupHolds(q, 't1', ['https://shop.test/account', 'chrome://newtab/']);
  // each turn ends with its result (a CLI still answering one it woke itself for is never evicted)
  q.push({ type: 'result', subtype: 'success' });
  // the same chat's group also holding a page of its own holds it
  const own = await claudeChrome('y05c-own', 'chat-y05c');
  groupHolds(own.q, 't1', ['https://shop.test/account', 'https://docs.test/guide']);
  // another chat's hand-off of the same site does not count for this one
  const other = await claudeChrome('y05c-other', 'chat-y05c-other');
  groupHolds(other.q, 't1', ['https://shop.test/account']);
  await tick(30);
  const later = Date.now() + MIN_VICTIM_IDLE_MS + MIN;
  const evictable = claude.governor.victims(MIN_VICTIM_IDLE_MS, later).map((s: any) => s.key);
  assert.equal(evictable.includes(key), true, "the signed-in site is the user's, not a page the chat keeps working in");
  assert.equal(evictable.includes(own.key), false);
  assert.equal(evictable.includes(other.key), false);
  claude.reap(Date.now() + IDLE_MS + MIN);
  await until('the CLI to end at the usual idle time', () => q.log.includes('close'));
  assert.equal(claude.turnApi.isLive(key), false);
  forgetHandoffs('chat-y05c');
  await ipc('claude:control', own.key, 'close');
  await ipc('claude:control', other.key, 'close');
});
