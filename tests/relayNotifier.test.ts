// relay/src/notifier.mjs: the push merge rule is the desktop Notifier's (electron/platform/notify.cjs): one per chat, "needs you" outranks "done", same kind within 60 s merges to "(n)", and the texts are fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { COLLAPSE_MS, HOLD_MS, MERGE_MS, Notifier, REPEAT_MS, TITLES } from '../relay/src/notifier.mjs';

const require = createRequire(import.meta.url);
const { MERGE_MS: DESKTOP_MERGE_MS, HOLD_MS: DESKTOP_HOLD_MS } = require('../electron/platform/notify.cjs');
const { MOMO_NOTICE_TITLES, momoMergedTitle } = await import('../shared/momoNotices.mjs');

test("the windows are the desktop notifier's and MoMo's text is shared/momoNotices.mjs's", () => {
  assert.equal(MERGE_MS, DESKTOP_MERGE_MS);
  assert.equal(HOLD_MS, DESKTOP_HOLD_MS);
  assert.equal(TITLES.momoNeedsYou, MOMO_NOTICE_TITLES.needsYou);
  const n = new Notifier();
  n.push('momoNeedsYou', 'a', 0);
  assert.equal(n.push('momoNeedsYou', 'b', 1)!.title, momoMergedTitle(2));
});

test("a single notification carries the kind's fixed title and no chat text", () => {
  const n = new Notifier();
  for (const kind of Object.keys(TITLES)) {
    const out = n.push(kind, `ref-${kind}`, 0)!;
    assert.equal(out.title, TITLES[kind as keyof typeof TITLES]);
    assert.equal(out.merged, false);
    assert.equal(out.count, 1);
  }
});

test('the same kind for other chats within 60 s merges to "(n)", and a chat is counted once', () => {
  const n = new Notifier();
  assert.equal(n.push('needsYou', 'a', 0)!.title, TITLES.needsYou);
  assert.equal(n.push('needsYou', 'a', 1000), null, 'the same chat is not pushed twice inside the window');
  const two = n.push('needsYou', 'b', 2000)!;
  assert.equal(two.title, `${TITLES.needsYou} (2)`);
  assert.equal(two.merged, true);
  assert.equal(n.push('needsYou', 'c', 3000)!.title, `${TITLES.needsYou} (3)`);
  // a minute after the last one, it starts over
  assert.equal(n.push('needsYou', 'd', 3000 + MERGE_MS)!.count, 1);
});

test('different kinds never merge', () => {
  const n = new Notifier();
  n.push('needsYou', 'a', 0);
  assert.equal(n.push('done', 'b', 1)!.title, TITLES.done);
});

test('"needs you" keeps a later "done" for the same chat out for ten minutes, then it may through', () => {
  const n = new Notifier();
  n.push('needsYou', 'a', 0);
  assert.equal(n.push('done', 'a', 1000), null);
  assert.equal(n.push('done', 'a', HOLD_MS - 1), null);
  assert.ok(n.push('done', 'a', HOLD_MS));
  // "done" never holds out a "needs you"
  n.push('done', 'b', HOLD_MS);
  assert.ok(n.push('needsYou', 'b', HOLD_MS + 1));
});

test('prune forgets what can no longer matter', () => {
  const n = new Notifier();
  n.push('needsYou', 'a', 0);
  n.push('done', 'b', HOLD_MS);
  n.prune(HOLD_MS + 1);
  assert.deepEqual([...n.byRef.keys()], ['b']);
  assert.deepEqual([...n.groups.keys()], ['done']);
  n.prune(HOLD_MS * 3);
  assert.equal(n.byRef.size + n.groups.size, 0);
});

test('the same kind for the same chat goes out once per window, however often the Mac asks; other chats and kinds are not held back', () => {
  const n = new Notifier();
  assert.ok(n.push('needsYou', 'a', 0));
  // approval after approval in one chat: nothing more until the window has passed
  for (let t = 1000; t < REPEAT_MS; t += 7000) assert.equal(n.push('needsYou', 'a', t), null, `at ${t}`);
  // another chat has its own need, and the same chat's other kind is a different notice
  assert.ok(n.push('needsYou', 'b', 5000));
  assert.ok(n.push('done', 'a', 6000) === null, 'a held needs-you still outranks a done for it');
  assert.ok(n.push('done', 'c', 6000));
  // after the window the chat may be told again
  assert.ok(n.push('needsYou', 'a', REPEAT_MS));
  assert.equal(n.push('needsYou', 'a', REPEAT_MS + 1), null, 'and the window starts again');
});

