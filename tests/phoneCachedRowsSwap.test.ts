// A chat that opens on the rows it last showed keeps those views when the Mac answers (#5686): the rows both have are not drawn again, so the one the reader is looking at stays where it is, and no cached row falls out of the list because the Mac's window is shorter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { fakeDraft } from './support/phone/drafts';

const threadPath = '../mobile/src/screens/Thread';
const cachePath = '../mobile/src/presentation/threadCache';
const windowPath = '../mobile/src/remote/useBlockWindow';
const { Thread } = await import(threadPath);
const { rememberRows, forgetRows } = await import(cachePath);
const { WINDOW, useBlockWindow } = await import(windowPath);
const transcriptPath = '../mobile/src/components/TranscriptBlocks';
const { TranscriptBlocks } = await import(transcriptPath);
const blocksPath = '../mobile/src/presentation/cachedBlocks';
const { cachedBlocks } = await import(blocksPath);

const KEY = JSON.stringify(['u', 'p', 'c']);
const id = (n: number) => `r${String(n).padStart(4, '0')}`;
const word = (n: number) => `words-${id(n)}-end`;
/** The row as the cache keeps it, under the key the live transcript knows it by. */
const cached = (n: number) => ({ key: JSON.stringify(['item', id(n)]), role: n % 2 ? 'assistant' : 'user', text: word(n) });
const live = (n: number) => ({ id: id(n), role: n % 2 ? 'assistant' : 'user', text: word(n) });
const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);

/** The element a row's words are drawn in, found by those words. */
const leaf = (host: HTMLElement, n: number) =>
  [...host.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent === word(n)) ?? null;

