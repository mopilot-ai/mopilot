// Reading older messages on the phone: the page request and its checks, and the chat screen paging back above its snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { fakeDraft } from './support/phone/drafts';
const threadPath = '../mobile/src/screens/Thread';
const earlierPath = '../mobile/src/remote/earlier';
const { Thread } = await import(threadPath);
const blocksPath = '../mobile/src/components/TranscriptBlocks';
const { usePagedAbove } = await import(blocksPath);
const { oldestId, readEarlier, PAGE } = await import(earlierPath);

const thread = (shape: string, over: object = {}) => ({ shape, items: [], history: [], ...over });

test('the oldest row id is the first saved row, whichever shape the snapshot has, or nothing', () => {
  assert.equal(oldestId(thread('rows', { items: [{ id: 'r1' }, { id: 'r2' }] })), 'r1');
  assert.equal(oldestId(thread('items', { history: [{ id: 'h1' }], items: [{ id: 'live' }] })), 'h1');
  assert.equal(oldestId(thread('rows', { items: [{ role: 'user', text: 'no id' }] })), null);
  assert.equal(oldestId(thread('rows')), null);
  assert.equal(oldestId(thread('items', { history: [{ id: '' }] })), null);
});

test('a page request names the row it ends before and checks what comes back', async () => {
  const asked: any[] = [];
  const request = async (method: string, params: any) => {
    asked.push([method, params]);
    return {
      chatId: 'c',
      rows: [{ role: 'user', text: 'a', id: 'x' }, { role: 5, text: 'bad' }, null, { role: 'assistant', text: 'b' }],
      more: true,
    };
  };
  assert.deepEqual(await readEarlier(request as any, 'c', 'row-9'), {
    rows: [
      { role: 'user', text: 'a', id: 'x' },
      { role: 'assistant', text: 'b' },
    ],
    more: true,
    omitted: false,
  });
  assert.deepEqual(asked, [['chat.read', { chatId: 'c', before: 'row-9', limit: PAGE }]]);
  for (const reply of [null, 'x', {}, { rows: 'no', more: true }, { rows: [], more: 'yes' }])
    await assert.rejects(readEarlier((async () => reply) as any, 'c', 'r'), /Could not read earlier messages/);
});

function rig(pages: any[]) {
  const calls: any[] = [];
  const listeners = { current: (_e: any) => {} };
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: (f: any) => ((listeners.current = f), () => {}),
    request: async (method: string, p: any) => {
      calls.push([method, p]);
      if (method === 'chat.follow')
        return {
          rev: 1,
          feedSeq: 0,
          session: { turn: 'idle', cards: [] },
          itemsShape: 'rows',
          items: [
            { id: 'r10', role: 'user', text: 'newest question' },
            { id: 'r11', role: 'assistant', text: 'newest answer' },
          ],
        };
      if (method === 'chat.read') {
        const next = pages.shift();
        if (next instanceof Error) throw next;
        return next;
      }
      return {};
    },
  };
  withOutbox(runtime);
  return { runtime, calls, listeners };
}
const mounted: any[] = [];
const mount = async (runtime: any) => {
  for (const old of mounted.splice(0)) await act(async () => old.unmount());
  document.body.replaceChildren();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  await act(async () => root.render(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') })));
  await flush();
  return host;
};

test('Load earlier messages adds the page above the snapshot, asks again from the oldest row, and says when the chat starts', async () => {
  const { runtime, calls } = rig([
    {
      chatId: 'c',
      rows: [
        { id: 'r8', role: 'user', text: 'older question' },
        { id: 'r9', role: 'assistant', text: 'older answer' },
      ],
      more: true,
    },
    { chatId: 'c', rows: [{ id: 'r7', role: 'assistant', text: 'first answer' }], more: false },
  ]);
  const host = await mount(runtime);
  assert.match(host.textContent!, /Load earlier messages/);
  assert.doesNotMatch(host.textContent!, /start of the chat/);
  await click('Load earlier messages');
  assert.deepEqual(calls.at(-1), ['chat.read', { chatId: 'c', before: 'r10', limit: 40 }]);
  const text = host.textContent!;
  assert.ok(
    text.indexOf('older question') < text.indexOf('older answer') && text.indexOf('older answer') < text.indexOf('newest question'),
  );
  await click('Load earlier messages');
  assert.deepEqual(calls.at(-1), ['chat.read', { chatId: 'c', before: 'r8', limit: 40 }], 'the page before the oldest row now shown');
  assert.ok(host.textContent!.indexOf('first answer') < host.textContent!.indexOf('older question'));
  assert.match(host.textContent!, /This is the start of the chat\./);
  assert.doesNotMatch(host.textContent!, /Load earlier messages/);
});

test('a failed page says why, keeps what is shown and can be asked for again; a chat that changed asks for a refresh', async () => {
  const { runtime } = rig([
    new Error('Your computer is offline.'),
    new Error('This chat changed. Refresh it to read earlier messages.'),
    { chatId: 'c', rows: [{ id: 'r9', role: 'user', text: 'recovered' }], more: true },
  ]);
  const host = await mount(runtime);
  await click('Load earlier messages');
  assert.match(host.textContent!, /Your computer is offline/);
  assert.match(host.textContent!, /newest answer/);
  await click('Load earlier messages');
  assert.match(host.textContent!, /Refresh it to read earlier messages/);
  await click('Load earlier messages');
  assert.match(host.textContent!, /recovered/);
  assert.doesNotMatch(host.textContent!, /Refresh it to read earlier messages/);
});

test('a chat that changed reads itself again by itself: the older rows it covers are forgotten, and a snapshot without row ids offers no paging', async () => {
  const { runtime, listeners } = rig([{ chatId: 'c', rows: [{ id: 'r9', role: 'user', text: 'older one' }], more: true }]);
  const host = await mount(runtime);
  await click('Load earlier messages');
  assert.match(host.textContent!, /older one/);
  // history changed under the reader: the chat reads itself again, with no tap
  await act(async () => listeners.current({ kind: 'event', chatId: 'c', ev: 'items.append', feedSeq: 1, live: false, items: [] }));
  runtime.request = async (method: string) =>
    method === 'chat.follow'
      ? {
          rev: 2,
          feedSeq: 0,
          historyStale: true,
          session: { turn: 'idle', cards: [] },
          itemsShape: 'rows',
          items: [{ role: 'user', text: 'plain' }],
        }
      : {};
  await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 400)));
  assert.doesNotMatch(host.textContent!, /Refresh chat/);
  assert.doesNotMatch(host.textContent!, /older one/);
  assert.match(host.textContent!, /plain/);
  assert.doesNotMatch(host.textContent!, /Load earlier messages/);
});

