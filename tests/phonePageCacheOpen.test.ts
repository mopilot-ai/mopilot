// Reopening a long chat finds its older rows in the sealed page cache (#5379): they are placed above the first snapshot when its first row is one of them, with no request, without remounting the rows the reader sees; and they are only a first paint (a stale copy is not placed and is replaced, a deleted chat's copy goes, a Mac that is away is not asked).
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';
import { at, id, KEY, macWith, memory, mount, mounted, rig, rows, row, shown, wait } from './support/phone/pages-kit';
// the paths are variables, so the root typecheck does not take the whole phone app in with this file
const earlierPath = '../mobile/src/remote/useEarlier';
const { backfill } = await import(earlierPath);
// a chat left open would keep its timers (the delayed save, the fill) running past the test
afterEach(async () => {
  for (const root of mounted.splice(0)) await act(async () => root.unmount());
});

test('a chat reopened finds the rows above its snapshot at once, with no request for them', async () => {
  const { pages, rowCache } = memory();
  await pages.save(KEY, { rows: rows(0, 330), more: true });
  const { runtime, reads } = rig(300);
  const { host } = await mount(runtime, rowCache);
  await wait(50);
  assert.ok(at(host, 329), 'the newest row');
  assert.ok(at(host, 250), 'a row of the saved pages, above the snapshot (the window mounts the newest 120 blocks)');
  assert.equal(shown(host), 120);
  assert.equal(reads(), 0, 'nothing was asked of the Mac for them');
});

test('saved rows that arrive after the snapshot join above it and remount nothing: the rows the reader sees are the same elements, in order', async () => {
  const { pages, gate, rowCache } = memory();
  await pages.save(KEY, { rows: rows(0, 330), more: true });
  let release!: () => void;
  gate.read = new Promise<void>((resolve) => (release = resolve));
  const { runtime } = rig(300);
  const { host } = await mount(runtime, rowCache);
  const before = [at(host, 300)!, at(host, 315)!, at(host, 329)!];
  assert.ok(before.every(Boolean));
  assert.equal(shown(host), 30, 'the snapshot alone');
  release();
  await wait(50);
  assert.equal(shown(host), 120, 'the saved rows joined above');
  assert.deepEqual([at(host, 300), at(host, 315), at(host, 329)], before, 'the same elements: nothing mounted again');
  const order = (host.textContent!.match(/text r\d{5}/g) ?? []).map((t) => Number(t.slice(6)));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    'in order',
  );
});

test('saved rows that arrive after the reader already paged back are not placed', async () => {
  const { pages, gate, rowCache } = memory();
  await pages.save(KEY, { rows: rows(0, 330), more: true });
  let release!: () => void;
  gate.read = new Promise<void>((resolve) => (release = resolve));
  const { runtime } = rig(300);
  const { host } = await mount(runtime, rowCache);
  await act(async () => (globalThis as any).__scrollEvents.onScrollBeginDrag());
  release();
  await wait(50);
  assert.equal(shown(host), 30, 'the finger is on the list: nothing moves it');
});

test("a saved copy whose rows are not the snapshot's (the chat was compacted or rewound) is not placed, and is replaced when the chat is left", async () => {
  for (const snapshotFirst of [row(300, 'edited'), row(900)]) {
    const { pages, rowCache, saved } = memory();
    await pages.save(KEY, { rows: rows(0, 330), more: true });
    const old = saved();
    const { runtime } = rig(300, {
      follow: () => ({
        rev: 1,
        feedSeq: 0,
        session: { turn: 'idle', cards: [] },
        itemsShape: 'rows',
        items: [snapshotFirst, ...rows(901, 29)],
      }),
    });
    const { host, root } = await mount(runtime, rowCache);
    await wait(50);
    assert.ok(shown(host) >= 29 && shown(host) <= 30, 'only the snapshot');
    assert.equal(at(host, 250), undefined);
    await act(async () => root.unmount());
    mounted.length = 0;
    await wait(20);
    assert.notEqual(saved(), old, 'what the Mac said replaced it');
    const again = await pages.load(KEY);
    assert.equal(again!.rows.length, 30, 'only the rows the Mac showed');
  }
});

test('a snapshot that starts at the oldest saved row, or a copy with one row, has nothing above it to place', async () => {
  const { pages, rowCache } = memory();
  await pages.save(KEY, { rows: rows(300, 30), more: true });
  const { runtime } = rig(300);
  const { host } = await mount(runtime, rowCache);
  await wait(50);
  assert.equal(shown(host), 30);
});

test('the rows above the snapshot are saved when the chat is left, and a while after they change', async () => {
  const { rowCache, pages, saved } = memory();
  const { runtime } = rig(300);
  const { host, root } = await mount(runtime, rowCache);
  assert.equal(saved(), undefined, 'nothing is saved before the Mac has answered and the delay has passed');
  await act(async () => root.unmount());
  mounted.length = 0;
  await wait(20);
  assert.ok(saved(), 'saved at once on leaving');
  const copy = await pages.load(KEY);
  assert.deepEqual(copy!.rows, rows(300, 30));
  assert.equal(copy!.more, true, 'the chat may go back further: it was not asked');
  void host;
});

