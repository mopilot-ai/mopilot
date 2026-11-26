// The saved older rows with the Mac asleep and awake (#5379): asleep, the first paint is shown with the saved rows above it where they meet it (read-only, no request); awake, the snapshot reconciles without moving what is shown; a copy that does not meet the first paint is dropped. Awake on reopen, scrolling up through saved pages shows no loading row and the fill asks only beyond them.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';
import { Thread, at, id, KEY, memory, mount, mounted, rig, rows, shown, wait } from './support/phone/pages-kit';
// the paths are variables, so the root typecheck does not take the whole phone app in with this file
const earlierPath = '../mobile/src/remote/useEarlier';
const chatRowsPath = '../mobile/src/remote/useChatRows';
const { backfill, SETTLE_MS } = await import(earlierPath);
const { olderThan, ASLEEP_OLDER } = await import(chatRowsPath);
const threadCachePath = '../mobile/src/presentation/threadCache';
const { forgetRows } = await import(threadCachePath);

// a chat left open would keep its timers (the delayed save, the fill) running past the test
afterEach(async () => {
  for (const root of mounted.splice(0)) await act(async () => root.unmount());
});

/** The first paint a chat leaves behind: the plain rows the snapshot's rows were, under the keys the list gave them. */
const paintOf = (from: number, n: number, text?: string) =>
  rows(from, n).map((r, i) => ({ key: JSON.stringify(['item', r.id]), role: r.role, text: i === 0 && text ? text : r.text }));
const order = (host: HTMLElement) => (host.textContent!.match(/text r\d{5}/g) ?? []).map((t) => Number(t.slice(6)));

test('asleep, the saved older rows show above the first paint where they meet it, and nothing is asked', async () => {
  const { pages, rowCache } = memory(paintOf(270, 60));
  await pages.save(KEY, { rows: rows(0, 330), more: true });
  const { runtime, calls } = rig(300);
  const { host } = await mount(runtime, rowCache, { offline: true });
  await wait(80);
  assert.ok(at(host, 329), 'the first paint');
  assert.ok(at(host, 270), 'where they meet');
  assert.ok(at(host, 100), 'a saved row above it');
  assert.equal(at(host, 69), undefined, 'the newest ASLEEP_OLDER of them');
  const seen = order(host);
  assert.deepEqual(
    seen,
    [...seen].sort((a, b) => a - b),
    'in order',
  );
  assert.equal(new Set(seen).size, seen.length, 'each row once');
  assert.equal(seen.length, ASLEEP_OLDER + 60);
  assert.equal(calls.filter(([m]) => m === 'chat.follow' || m === 'chat.read').length, 0, 'the Mac is not asked');
  assert.notEqual(await pages.load(KEY), null, 'kept');
});

test('asleep, saved rows that do not meet the first paint are not shown and are dropped', async () => {
  const { pages, rowCache } = memory(paintOf(900, 60));
  await pages.save(KEY, { rows: rows(0, 330), more: true });
  const { runtime } = rig(900);
  const { host } = await mount(runtime, rowCache, { offline: true });
  await wait(80);
  assert.ok(at(host, 950), 'the first paint alone');
  assert.equal(at(host, 100), undefined);
  assert.equal(await pages.load(KEY), null, 'a copy that is not of this history does not stay');
});

test('asleep, a first paint whose oldest rows are a folded run still meets the saved rows at the first row they have', async () => {
  const run = { key: 'run:["item","r00269"]', role: 'step', text: 'Ran 3 commands' };
  const { pages, rowCache } = memory([run, ...paintOf(270, 59)]);
  await pages.save(KEY, { rows: rows(0, 330), more: true });
  const { runtime } = rig(300);
  const { host } = await mount(runtime, rowCache, { offline: true });
  await wait(80);
  assert.ok(at(host, 100));
  assert.ok(host.textContent!.includes('Ran 3 commands') === false, 'the run is stood for by the saved rows above the join');
});