test('a live turn starting does not take the paging away, and a page of history the computer has dropped says so instead of offering more', async () => {
  const { runtime, listeners } = rig([{ chatId: 'c', rows: [], more: false, omitted: true }]);
  const host = await mount(runtime);
  assert.match(host.textContent!, /Load earlier messages/);
  // a turn starts: the thread's rows are rebuilt without their ids
  await act(async () =>
    listeners.current({
      kind: 'event',
      chatId: 'c',
      ev: 'turn.state',
      feedSeq: 1,
      live: true,
      started: true,
      status: 'inProgress',
      turnId: 't9',
    }),
  );
  assert.match(host.textContent!, /Load earlier messages/, 'the first snapshot named the oldest row');
  await click('Load earlier messages');
  assert.match(host.textContent!, /Earlier messages are only in MoPilot on your computer\./);
  assert.doesNotMatch(host.textContent!, /Load earlier messages/);
});

test('two taps before the screen redraws ask for one page, not two', async () => {
  const { runtime, calls } = rig([{ chatId: 'c', rows: [{ id: 'r9', role: 'user', text: 'once' }], more: true }]);
  const host = await mount(runtime);
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Load earlier messages') as HTMLButtonElement;
  await act(async () => {
    button.click();
    button.click();
  });
  await flush();
  assert.equal(calls.filter(([m]) => m === 'chat.read').length, 1);
  assert.equal((host.textContent!.match(/once/g) ?? []).length, 1);
});

test('a page that was on its way when the chat was read again is not added to the new snapshot', async () => {
  let release!: (v: unknown) => void;
  const { runtime, listeners } = rig([new Promise((resolve) => (release = resolve))]);
  const host = await mount(runtime);
  // the tap is not awaited by an act scope, which would hold every update back until the page is answered
  const tap = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Load earlier messages') as HTMLButtonElement;
  await act(async () => tap.click());
  await act(async () => listeners.current({ kind: 'event', chatId: 'c', ev: 'items.append', feedSeq: 1, live: false, items: [] }));
  await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 400)));
  await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 100)));
  release({ chatId: 'c', rows: [{ id: 'r1', role: 'user', text: 'stale page' }], more: true });
  await flush();
  assert.doesNotMatch(host.textContent!, /stale page/);
  assert.match(host.textContent!, /Load earlier messages/, 'the new snapshot can be paged from its own start');
});

const events = () => (globalThis as any).__scrollEvents;
const scrollTo = (y: number) =>
  act(async () =>
    events().onScroll({ nativeEvent: { contentOffset: { y }, contentSize: { height: 3000 }, layoutMeasurement: { height: 600 } } }),
  );
const reads = (calls: any[]) => calls.filter(([m]) => m === 'chat.read').length;