test('a push that did not go out does not start the window, and a removed pair forgets its chats', () => {
  const n = new Notifier();
  n.push('needsYou', 'p1:a', 0)!.undo();
  assert.ok(n.push('needsYou', 'p1:a', 1000), 'the first never went out, so this one may');
  assert.equal(n.push('needsYou', 'p1:a', 2000), null);
  n.forgetPair('p1');
  assert.ok(n.push('needsYou', 'p1:a', 3000), 'a pair added again starts clean');
  assert.equal(n.push('needsYou', 'p2:a', 3000)!.count, 2, 'a handle in another pair is another chat');
  n.prune(3000 + REPEAT_MS + HOLD_MS);
  assert.equal(n.sent.size, 0);
});

test('a Host’s push is neither held under a "needs you" nor held back by the repeat window; a Mac’s still is', () => {
  const n = new Notifier();
  assert.ok(n.push('needsYou', 'r', 0, true));
  assert.ok(n.push('done', 'r', 1000, true), 'the clearing replaces the waiting push');
  assert.ok(n.push('needsYou', 'r', 2000, true), 'the next card of the chat');
  const mac = new Notifier();
  assert.ok(mac.push('needsYou', 'r', 0));
  assert.equal(mac.push('done', 'r', 1000), null);
  assert.equal(mac.push('needsYou', 'r', 2000), null);
});

test('a clearing is never held back by the card it replaces, never merged into "(n)", and frees the chat for a later done', () => {
  const n = new Notifier();
  assert.equal(n.push('needsYou', 'a', 0)!.title, TITLES.needsYou);
  assert.equal(n.push('done', 'a', 1000), null, 'a done within the hold is outranked');
  const cleared = n.push('cleared', 'a', 2000)!;
  assert.deepEqual([cleared.title, cleared.count, cleared.merged], [TITLES.cleared, 1, false]);
  // two chats cleared within the merge window stay two notifications with the same words
  const other = n.push('cleared', 'b', 2500)!;
  assert.deepEqual([other.title, other.merged], [TITLES.cleared, false]);
  // a repeat of the same clearing is not held for the repeat window, and undo has nothing to take back
  assert.equal(n.push('cleared', 'a', 2600)!.title, TITLES.cleared);
  cleared.undo();
  // the clearing ended the hold: a done for that chat goes out now
  assert.equal(n.push('done', 'a', 3000)!.title, TITLES.done);
});

test('a cleared chat leaves the "(n)" count, and the collapse id a chat shared is remembered for its clearing, then forgotten', () => {
  const n = new Notifier();
  n.push('needsYou', 'a', 0);
  n.push('cleared', 'a', 1000);
  assert.equal(n.push('needsYou', 'b', 2000)!.title, TITLES.needsYou, 'only one chat needs the person');
  // a clearing with nothing grouped is harmless, and a chat that was never grouped has no shared id
  assert.equal(new Notifier().push('cleared', 'x', 0)!.title, TITLES.cleared);
  assert.equal(n.takeCollapse('b'), undefined);
  n.remember('b', 'merged:needsYou', 2000);
  assert.equal(n.takeCollapse('b'), 'merged:needsYou');
  assert.equal(n.takeCollapse('b'), undefined, 'taken once');
  // removing a pair forgets its chats' ids; an id nobody cleared is dropped after a day
  n.remember('p_x:1', 'merged:needsYou', 0);
  n.remember('p_y:1', 'merged:needsYou', 0);
  n.forgetPair('p_x');
  assert.equal(n.takeCollapse('p_x:1'), undefined);
  n.prune(COLLAPSE_MS - 1);
  assert.equal(n.collapse.size, 1);
  n.prune(COLLAPSE_MS);
  assert.equal(n.collapse.size, 0);
});