async function open(first: number[], answer: number[]) {
  forgetRows();
  rememberRows(KEY, first.map(cached));
  let release: (v: unknown) => void = () => {};
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: () => () => {},
    request: (method: string) => {
      if (method === 'chat.follow')
        return new Promise((resolve) => {
          release = () =>
            resolve({ rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: answer.map(live) });
        });
      return Promise.resolve(method === 'chat.read' ? { chatId: 'c', rows: [], more: false } : {});
    },
  };
  withOutbox(runtime);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft(''), historyKey: KEY, offline: false })),
  );
  await flush();
  return {
    host,
    answer: async () => {
      await act(async () => release(null));
      await flush();
    },
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('the rows the chat last showed and the Mac’s rows are one list: a row both have is the same view after the Mac answers', async () => {
  const t = await open(range(0, 6), range(0, 6));
  const before = range(0, 6).map((n) => leaf(t.host, n));
  assert.ok(
    before.every((e) => e),
    'the cached rows are on screen before the Mac answers',
  );
  await t.answer();
  range(0, 6).forEach((n, i) => assert.equal(leaf(t.host, n), before[i], `row ${n} was not drawn again`));
  await t.done();
});

/** The window over the blocks the chat shows, as the screen drives it: `hold` while the rows are the cached ones. */
async function windowOver(first: { blocks: any[]; hold: boolean }) {
  const out: { shown: any[]; hidden: number } = { shown: [], hidden: 0 };
  const Probe = ({ blocks, hold }: { blocks: any[]; hold: boolean }) => {
    const w = useBlockWindow(blocks, 'c', hold);
    out.shown = w.shown;
    out.hidden = w.hidden;
    return null;
  };
  const root = createRoot(document.createElement('div'));
  const render = (next: { blocks: any[]; hold: boolean }) => act(async () => root.render(createElement(Probe, next)));
  await render(first);
  return { out, render, done: () => act(async () => root.unmount()) };
}
const blocksOf = (rows: number[]) => cachedBlocks(rows.map((n) => ({ ...live(n), key: cached(n).key })));

test('the window over the cached rows shows them all, and the Mac’s rows then start at the same first row, so none a reader may be looking at falls out of the list', async () => {
  // more rows were cached than the window mounts (the saved older rows above the first paint)
  const rows = range(0, WINDOW + 30);
  const w = await windowOver({ blocks: blocksOf(rows), hold: true });
  assert.equal(w.out.shown.length, WINDOW + 30);
  assert.equal(w.out.hidden, 0);
  // the Mac answers with the same rows and a few newer: the window starts where it started
  await w.render({ blocks: blocksOf(range(0, WINDOW + 35)), hold: false });
  assert.equal(w.out.hidden, 0, 'nothing above the first cached row, and it is still the first');
  assert.equal(w.out.shown.length, WINDOW + 35);
  // another chat's rows: the window starts at their newest, as it always did
  await w.render({ blocks: blocksOf(range(1000, WINDOW + 40)), hold: false });
  assert.equal(w.out.hidden, 40);
  await w.done();
});

test('with nothing cached the window holds nothing', async () => {
  const w = await windowOver({ blocks: [], hold: true });
  assert.equal(w.out.shown.length, 0);
  await w.done();
});

test('when the Mac’s rows are not the cached ones, they replace them, and the window starts at the newest as before', async () => {
  const t = await open(range(0, 10), range(500, WINDOW + 20));
  assert.ok(leaf(t.host, 0));
  await t.answer();
  assert.equal(leaf(t.host, 0), null, 'a cached row the Mac does not have is gone');
  assert.ok(leaf(t.host, 500 + WINDOW + 19), 'the Mac’s newest row');
  assert.equal(leaf(t.host, 500), null, 'older than its window: held back, as before');
  await t.done();
});

// --- the review of the first version: animation, a vanished first row, saved runs, rows that differ, and the pin ---

const step = (n: number, text: string) => ({ id: `s${n}`, role: 'step', text });
const savedStep = (n: number, summary: string) => ({ key: `run:${JSON.stringify(['item', `s${n}`])}`, role: 'step', text: summary });
/** Opens with saved rows given as they are cached and the Mac's answer as its items. */
async function openWith(saved: object[], answer: object[]) {
  forgetRows();
  rememberRows(KEY, saved);
  let release: (v: unknown) => void = () => {};
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: () => () => {},
    request: (method: string) => {
      if (method === 'chat.follow')
        return new Promise((resolve) => {
          release = () => resolve({ rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: answer });
        });
      return Promise.resolve(method === 'chat.read' ? { chatId: 'c', rows: [], more: false } : {});
    },
  };
  withOutbox(runtime);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft(''), historyKey: KEY, offline: false })),
  );
  await flush();
  return {
    host,
    answer: async () => {
      await act(async () => release(null));
      await flush();
    },
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

/** What the rows removed from the list had set to play as they left. */
function watchLeaving(host: HTMLElement) {
  const exits: (string | null)[] = [];
  const watcher = new MutationObserver((records) =>
    records.forEach((r) =>
      r.removedNodes.forEach((n) => {
        if (n instanceof HTMLElement) n.querySelectorAll('[data-exiting]').forEach((e) => exits.push(e.getAttribute('data-exiting')));
      }),
    ),
  );
  watcher.observe(host, { childList: true, subtree: true });
  return { exits, stop: () => watcher.disconnect() };
}
const entering = (host: HTMLElement) => host.querySelectorAll('[data-mounted-entering]').length;

test('nothing animates while the saved rows show, in the commit the Mac’s rows replace them (rows that arrive, rows that go), or when a chat with nothing saved first fills', async () => {
  // saved 0..5; the Mac has 0, 1, 2, 3, 5 and 20..22 (4 is gone, three are new)
  const t = await openWith(range(0, 6).map(cached), [0, 1, 2, 3, 5, 20, 21, 22].map(live));
  assert.ok(leaf(t.host, 0));
  assert.equal(entering(t.host), 0, 'the saved rows do not fade in');
  const watch = watchLeaving(t.host);
  await t.answer();
  assert.ok(leaf(t.host, 22));
  assert.equal(entering(t.host), 0, 'the rows the Mac added in the swap do not fade in');
  assert.equal(leaf(t.host, 4), null);
  assert.deepEqual(
    watch.exits.filter((e) => e),
    [],
    'the row that went does not fade out',
  );
  watch.stop();
  await t.done();

  // a chat with nothing saved: the Mac's rows are the first paint
  const none = await openWith([], range(0, 6).map(live));
  assert.equal(leaf(none.host, 0), null);
  await none.answer();
  assert.ok(leaf(none.host, 5));
  assert.equal(entering(none.host), 0, 'the first fill of a chat opened with nothing saved does not animate');
  await none.done();
});

test('a row that arrives once the chat is live still fades in, and saved rows are never the live ones', async () => {
  const request: any = async () => ({});
  const mountBlocks = async (phase: 'saved' | 'arriving' | 'live', rows: number[]) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const draw = (list: number[]) =>
      act(async () =>
        root.render(
          createElement(TranscriptBlocks, {
            blocks: cachedBlocks(list.map((n) => ({ ...live(n), key: cached(n).key }))),
            streamingKey: null,
            phase,
            request,
            chatId: 'c',
          }),
        ),
      );
    await draw(rows);
    return { host, draw, done: () => act(async () => root.unmount()) };
  };
  const live2 = await mountBlocks('live', [0, 1]);
  await live2.draw([0, 1, 2]);
  const fades = [...live2.host.querySelectorAll('[data-mounted-entering]')].map((e) => e.getAttribute('data-mounted-entering'));
  assert.deepEqual(fades, ['FadeIn'], 'only the assistant row that arrived: your own and the first paint do not');
  await live2.done();
  const arriving = await mountBlocks('arriving', [0, 1]);
  await arriving.draw([0, 1, 2]);
  assert.equal(entering(arriving.host), 0);
  await arriving.done();
});