const pause = (ms: number) => act(async () => new Promise<void>((resolve) => setTimeout(resolve, ms)));

test('a finger at the top asks for one page per gesture; a scroll within three screens of the top asks ahead, with no finger, and farther away asks for nothing (#4734, #5379)', async () => {
  const { runtime, calls } = rig([
    { chatId: 'c', rows: [{ id: 'r8', role: 'user', text: 'page one' }], more: true },
    { chatId: 'c', rows: [{ id: 'r7', role: 'user', text: 'page two' }], more: true },
    { chatId: 'c', rows: [{ id: 'r6', role: 'user', text: 'page three' }], more: false },
  ]);
  const host = await mount(runtime);
  await scrollTo(5000);
  assert.equal(reads(calls), 0, 'far from the top: nothing, finger or not');
  await act(async () => events().onScrollBeginDrag());
  await scrollTo(2500);
  assert.equal(reads(calls), 0, 'a gesture still four screens from the top asks for nothing');
  await scrollTo(60);
  await flush();
  assert.equal(reads(calls), 1);
  // the page waits for the finger to lift: nothing is mounted above a reader mid-scroll
  assert.doesNotMatch(host.textContent!, /page one/);
  await act(async () => events().onScrollEndDrag({ nativeEvent: { velocity: { y: 0 } } }));
  assert.match(host.textContent!, /page one/);
  assert.deepEqual(calls.filter(([m]) => m === 'chat.read').at(-1), ['chat.read', { chatId: 'c', before: 'r10', limit: 40 }]);
  // the page landed and the list did not hold the place: the next scroll events are near the top again, under the same finger
  await scrollTo(10);
  await scrollTo(0);
  await flush();
  assert.equal(reads(calls), 1, 'one gesture, one page at the top');
  await pause(350);
  // no finger: the list within three screens of the top fetches the page ahead of the reader, a bigger one
  await act(async () => events().onMomentumScrollEnd());
  await scrollTo(1700);
  await flush();
  assert.equal(reads(calls), 2);
  assert.deepEqual(calls.filter(([m]) => m === 'chat.read').at(-1), ['chat.read', { chatId: 'c', before: 'r8', limit: 80 }]);
  assert.match(host.textContent!, /page two/);
  await pause(350);
  await scrollTo(1700);
  await flush();
  await act(async () => events().onScrollEndDrag({ nativeEvent: { velocity: { y: 0 } } }));
  assert.equal(reads(calls), 3);
  await pause(350);
  await scrollTo(1700);
  await flush();
  await act(async () => events().onScrollEndDrag({ nativeEvent: { velocity: { y: 0 } } }));
  assert.equal(reads(calls), 3, 'the chat starts there: nothing more to ask for');
});

test('a gesture that ends in a failed page does not ask again by itself, and a chat read again from its start forgets the finger', async () => {
  const { runtime, calls, listeners } = rig([new Error('Your computer is offline.')]);
  const host = await mount(runtime);
  await act(async () => events().onScrollBeginDrag());
  await scrollTo(20);
  await flush();
  assert.match(host.textContent!, /Your computer is offline/);
  await act(async () => events().onScrollBeginDrag());
  await scrollTo(10);
  assert.equal(reads(calls), 1, 'the person decides when to retry');
  // a finger went down, then the chat was read again with rows of its own: that finger asks for nothing in the new snapshot
  await act(async () => events().onScrollBeginDrag());
  const asked: any[] = [];
  runtime.request = async (method: string, p: any) => {
    asked.push([method, p]);
    return method === 'chat.follow'
      ? {
          rev: 2,
          feedSeq: 0,
          historyStale: true,
          session: { turn: 'idle', cards: [] },
          itemsShape: 'rows',
          items: [{ id: 'r20', role: 'user', text: 'fresh start' }],
        }
      : {};
  };
  await act(async () => listeners.current({ kind: 'event', chatId: 'c', ev: 'items.append', feedSeq: 1, live: false, items: [] }));
  await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 500)));
  assert.match(host.textContent!, /fresh start/);
  await scrollTo(10);
  await flush();
  assert.deepEqual(
    asked.filter(([m]) => m === 'chat.read'),
    [['chat.read', { chatId: 'c', before: 'r20', limit: 80 }]],
    'the new snapshot has a row to page from: the earlier failure and the old finger are forgotten, and the page ahead is asked from its own first row',
  );
});

