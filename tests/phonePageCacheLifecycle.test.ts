// What the saved pages do over a chat's life and a phone's (#5379): a chat left after a sign-out writes nothing, a check of the placed rows that cannot be answered is tried again, a copy found wrong is replaced by the Mac's own rows above the snapshot with the rows the reader sees left where they are, and a fully paged chat that was trimmed to fit is not read as starting at its top.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';
import { waitFor } from './support/waitFor';
import { at, id, KEY, macWith, memory, mount, mounted, rows, shown, wait } from './support/phone/pages-kit';
// the paths are variables, so the root typecheck does not take the whole phone app in with this file
const earlierPath = '../mobile/src/remote/useEarlier';
const { backfill } = await import(earlierPath);

afterEach(async () => {
  for (const root of mounted.splice(0)) await act(async () => root.unmount());
});
// polls on the real clock, flushing React between looks (a loaded runner gets the same chance as an idle one)
const until = (done: () => boolean) => waitFor(done, 'the check to be asked', { step: () => wait(10) });
const page = (rowsOf: object[], more = true) => ({ chatId: 'c', rows: rowsOf, more, omitted: false });

test('a chat left after the phone signed out writes nothing, and the same account signing in again finds nothing of it', async () => {
  const { pages, rowCache, kept } = memory();
  await pages.save(KEY, { rows: rows(0, 330), more: true });
  const { runtime } = macWith(undefined, () => page(rows(260, 40)));
  const { root } = await mount(runtime, rowCache);
  await wait(60);
  // signing out clears what is kept, while the chat is still open; then the screen is left, which saves what it holds
  await rowCache.clear();
  assert.equal(kept.size, 0);
  await act(async () => root.unmount());
  mounted.length = 0;
  await wait(40);
  assert.equal(kept.size, 0, 'left after the clear: nothing is written back');
  assert.equal(await pages.load(KEY), null);
});

test('a check that cannot be answered is asked again, and a copy found wrong then is replaced', async () => {
  const saved = { ...backfill };
  Object.assign(backfill, { retry: 150 });
  try {
    const { pages, rowCache } = memory();
    await pages.save(KEY, { rows: rows(0, 330), more: true });
    let tries = 0;
    const mac = macWith(undefined, () => {
      if (++tries <= 2) throw new Error('Your computer is offline.');
      return page(rows(260, 40).map((r, i) => (i === 39 ? { ...r, text: 'rewritten' } : r)));
    });
    const { host } = await mount(mac.runtime, rowCache);
    await until(() => tries >= 1);
    assert.ok(at(host, 250), 'while the check is unanswered the saved rows stay');
    await until(() => tries >= 3);
    await wait(80);
    assert.equal(tries, 3, 'asked three times, later each time');
    assert.equal(at(host, 250), undefined, "the saved rows were not the Mac's");
    assert.match(host.textContent!, /rewritten/, "the Mac's own rows are above the snapshot");
    assert.equal(await pages.load(KEY), null);
  } finally {
    Object.assign(backfill, saved);
  }
});

test('a check that is never answered stops asking', async () => {
  const saved = { ...backfill };
  Object.assign(backfill, { retry: 1 });
  try {
    const { pages, rowCache } = memory();
    await pages.save(KEY, { rows: rows(0, 330), more: true });
    const mac = macWith(undefined, () => {
      throw new Error('Your computer is offline.');
    });
    const { host } = await mount(mac.runtime, rowCache);
    await wait(250);
    const asked = mac.reads.length;
    await wait(120);
    assert.equal(mac.reads.length, asked, 'no more after the last try');
    assert.ok(at(host, 250), 'and the saved rows are kept');
  } finally {
    Object.assign(backfill, saved);
  }
});

test("a copy found wrong is replaced by the Mac's rows above the snapshot, and the rows the reader sees are the same elements", async () => {
  const { pages, rowCache } = memory();
  await pages.save(KEY, { rows: rows(0, 330), more: true });
  let release!: (page: unknown) => void;
  const mac = macWith(undefined, () => new Promise((resolve) => (release = resolve)));
  const { host } = await mount(mac.runtime, rowCache);
  await wait(60);
  const before = [at(host, 300), at(host, 315), at(host, 329)];
  assert.ok(before.every(Boolean));
  assert.ok(at(host, 250), 'the saved rows are above the snapshot while the check is out');
  await act(async () => release(page(rows(270, 30).map((r) => ({ ...r, text: `changed ${r.id}` })))));
  await wait(60);
  assert.deepEqual([at(host, 300), at(host, 315), at(host, 329)], before, 'what the reader sees was not mounted again');
  assert.equal(at(host, 250), undefined, 'the saved rows are gone');
  assert.match(host.textContent!, /changed r00299/, "the Mac's row directly above the snapshot");
  assert.equal(shown(host) >= 30, true);
});

