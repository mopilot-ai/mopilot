// A chat reopened on the rows it last showed draws the footer the Mac's answer will have (#5686 row 7): the "Worked" line under a finished turn with steps, and the Changes chip it was left with, so the answer adds nothing under the reader and moves nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { fakeDraft } from './support/phone/drafts';

const threadPath = '../mobile/src/screens/Thread';
const cachePath = '../mobile/src/presentation/threadCache';
const { Thread } = await import(threadPath);
const { forgetRows, recentChanges } = await import(cachePath);
const kitPath = './support/phone/chat-cache-kit.ts';
const { fakeCache } = await import(kitPath);

const KEY = JSON.stringify(['u', 'p', 'c']);
const history = [
  { role: 'user', text: 'Clean up the build output' },
  { role: 'step', text: 'Read /repo/a.ts' },
  { role: 'step', text: 'Read /repo/b.ts' },
  { role: 'step', text: 'Ran npm test' },
  { role: 'assistant', text: 'All clean.' },
];
const idle = { rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: history };
const diff = { files: [{ path: 'a.ts', added: 12, removed: 3 }], total: 1, omitted: 0, truncated: false };

const button = (host: HTMLElement, label: RegExp) =>
  [...host.querySelectorAll('[role="button"]')].find((b) => label.test(b.getAttribute('aria-label') ?? '')) as HTMLElement | undefined;

/**
 * Opens the chat; `answers` false keeps the Mac's read on the wire until `answer()`, which answers `snap`; `countFails` makes the Mac's
 * counts fail; `followFails` makes its read fail with that error. `away`: the Mac is asleep (the app then gives no Changes screen), until
 * `wake()`; `drop()` and `wake()` take the connection away and back as a reconnect does.
 */