test("pages asked ahead with no finger stop after a few in a row, so a list that does not hold the reader's place cannot run down to the start of the chat; a finger on the list, or the button, starts the count again (#4734)", async () => {
  const more = (n: number) => ({ chatId: 'c', rows: [{ id: `r${n}`, role: 'user', text: `page ${n}` }], more: true });
  const { runtime, calls } = rig([more(9), more(8), more(7), more(6), more(5), more(4), more(3)]);
  await mount(runtime);
  for (let i = 1; i <= 4; i++) {
    await pause(350);
    await scrollTo(100);
    await flush();
    assert.equal(reads(calls), i, `page ${i} ahead of the reader`);
  }
  await pause(350);
  await scrollTo(100);
  await flush();
  assert.equal(reads(calls), 4, 'four pages with no finger: the fifth is for a finger to ask');
  // a fling: the finger lifts with speed and the list runs on to the top
  await act(async () => events().onScrollBeginDrag());
  await scrollTo(5000);
  await act(async () => events().onScrollEndDrag({ nativeEvent: { velocity: { y: -2.5 } } }));
  await pause(350);
  await scrollTo(40);
  await flush();
  assert.equal(reads(calls), 5, 'the momentum of the gesture reaches the top: one page, and the count starts again');
  await act(async () => events().onMomentumScrollEnd());
  await pause(350);
  await scrollTo(100);
  await flush();
  assert.equal(reads(calls), 6, 'ahead again');
  await click('Load earlier messages');
  assert.equal(reads(calls), 7, 'the button asks whatever the count');
});

test('a page ahead also mounts the rows the phone holds but has not mounted, once the reader is within three screens of the top', async () => {
  const { runtime, calls } = rig([]);
  const many = Array.from({ length: 200 }, (_, i) => ({ id: `h${String(i).padStart(3, '0')}`, role: 'user', text: `held ${i}` }));
  const base = runtime.request;
  runtime.request = async (method: string, p: any) =>
    method === 'chat.follow'
      ? { rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: many }
      : base(method, p);
  const host = await mount(runtime);
  assert.doesNotMatch(host.textContent!, /held 0held 1/, 'the oldest held rows are not mounted yet');
  await scrollTo(1700);
  await flush();
  assert.match(host.textContent!, /held 0held 1/, 'mounted ahead of the reader');
  assert.equal(reads(calls), 0, 'and the computer is not asked while rows are held');
});

test('rows paged in above hold their place: they neither fade in nor glide, and the rows already there do not glide to make room (#4734)', async () => {
  const { runtime } = rig([{ chatId: 'c', rows: [{ id: 'r9', role: 'user', text: 'older one' }], more: true }]);
  const host = await mount(runtime);
  const rowsBefore = host.querySelectorAll('[data-layout]').length;
  assert.ok(rowsBefore > 0, 'the rows of the chat make room with a layout transition when something above one changes');
  await click('Load earlier messages');
  assert.match(host.textContent!, /older one/);
  assert.equal(host.querySelectorAll('[data-layout]').length, 0, 'the render that adds the page moves every row by a jump: no glide');
  assert.equal(host.querySelectorAll('[data-entering]').length, 0, 'and the page does not fade in under the reader');
});

test("earlier steps that join a run at the head change the run's own key: the first row is still under it, so the page holds all the same", async () => {
  const { runtime } = rig([
    {
      chatId: 'c',
      rows: [
        { id: 's7', role: 'step', text: 'Ran one' },
        { id: 's8', role: 'step', text: 'Ran two' },
      ],
      more: true,
    },
  ]);
  const follow = runtime.request;
  runtime.request = async (method: string, p: any) =>
    method === 'chat.follow'
      ? {
          ...(await follow(method, p)),
          items: [
            { id: 's9', role: 'step', text: 'Ran three' },
            { id: 's10', role: 'step', text: 'Ran four' },
            { id: 'r11', role: 'assistant', text: 'done' },
          ],
        }
      : follow(method, p);
  const host = await mount(runtime);
  assert.ok(host.querySelectorAll('[data-layout]').length > 0, 'a run at the head and a reply, each with its transition');
  await click('Load earlier messages');
  assert.equal(host.querySelectorAll('[data-layout]').length, 0, 'the run that took in the page and the reply do not glide');
});

test('earlier messages joined above: the block that was first is still there, further down; first paint, the tail, a switch of chat and the same list are not', async () => {
  let out = false;
  const Probe = ({ keys }: { keys: string[] }) => {
    out = usePagedAbove(keys);
    return null;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  const show = (keys: string[]) => act(async () => root.render(createElement(Probe, { keys })));
  await show(['a', 'b']);
  assert.equal(out, false, 'first paint');
  await show(['a', 'b', 'c']);
  assert.equal(out, false, 'a row at the tail');
  await show(['x', 'y', 'a', 'b', 'c']);
  assert.equal(out, true, 'rows above');
  await show(['x', 'y', 'a', 'b', 'c']);
  assert.equal(out, false, 'false again at the next render');
  await show(['p', 'q']);
  assert.equal(out, false, 'another chat: the first block is not further down');
  await show([]);
  assert.equal(out, false, 'an empty list');
});