test('a saved run is the same view as the Mac’s run: not mounted again, and its place in the list is kept', async () => {
  const summary = 'Read 2 files';
  const saved = [cached(0), savedStep(1, summary), cached(2)];
  const answer = [live(0), step(1, 'Read a.ts'), step(2, 'Read b.ts'), live(2)];
  const t = await openWith(saved, answer);
  const label = () => t.host.querySelector(`[aria-label="${summary}"]`);
  const run = label();
  assert.ok(run, 'the saved run is drawn as a run');
  const first = leaf(t.host, 0);
  await t.answer();
  assert.equal(label(), run, 'the same view of the run');
  assert.equal(leaf(t.host, 0), first, 'and of the row above it');
  await t.done();
});

test('the Mac has a row the saved rows lack and lacks one they have: the rows both have are the same views', async () => {
  const t = await openWith([0, 1, 2, 3, 4, 5].map(cached), [0, 1, 20, 2, 3, 5].map(live));
  const kept = [0, 1, 2, 3, 5].map((n) => leaf(t.host, n));
  assert.ok(kept.every((e) => e));
  await t.answer();
  [0, 1, 2, 3, 5].forEach((n, i) => assert.equal(leaf(t.host, n), kept[i], `row ${n}`));
  assert.equal(leaf(t.host, 4), null, 'the row the Mac does not have is gone');
  assert.ok(leaf(t.host, 20), 'the row it added is there');
  await t.done();
});

test('saved rows do not report where your newest message is, so a send while the Mac is away pins nothing to one', async () => {
  (globalThis as any).__phoneOnLayout = undefined;
  const t = await openWith([cached(0), cached(1)], range(0, 2).map(live));
  assert.ok(leaf(t.host, 0));
  assert.equal((globalThis as any).__phoneOnLayout, undefined, 'no row of the saved list asks to be measured for the pin');
  await t.answer();
  assert.ok((globalThis as any).__phoneOnLayout, 'the Mac’s own rows do');
  await t.done();
});

test('the window starts at the first saved row the Mac still has, walking past the ones it does not, and is not held open again once the Mac has answered', async () => {
  const optimistic = { type: 'row', row: { key: 'sent:1', role: 'user', text: 'waiting', optimistic: true } };
  const w = await windowOver({ blocks: [optimistic, ...blocksOf(range(0, WINDOW + 30))], hold: true });
  assert.equal(w.out.shown.length, WINDOW + 31);
  // the first three saved rows are gone from the Mac's answer (a compaction, a re-key); the send is no longer waiting
  await w.render({ blocks: blocksOf(range(3, WINDOW + 40)), hold: false });
  assert.equal(w.out.hidden, 0, 'it starts at row 3, the first saved row the Mac has');
  assert.equal(w.out.shown.length, WINDOW + 40);
  // a chat that has shown the Mac's rows is not drawn from saved ones again: holding again keeps the window it had
  await w.render({ blocks: blocksOf(range(3, WINDOW + 41)), hold: true });
  assert.equal(w.out.hidden, 0);
  assert.equal(w.out.shown.length, WINDOW + 41);
  await w.done();
});

test('no saved row is among the Mac’s: the window starts at the newest, as it always did', async () => {
  const w = await windowOver({ blocks: blocksOf(range(0, 20)), hold: true });
  await w.render({ blocks: blocksOf(range(1000, WINDOW + 40)), hold: false });
  assert.equal(w.out.hidden, 40);
  await w.done();
});