test('the join of saved rows and a first paint: at the first of its oldest rows they have, newest above only, none past the bound', () => {
  const saved = paintOf(0, 500);
  assert.equal(olderThan(saved, []), null);
  assert.equal(olderThan([], paintOf(10, 3)), null);
  assert.equal(olderThan(saved, paintOf(600, 3)), null, 'no meeting');
  assert.equal(olderThan(saved, paintOf(10, 3, 'edited'))?.from, 1, 'the first row says something else: the next one meets');
  const edited = paintOf(10, 7).map((r) => ({ ...r, text: `${r.text} changed` }));
  assert.equal(olderThan(saved, edited), null, 'none of the first five meets');
  const joined = olderThan(saved, paintOf(450, 20))!;
  assert.equal(joined.above.length, ASLEEP_OLDER);
  assert.equal(joined.above.at(-1)!.key, saved[449].key);
});

test('asleep then awake: the snapshot joins the saved rows without remounting the first rows, and the saved rows stay above', async () => {
  const { pages, rowCache } = memory(paintOf(270, 60));
  await pages.save(KEY, { rows: rows(0, 330), more: true });
  const { runtime } = rig(300);
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const root = createRoot(host);
  mounted.push(root);
  const show = (offline: boolean) =>
    act(async () =>
      root.render(
        createElement(Thread, {
          runtime,
          chatId: 'c',
          back: () => {},
          drafts: (await import('./support/phone/drafts')).fakeDraft(''),
          historyKey: KEY,
          rowCache,
          offline,
        }),
      ),
    );
  await show(true);
  await wait(80);
  assert.ok(at(host, 100), 'asleep: the saved rows show');
  await show(false);
  await wait(120);
  assert.ok(at(host, 329), 'awake: the Mac answered');
  assert.ok(at(host, 250), 'the saved rows are still above');
  const seen = order(host);
  assert.equal(new Set(seen).size, seen.length, 'no row twice');
  assert.deepEqual(
    seen,
    [...seen].sort((a, b) => a - b),
  );
  // the 260 rows shown while asleep stay mounted when the Mac answers (#5687): the screen cannot tell which of them is being read, and
  // a window cut back to the newest 120 would unmount the rest under a reader reading them; they were mounted already, so this mounts nothing
  assert.equal(shown(host), 260, 'the rows shown while asleep, with the snapshot in their place');
});

test("asleep then awake with a copy that does not belong: the Mac's rows alone, and the copy stays dropped", async () => {
  const { pages, rowCache } = memory(paintOf(900, 60));
  await pages.save(KEY, { rows: rows(0, 330), more: true });
  const { runtime } = rig(900);
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const root = createRoot(host);
  mounted.push(root);
  const { fakeDraft } = await import('./support/phone/drafts');
  const show = (offline: boolean) =>
    act(async () =>
      root.render(
        createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft(''), historyKey: KEY, rowCache, offline }),
      ),
    );
  await show(true);
  await wait(80);
  await show(false);
  await wait(120);
  assert.ok(at(host, 929));
  assert.equal(at(host, 100), undefined, 'nothing of the other history');
  assert.equal(await pages.load(KEY), null);
});