async function open({
  answers,
  rowCache,
  snap = idle,
  countFails = false,
  followFails,
  away = false,
}: {
  answers: boolean;
  rowCache?: unknown;
  snap?: object;
  countFails?: boolean;
  followFails?: Error;
  away?: boolean;
}) {
  let release: () => void = () => {};
  const listeners = new Set<(e: object) => void>();
  // the counts the Mac answers with; `held` keeps the next count on the wire until `count()`
  const counts = { held: false, count: () => {} };
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: (l: (e: object) => void) => (listeners.add(l), () => listeners.delete(l)),
    request: (method: string) => {
      if (method === 'chat.follow' && followFails) return Promise.reject(followFails);
      if (method === 'chat.follow') return answers ? Promise.resolve(snap) : new Promise((resolve) => (release = () => resolve(snap)));
      if (method === 'diff.list' && countFails) return Promise.reject(new Error('Your computer is offline or asleep.'));
      if (method === 'diff.list')
        return counts.held ? new Promise((resolve) => (counts.count = () => resolve(diff))) : Promise.resolve(diff);
      return Promise.resolve({});
    },
  };
  withOutbox(runtime);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const drafts = fakeDraft('');
  // as the app draws it: Changes is offered only while the computer is there
  const draw = (asleep: boolean, online: boolean) =>
    act(async () =>
      root.render(
        createElement(Thread, {
          runtime,
          chatId: 'c',
          back: () => {},
          ...(online ? { review: () => {} } : {}),
          drafts,
          historyKey: KEY,
          rowCache,
          offline: asleep,
        }),
      ),
    );
  await draw(away, !away);
  await flush();
  return {
    host,
    wake: async () => {
      await draw(false, true);
      await flush();
    },
    drop: async () => {
      await draw(false, false);
      await flush();
    },
    counts,
    emit: (e: object) =>
      act(async () => {
        for (const l of listeners) l({ kind: 'event', chatId: 'c', ...e });
        await new Promise((resolve) => setTimeout(resolve, 40));
      }),
    answer: async () => {
      await act(async () => release());
      await flush();
    },
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('a chat reopened before the Mac answers draws the "Worked" line and the Changes chip it was left with, and the answer keeps those very views', async () => {
  forgetRows();
  const first = await open({ answers: true });
  assert.ok(button(first.host, /^Worked, hide the steps$/), 'the live chat has the line');
  assert.ok(button(first.host, /^Changes/), 'and the chip');
  await first.done();
  assert.deepEqual(recentChanges(KEY), { files: 1, added: 12, removed: 3 }, 'the chip is kept with the rows');

  const again = await open({ answers: false });
  const line = button(again.host, /^Worked, hide the steps$/);
  const chip = button(again.host, /^Changes/);
  assert.ok(line, 'the saved rows have the line before the Mac answers');
  assert.ok(chip, 'and the chip');
  assert.match(again.host.textContent!, /All clean\./);
  await again.answer();
  assert.equal(button(again.host, /^Worked, hide the steps$/), line, 'the line is the same view: nothing was added under the reader');
  assert.equal(button(again.host, /^Changes/), chip, 'and so is the chip');
  await again.done();
});

test('the saved turn folds as the live one does, and the fold holds when the Mac answers', async () => {
  forgetRows();
  const first = await open({ answers: true });
  // folded when it was left: it is kept unfolded, as it opens again
  await act(async () => button(first.host, /^Worked, hide the steps$/)!.click());
  await flush();
  await first.done();
  const again = await open({ answers: false });
  assert.ok(button(again.host, /^Read 2 files, ran 1 command$/), 'the saved steps are there');
  await act(async () => button(again.host, /^Worked, hide the steps$/)!.click());
  assert.equal(button(again.host, /^Read 2 files/), undefined, 'folded before the Mac answers');
  assert.match(again.host.textContent!, /All clean\./);
  await again.answer();
  assert.equal(button(again.host, /^Read 2 files/), undefined, 'and still folded after');
  assert.ok(button(again.host, /^Worked, show the steps$/));
  await act(async () => button(again.host, /^Worked, show the steps$/)!.click());
  assert.ok(button(again.host, /^Read 2 files/));
  await again.done();
});

test('the sealed copy keeps the chip with the rows: a chat opened from disk draws it before the Mac answers', async () => {
  forgetRows();
  const { cache: rowCache } = fakeCache();
  const first = await open({ answers: true, rowCache });
  await first.done();
  assert.deepEqual((await rowCache.loadChat(KEY)).changes, { files: 1, added: 12, removed: 3 });
  forgetRows(); // the app was closed: only the sealed copy is left
  const again = await open({ answers: false, rowCache });
  assert.ok(button(again.host, /^Changes/), 'the chip is drawn from disk');
  assert.ok(button(again.host, /^Worked, hide the steps$/));
  await again.answer();
  await again.done();
});

test('once the Mac has counted, a turn that runs and ends shows no chip until the Mac counts again (the one kept is not shown for it)', async () => {
  forgetRows();
  const t = await open({ answers: true });
  assert.ok(button(t.host, /^Changes/));
  t.counts.held = true;
  await t.emit({ ev: 'session.patch', rev: 2, patch: { turn: 'running' } });
  assert.equal(button(t.host, /^Changes/), undefined, 'no chip while the turn runs');
  await t.emit({ ev: 'session.patch', rev: 3, patch: { turn: 'idle' } });
  assert.equal(button(t.host, /^Changes/), undefined, 'none until the turn’s end is counted');
  assert.deepEqual(recentChanges(KEY), { files: 1, added: 12, removed: 3 }, 'the last count stays kept for the next open');
  await act(async () => t.counts.count());
  await flush();
  assert.ok(button(t.host, /^Changes/));
  await t.done();
});

test('the sealed copy holds the rows with their chip; rows kept without one stay the plain list earlier builds read; a chip that is not counts reads as none', async () => {
  const { cache, disk } = fakeCache();
  const rows = [{ key: 'k1', role: 'assistant', text: 'hi' }];
  const plain = (key: string) =>
    Buffer.from(JSON.parse(disk.get(key)!).box, 'hex')
      .toString()
      .split('\u0000')[1];
  await cache.save('a', rows, { files: 2, added: 5, removed: 1 });
  assert.deepEqual(await cache.loadChat('a'), { rows, changes: { files: 2, added: 5, removed: 1 } });
  assert.deepEqual(await cache.load('a'), rows, 'the rows alone, as before');
  await cache.save('b', rows);
  assert.deepEqual(JSON.parse(plain('b')), rows, 'no chip: the plain list');
  assert.deepEqual(await cache.loadChat('b'), { rows, changes: null });
  await cache.save('c', rows, { files: 1, added: 2 } as never);
  assert.deepEqual(await cache.loadChat('c'), { rows, changes: null }, 'counts with one missing are none');
  assert.deepEqual(await cache.loadChat('none'), { rows: [], changes: null });
});

test('the saved rows offer no Copy or Retry and the chip they were left with does nothing: they may be old (a newer turn on the Mac); the Mac’s rows offer them', async () => {
  forgetRows();
  const first = await open({ answers: true });
  await first.done();
  const again = await open({ answers: false });
  assert.ok(button(again.host, /^Worked, hide the steps$/), 'the line is there');
  assert.equal(button(again.host, /^Retry$/), undefined, 'no Retry: it would send the saved message again');
  assert.equal(button(again.host, /^Copy reply$/), undefined, 'no Copy of a reply that may be old');
  const chip = button(again.host, /^Changes/)!;
  assert.equal(chip.getAttribute('aria-disabled'), 'true', 'the chip does nothing yet');
  assert.equal((chip as HTMLButtonElement).disabled, true);
  await again.answer();
  assert.ok(button(again.host, /^Retry$/), 'the Mac’s rows offer Retry');
  assert.ok(button(again.host, /^Copy reply$/));
  assert.equal(button(again.host, /^Changes/), chip, 'the same chip');
  assert.equal(chip.getAttribute('aria-disabled'), 'false', 'which now opens the changes');
  await again.done();
});

test('a chat left mid-turn opens with no Retry, and when the Mac answers that the turn still runs there is none either', async () => {
  forgetRows();
  const first = await open({ answers: true });
  await first.done();
  const running = { ...idle, session: { turn: 'running', cards: [] } };
  const again = await open({ answers: false, snap: running });
  assert.equal(button(again.host, /^Retry$/), undefined);
  await again.answer();
  assert.equal(button(again.host, /^Retry$/), undefined, 'the turn runs: nothing to retry');
  assert.equal(button(again.host, /^Worked/), undefined, 'and no "Worked" line claims it is done');
  await again.done();
});

test('a count that fails says nothing new: the chip the chat was left with stays, the same view, and stays kept (a Mac that drops away does not take it from under the reader)', async () => {
  forgetRows();
  const first = await open({ answers: true });
  await first.done();
  const again = await open({ answers: false, countFails: true });
  const chip = button(again.host, /^Changes/);
  assert.ok(chip, 'the chip it was left with, before the Mac answers');
  await again.answer();
  assert.equal(button(again.host, /^Changes/), chip, 'the same chip after a count that failed');
  assert.deepEqual(recentChanges(KEY), { files: 1, added: 12, removed: 3 }, 'and still kept');
  await again.done();
});

test('a chat opened while the Mac is asleep draws the chip it was left with (the app offers no Changes screen then), and the Mac waking keeps that view (row 7, Mac asleep)', async () => {
  forgetRows();
  const first = await open({ answers: true });
  await first.done();
  const asleep = await open({ answers: false, away: true });
  const chip = button(asleep.host, /^Changes/);
  assert.ok(chip, 'the chip is drawn while the Mac sleeps');
  assert.equal(chip!.getAttribute('aria-disabled'), 'true', 'and does nothing');
  await asleep.wake();
  await asleep.answer();
  assert.equal(button(asleep.host, /^Changes/), chip, 'the same view once the Mac answers');
  assert.equal(chip!.getAttribute('aria-disabled'), 'false');
  await asleep.done();
});

test('a reconnect that takes the Changes screen away for a moment does not take the chip with it (row 7, relay hung)', async () => {
  forgetRows();
  const t = await open({ answers: true });
  const chip = button(t.host, /^Changes/);
  assert.ok(chip);
  await t.drop();
  assert.equal(button(t.host, /^Changes/), chip, 'still there, the same view');
  assert.equal(chip!.getAttribute('aria-disabled'), 'true', 'it opens nothing while the computer is not there');
  await t.wake();
  assert.equal(button(t.host, /^Changes/), chip);
  assert.equal(chip!.getAttribute('aria-disabled'), 'false');
  await t.done();
});

test('a read the socket refused shows what it means, never the code (INVALID_STATE_ERR)', async () => {
  forgetRows();
  const t = await open({ answers: false, followFails: new Error('INVALID_STATE_ERR') });
  assert.match(t.host.textContent!, /Couldn’t reach your computer\. Try again\.|Couldn't reach your computer\. Try again\./);
  assert.doesNotMatch(t.host.textContent!, /INVALID_STATE_ERR/);
  await t.done();
});

test('the runtime’s transport words and bare codes are worded; anything else is shown as it is', async () => {
  const clientPath = '../mobile/src/remote/client';
  const { explain, UNREACHED } = await import(clientPath);
  for (const text of ['Request timed out', 'relay acknowledgement timed out', 'Connection closed', 'INVALID_STATE_ERR', 'ERR_NETWORK_LOST'])
    assert.equal(explain(new Error(text)), UNREACHED, text);
  assert.match(explain(new Error('Relay disconnected')), /offline or asleep/);
  assert.equal(explain('Refused'), 'Refused');
  assert.equal(explain(new Error('No such chat')), 'No such chat');
});