test('a chat fully paged to its start that was trimmed to fit is not read as starting at its top', async () => {
  // the rows are large: only the newest part of a chat of 300 rows fits the copy
  const big = rows(0, 300).map((r) => ({ ...r, text: `${r.text} ${'x'.repeat(2000)}` }));
  const { pages } = memory();
  await pages.save(KEY, { rows: big, more: false });
  const copy = (await pages.load(KEY))!;
  assert.ok(copy.rows.length < 300, 'trimmed');
  assert.equal(copy.more, true, 'the oldest rows are not there: the chat goes back further');
  assert.equal(id(0), 'r00000');
});

test('a copy found wrong is replaced even when the snapshot has rows that name nothing', async () => {
  const { pages, rowCache } = memory();
  await pages.save(KEY, { rows: rows(0, 330), more: true });
  const mac = macWith(undefined, () => page(rows(270, 30).map((r) => ({ ...r, text: `changed ${r.id}` }))), [
    { role: 'step', text: 'a row with no id' },
  ]);
  const { host } = await mount(mac.runtime, rowCache);
  await wait(120);
  assert.equal(at(host, 250), undefined);
  assert.match(host.textContent!, /changed r00299/);
});

test('the chat list read again while a chat is open (every chat kept) does not stop the chat from saving when it is left', async () => {
  const { pages, rowCache, kept } = memory();
  const { runtime } = macWith(undefined, () => page(rows(260, 40)));
  const { root } = await mount(runtime, rowCache);
  await wait(60);
  // what useDiskCaches does each time the computer's list changes
  await rowCache.prune(() => true);
  await rowCache.prune((key: string) => (JSON.parse(key) as string[])[2] === 'c');
  await act(async () => root.unmount());
  mounted.length = 0;
  await wait(40);
  assert.equal(kept.size, 1, 'saved on leaving');
  assert.equal((await pages.load(KEY))!.rows.length, 30);
});

test('a copy found wrong while a finger is on the list is replaced when the finger lifts, not under it', async () => {
  const { pages } = memory();
  await pages.save(KEY, { rows: rows(0, 330), more: true });
  let release!: (page: unknown) => void;
  const request: any = async (method: string) => {
    if (method === 'machine.hello') return { capabilities: { methods: ['chat.read'], olderRowsHeld: true } };
    return new Promise((resolve) => (release = resolve));
  };
  const { useEarlier } = await import(earlierPath);
  let api: any;
  const Probe = () => ((api = useEarlier(request, 'c', pages, KEY)), null);
  const root = createRoot(document.createElement('div'));
  mounted.push(root);
  await act(async () => root.render(createElement(Probe)));
  await wait(40);
  await act(async () => api.reread(null, { shape: 'rows', items: rows(300, 30), history: [], session: {} }));
  assert.equal(api.rows.length, 300, 'the saved rows are placed');
  await wait(20);
  await act(async () => api.grab());
  await act(async () => release(page(rows(270, 30).map((r) => ({ ...r, text: `changed ${r.id}` })))));
  await wait(400);
  assert.equal(api.rows.length, 300, 'a finger is on the list: the rows it may be reading stay');
  await act(async () => api.release());
  await wait(400);
  assert.equal(api.rows.length, 30, "lifted: the Mac's own rows take their place");
  assert.equal(api.rows[29].text, 'changed r00299');
});

test('a copy found wrong that waited for a finger is not put in after the chat was read from its start again', async () => {
  const { pages } = memory();
  await pages.save(KEY, { rows: rows(0, 330), more: true });
  let release!: (page: unknown) => void;
  const request: any = async (method: string) => {
    if (method === 'machine.hello') return { capabilities: { methods: ['chat.read'], olderRowsHeld: true } };
    return new Promise((resolve) => (release = resolve));
  };
  const { useEarlier } = await import(earlierPath);
  let api: any;
  const Probe = () => ((api = useEarlier(request, 'c', pages, KEY)), null);
  const root = createRoot(document.createElement('div'));
  mounted.push(root);
  await act(async () => root.render(createElement(Probe)));
  await wait(40);
  await act(async () => api.reread(null, { shape: 'rows', items: rows(300, 30), history: [], session: {} }));
  await wait(20);
  await act(async () => api.grab());
  await act(async () => release(page(rows(270, 30).map((r) => ({ ...r, text: `changed ${r.id}` })))));
  await wait(20);
  await act(async () => api.reset());
  await act(async () => api.release());
  await wait(400);
  assert.equal(api.rows.length, 0, 'the old answer was not put in over the new reading');
});