test('awake on reopen, scrolling up through saved pages shows no loading row, and only the check and the fill beyond them are asked', async () => {
  const saved = { ...backfill };
  Object.assign(backfill, { rows: 1000, gap: 5, save: 100000 });
  try {
    const { pages, rowCache } = memory();
    await pages.save(KEY, { rows: rows(0, 330), more: true });
    const reads: any[] = [];
    const { runtime } = rig(300);
    const request = runtime.request;
    runtime.request = async (method: string, params: any) => {
      if (method === 'machine.hello') return { capabilities: { methods: ['chat.read'], olderRowsHeld: true } };
      if (method === 'chat.read') {
        reads.push(params.before);
        // the Mac's page just above the snapshot is what was saved; beyond the saved rows there is nothing
        return { chatId: 'c', rows: params.before === id(300) ? rows(260, 40) : [], more: params.before === id(300), omitted: false };
      }
      return request(method, params);
    };
    const { host } = await mount(runtime, rowCache);
    await wait(100);
    assert.equal(shown(host), 120);
    const counts: number[] = [];
    const scrollTo = async (y: number) => {
      const event = new Event('scroll');
      Object.assign(event, { contentOffset: { y }, layoutMeasurement: { height: 800 } });
      await act(async () => (globalThis as any).__scrollEvents.onScrollBeginDrag());
      await act(async () => void document.querySelector('[scrolleventthrottle]')!.dispatchEvent(event));
      // the finger lifts at the top: the rows that waited for it join
      await act(async () => (globalThis as any).__scrollEvents.onScrollEndDrag({ nativeEvent: { velocity: { y: 0 } } }));
    };
    for (let i = 0; i < 4; i++) {
      await scrollTo(0);
      await wait(SETTLE_MS + 40);
      counts.push(shown(host));
      assert.doesNotMatch(host.textContent!, /Loading/, 'no loading row for a page that is saved');
    }
    assert.deepEqual(counts.slice(0, 2), [240, 330], 'each step shows saved rows, up to the oldest one');
    assert.ok(at(host, 0), 'the oldest saved row is there');
    assert.deepEqual(
      [...new Set(reads)].sort(),
      [id(0), id(300)],
      'the Mac was asked for the check (the page before the snapshot) and for what lies beyond the saved rows, and for no page the phone has',
    );
  } finally {
    Object.assign(backfill, saved);
  }
});

const LINE = /Saved on this phone · may be out of date/;

test('a line says the saved rows may be out of date while the Mac does not answer, and only then', async () => {
  const { pages, rowCache } = memory(paintOf(270, 60));
  await pages.save(KEY, { rows: rows(0, 330), more: true });
  // asleep
  const asleep = await mount(rig(300).runtime, rowCache, { offline: true });
  await wait(80);
  assert.match(asleep.host.textContent!, LINE);
  // outside the scrolling list: with hundreds of saved rows pinned at the bottom, a line at the top of them would never be seen
  assert.doesNotMatch(asleep.host.querySelector('[scrolleventthrottle]')!.textContent!, LINE);
  // the Mac does not answer the follow (not asleep as the presence says, but not answering): the same line
  const failing = rig(300, {
    follow: () => {
      throw new Error('Your computer is offline.');
    },
  });
  const lost = await mount(failing.runtime, rowCache);
  await wait(120);
  assert.match(lost.host.textContent!, LINE);
  // the Mac answers: the rows are its own
  const awake = await mount(rig(300).runtime, rowCache);
  await wait(120);
  assert.doesNotMatch(awake.host.textContent!, LINE, 'awake');
  // a build that keeps no pages shows the first paint as it always did
  const { rowCache: plain } = memory(paintOf(270, 60));
  const bare = await mount(
    rig(300).runtime,
    { load: plain.load, save: plain.save, remove: plain.remove, prune: plain.prune, clear: plain.clear },
    { offline: true },
  );
  await wait(80);
  assert.doesNotMatch(bare.host.textContent!, LINE, 'bare');
  // saved rows with nothing to show: no line over an empty page
  forgetRows(); // the rows the chat showed a moment ago are kept in memory too
  const empty = memory([]);
  const none = await mount(rig(300).runtime, empty.rowCache, { offline: true });
  await wait(60);
  assert.doesNotMatch(none.host.textContent!, LINE, 'none');
});

test('saved rows that have no role or text are joined to the first paint under the defaults a row has (a step with no words)', async () => {
  const blank = { id: 'r00300' };
  const key = JSON.stringify(['item', 'r00300']);
  // the first paint is that one row alone, so only it can meet the saved rows
  const { pages, rowCache } = memory([{ key, role: 'step', text: '' }]);
  await pages.save(KEY, { rows: [...rows(0, 300), blank], more: true });
  const { host } = await mount(rig(300).runtime, rowCache, { offline: true });
  await wait(80);
  assert.ok(at(host, 150), 'the saved rows are above it');
  assert.notEqual(await pages.load(KEY), null, 'and the copy stays');
});