test('a chat the Mac says is gone loses its saved rows and its saved pages', async () => {
  const { pages, rowCache, kept } = memory();
  await pages.save(KEY, { rows: rows(0, 330), more: true });
  assert.equal(kept.size, 1);
  const { runtime } = rig(300, {
    follow: () => {
      throw new Error('There is no such chat on this computer.');
    },
  });
  await mount(runtime, rowCache);
  await wait(80);
  assert.equal(kept.size, 0);
  assert.equal(await pages.load(KEY), null);
});

test('a Mac that is away is not asked, and the saved rows are left as they are', async () => {
  const { pages, rowCache, kept } = memory();
  await pages.save(KEY, { rows: rows(0, 330), more: true });
  const before = kept.get(KEY);
  const { runtime, calls } = rig(300);
  const { host } = await mount(runtime, rowCache, { offline: true });
  await wait(50);
  assert.equal(calls.filter(([m]) => m === 'chat.follow' || m === 'chat.read').length, 0);
  assert.equal(shown(host), 0, 'the first paint of the rows cache is a different path');
  assert.equal(kept.get(KEY), before, 'untouched');
});

test('a key that does not answer, or no pages cache at all, opens the chat as it was', async () => {
  const { pages, rowCache, keychain } = memory();
  await pages.save(KEY, { rows: rows(0, 330), more: true });
  keychain.fails = true;
  const { runtime, reads } = rig(300);
  const { host, root } = await mount(runtime, rowCache);
  await wait(50);
  assert.equal(shown(host), 30, 'no cache is not an empty chat: the snapshot shows');
  await act(async () => root.unmount());
  mounted.length = 0;
  await wait(20);
  keychain.fails = false;
  assert.notEqual(await pages.load(KEY), null, 'nothing was written from an unreadable key');
  const plain = rig(300);
  const bare = await mount(plain.runtime, {
    load: async () => [],
    loadChat: async () => ({ rows: [], changes: null }),
    save: async () => undefined,
    remove: async () => undefined,
    prune: async () => undefined,
    clear: async () => undefined,
  });
  await wait(50);
  assert.equal(shown(bare.host), 30);
  assert.equal(reads(), 0);
});

test('the rows are also saved a while after the chat settles, not only when it is left, and a change before then waits again', async () => {
  const saveDelay = backfill.save;
  backfill.save = 40;
  try {
    const { rowCache, saved } = memory();
    const { runtime } = rig(300);
    await mount(runtime, rowCache);
    assert.equal(saved(), undefined, 'not at once');
    await wait(120);
    assert.ok(saved(), 'saved while the chat is still open');
  } finally {
    backfill.save = saveDelay;
  }
});

test('the fill and the saving work together: the chat fills above the saved rows and stops when it is left', async () => {
  const kept = { ...backfill };
  Object.assign(backfill, { rows: 1000, gap: 5, save: 30 });
  try {
    const { pages, rowCache, saved } = memory();
    await pages.save(KEY, { rows: rows(0, 330), more: true });
    const calls: any[] = [];
    const { runtime } = rig(300);
    const request = runtime.request;
    runtime.request = async (method: string, params: any) => {
      if (method === 'machine.hello') return { capabilities: { methods: ['chat.read'], olderRowsHeld: true } };
      if (method === 'chat.read') {
        calls.push(params);
        // the check of the placed rows is answered as the Mac would (the rows just above the snapshot), and the fill is at the start of the chat
        return { chatId: 'c', rows: params.before === id(300) ? rows(260, 40) : [], more: params.before === id(300) };
      }
      return request(method, params);
    };
    const { root } = await mount(runtime, rowCache);
    await wait(150);
    assert.equal(calls[0].before, id(300), 'the placed rows were set against the Mac first');
    assert.ok(
      calls.some((c) => c.before === id(0)),
      'then the fill asked from the oldest saved row',
    );
    assert.ok(saved());
    await act(async () => root.unmount());
    mounted.length = 0;
    const asked = calls.length;
    await wait(60);
    assert.equal(calls.length, asked, 'left: nothing more is asked');
  } finally {
    Object.assign(backfill, kept);
  }
});

test('a snapshot of the other shape (a turn is running: its saved rows are `history`) is placed on as one of rows is; one whose first row names nothing, or disagrees in role, is not', async () => {
  const snapshots: [object, boolean][] = [
    [{ itemsShape: 'items', history: rows(300, 30), items: [] }, true],
    [{ itemsShape: 'rows', items: [{ role: 'user', text: 'no id' }, ...rows(301, 29)] }, false],
    [{ itemsShape: 'rows', items: [{ ...row(300), role: 'step' }, ...rows(301, 29)] }, false],
  ];
  for (const [snapshot, placed] of snapshots) {
    const { pages, rowCache } = memory();
    await pages.save(KEY, { rows: rows(0, 330), more: true });
    const { runtime } = rig(300, { follow: () => ({ rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, ...snapshot }) });
    const { host } = await mount(runtime, rowCache);
    await wait(50);
    assert.equal(at(host, 250) !== undefined, placed, JSON.stringify(Object.keys(snapshot)));
    assert.equal((await pages.load(KEY)) !== null, placed, 'a copy that was placed stays; one that does not belong goes');
  }
});

const threadModulePath = '../mobile/src/presentation/thread';
const { snapshot } = await import(threadModulePath);

test("the Mac's epoch is read from the snapshot when it is a name, and is none otherwise", () => {
  const base = { rev: 1, session: { turn: 'idle' }, items: [], itemsShape: 'rows' };
  assert.equal(snapshot({ ...base, historyEpoch: 'abc' }).epoch, 'abc');
  for (const bad of [undefined, '', 7, null, {}]) assert.equal('epoch' in snapshot({ ...base, historyEpoch: bad }), false);
});

const page = (rowsOf: object[], more = true) => ({ chatId: 'c', rows: rowsOf, more, omitted: false });

test('a saved copy is placed only under the same name of the history: another name, or a name on one side only, drops it', async () => {
  const cases: [string | undefined, string | undefined, boolean][] = [
    ['e1', 'e1', true],
    ['e1', 'e2', false],
    [undefined, 'e2', false],
    ['e1', undefined, false],
    [undefined, undefined, true],
  ];
  for (const [saved, mac, placed] of cases) {
    const { pages, rowCache } = memory();
    await pages.save(KEY, { rows: rows(0, 330), more: true, ...(saved ? { epoch: saved } : {}) });
    const { runtime } = macWith(mac, (p) => page(p.before === id(300) ? rows(260, 40) : []));
    const { host } = await mount(runtime, rowCache);
    await wait(80);
    assert.equal(at(host, 250) !== undefined, placed, `saved ${saved}, Mac ${mac}`);
    assert.equal((await pages.load(KEY)) !== null, placed, 'a copy that does not belong is dropped, not kept to be tried again');
  }
});

test('the epoch the Mac named is saved with the rows', async () => {
  const { pages, rowCache } = memory();
  const { runtime } = macWith('e7', () => page([]));
  const { root } = await mount(runtime, rowCache);
  await act(async () => root.unmount());
  mounted.length = 0;
  await wait(20);
  assert.equal((await pages.load(KEY))!.epoch, 'e7');
});

test("placed rows are set against the Mac's own rows just above the snapshot: the same keep, anything else drops them, they are not patched", async () => {
  const same = rows(260, 40);
  const cases: [string, (p: any) => unknown, boolean][] = [
    ['the same rows', () => page(same), true],
    ['fewer rows than saved, the same', () => page(rows(280, 20)), true],
    ['a row that says something else', () => page(rows(260, 40).map((r, i) => (i === 39 ? { ...r, text: 'rewritten' } : r))), false],
    ['another id', () => page([{ ...row(299), id: 'other' }]), false],
    ['nothing above the snapshot', () => page([], false), false],
  ];
  for (const [name, read, kept] of cases) {
    const { pages, rowCache } = memory();
    await pages.save(KEY, { rows: rows(0, 330), more: true });
    const { runtime, reads } = macWith(undefined, read);
    const { host } = await mount(runtime, rowCache);
    await wait(120);
    assert.equal(reads[0]?.before, id(300), 'asked for the page before the snapshot');
    assert.equal(at(host, 250) !== undefined, kept, name);
    assert.equal((await pages.load(KEY)) !== null, kept, name);
  }
});

test('a Mac that cannot be asked for the check keeps the placed rows, and one that does not say it pages from held rows is not asked at all', async () => {
  const { pages, rowCache } = memory();
  await pages.save(KEY, { rows: rows(0, 330), more: true });
  const failing = macWith(undefined, () => {
    throw new Error('Your computer is offline.');
  });
  const { host } = await mount(failing.runtime, rowCache);
  await wait(80);
  assert.ok(at(host, 250), 'an unanswered check is no reason to drop');
  assert.ok(failing.reads.length >= 1);
});

test('a check of the placed rows that is answered after the chat was read from its start again changes nothing', async () => {
  const { pages } = memory();
  await pages.save(KEY, { rows: rows(0, 330), more: true });
  let release!: (page: unknown) => void;
  const request: any = async (method: string) => {
    if (method === 'machine.hello') return { capabilities: { methods: ['chat.read'], olderRowsHeld: true } };
    return new Promise((resolve) => (release = resolve));
  };
  const useEarlierPath = '../mobile/src/remote/useEarlier';
  const { useEarlier } = await import(useEarlierPath);
  let api: any;
  const Probe = () => ((api = useEarlier(request, 'c', pages, KEY)), null);
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(Probe)));
  await wait(40);
  const next = { shape: 'rows', items: rows(300, 30), history: [], session: {} };
  await act(async () => api.reread(null, next));
  assert.equal(api.rows.length, 300, 'the saved rows are placed');
  await wait(20);
  // read from its start again while the check is out: its answer belongs to the history before
  await act(async () => api.reset());
  await act(async () => release({ chatId: 'c', rows: [], more: false, omitted: false }));
  await wait(20);
  assert.notEqual(await pages.load(KEY), null, 'the stale answer did not remove the copy');
  await act(async () => root.unmount());
});
