// The chat's turn line, folded tool runs and Changes chip as the person sees them in the followed chat.
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
import { fakeDraft } from './support/phone/drafts';
/** Assert the actual accessible status line, independently of controls elsewhere in the screen. */
const workingLine = (host: HTMLElement, words: string) => {
  const line = host.querySelector(`[aria-label="${words}"]`);
  assert.ok(line, `working line ${words}`);
  assert.equal(line.textContent, words);
};
const threadPath = '../mobile/src/screens/Thread';
const { Thread } = await import(threadPath);
const feedPath = '../mobile/src/presentation/followFeed';
const { FRAME_MS } = await import(feedPath);

/** The timer before any test fakes it. */
const realSetTimeout = globalThis.setTimeout;
const mounted: { root: any; host: HTMLElement }[] = [];
afterEach(async () => {
  mock.timers.reset();
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.host.remove();
  }
});

type Rig = ReturnType<typeof scripted> & { host: HTMLElement; emit: (e: any) => Promise<void>; render: (props?: any) => Promise<void> };
async function mount(follow: any, handler: (m: string, p: any) => unknown = () => undefined, props: any = {}): Promise<Rig> {
  const rig = scripted((m, p) => (m === 'chat.follow' ? follow : handler(m, p)));
  // the app's runtime keeps every listener, and the screen and the chip's refresh each add one
  const listeners = new Set<(e: any) => void>();
  rig.runtime.onEvent = (f: any) => (listeners.add(f), () => listeners.delete(f));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  const render = async (more: any = {}) =>
    act(async () =>
      root.render(
        createElement(Thread, {
          runtime: rig.runtime,
          chatId: 'c',
          back: () => {},
          drafts: fakeDraft(''),
          ...props,
          ...more,
        }),
      ),
    );
  await render();
  await flush();
  // an event is shown at once when the feed was quiet and with the ones right after it when the 16 ms frame window ends: the test waits that out, so each emit is on screen when it returns
  const frame = async () => {
    // a test that fakes the clock's timers moves the window with it; one that does not waits it out for real
    try {
      mock.timers.tick(FRAME_MS + 4);
    } catch {
      // timers are not faked here
    }
    await new Promise((resolve) => realSetTimeout(resolve, FRAME_MS + 4));
  };
  return {
    ...rig,
    host,
    render,
    emit: (e) =>
      act(async () => {
        listeners.forEach((l) => l({ kind: 'event', chatId: 'c', ...e }));
        await frame();
      }),
  };
}
const text = (host: HTMLElement) => host.textContent!;
const button = (host: HTMLElement, label: RegExp) =>
  [...host.querySelectorAll('button[role="button"]')].find((b) => label.test(b.getAttribute('aria-label') ?? ''));
const press = async (b: Element | undefined) => {
  assert.ok(b, 'a button to press');
  await act(async () => (b as HTMLElement).click());
};
const history = [
  { role: 'user', text: 'Clean up the build output' },
  { role: 'step', text: 'Read /repo/a.ts' },
  { role: 'step', text: 'Read /repo/b.ts' },
  { role: 'step', text: 'Ran npm test' },
  { role: 'assistant', text: 'All clean.' },
];
const idle = { rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: history };

test('saved steps of a finished turn fold into runs, a tap opens one and the turn line folds them all', async () => {
  const { host } = await mount(idle);
  // three steps of two kinds read as one line; the single reply stays a message
  assert.ok(button(host, /^Read 2 files, ran 1 command$/));
  assert.match(text(host), /All clean\./);
  assert.doesNotMatch(text(host), /Read \/repo\/a\.ts/);
  // the phone did not see this turn run, so it says no time
  assert.match(text(host), /Worked/);
  assert.doesNotMatch(text(host), /Worked for/);
  await press(button(host, /^Read 2 files/));
  assert.match(text(host), /Read \/repo\/a\.ts/);
  assert.match(text(host), /Ran npm test/);
  assert.equal(button(host, /^Read 2 files/)!.getAttribute('aria-expanded'), 'true');
  await press(button(host, /^Read 2 files/));
  assert.doesNotMatch(text(host), /Read \/repo\/a\.ts/);
  // folding the turn hides its steps and the toggle says how to bring them back
  await press(button(host, /^Worked, hide the steps$/));
  assert.equal(button(host, /^Read 2 files/), undefined);
  assert.match(text(host), /All clean\./);
  assert.match(text(host), /Clean up the build output/);
  await press(button(host, /^Worked, show the steps$/));
  assert.ok(button(host, /^Read 2 files/));
});

test('a chat opened mid-turn names the running step, thinks between steps, and a turn the phone saw is timed', async () => {
  mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_000_000 });
  const { host, emit } = await mount({
    rev: 1,
    feedSeq: 0,
    session: { turn: 'running', cards: [] },
    itemsShape: 'items',
    history: [{ role: 'user', text: 'Go' }],
    liveTurn: { id: 't1', status: 'running' },
    items: [
      { id: 'a', type: 'commandExecution', command: 'Read /a', commandActions: [{ type: 'read' }], durationMs: 1000 },
      { id: 'b', type: 'commandExecution', command: 'Read /b', commandActions: [{ type: 'read' }], durationMs: 1500 },
    ],
  });
  assert.ok(button(host, /^Read 2 files$/), 'the run at the end of a running turn is live, in the past tense');
  workingLine(host, 'Reading files');
  assert.equal(button(host, /hide the steps|show the steps/), undefined, 'a running turn cannot be folded');
  // the turn ends: the phone did not see it start, so it has no time to give
  await emit({ ev: 'session.patch', rev: 2, patch: { turn: 'idle' } });
  assert.ok(button(host, /^Read 2 files$/), 'a finished run says the same, with no time on the row');
  assert.match(text(host), /Worked/);
  assert.doesNotMatch(text(host), /Worked \d/);
  // the next turn starts while the phone watches, with your message at the end: it thinks, longer and longer
  await emit({
    ev: 'items.append',
    feedSeq: 1,
    live: true,
    items: [{ id: 'u2', type: 'userMessage', content: [{ type: 'text', text: 'More' }] }],
  });
  await emit({ ev: 'session.patch', rev: 3, patch: { turn: 'running' } });
  workingLine(host, 'Thinking…');
  await act(async () => mock.timers.tick(6_000));
  workingLine(host, 'Thinking more…');
  await act(async () => mock.timers.tick(9_000));
  workingLine(host, 'Thinking some more…');
  await act(async () => mock.timers.tick(25_000));
  workingLine(host, 'Still thinking…');
  // the reply being written needs no words: only the spark, read out as responding
  await emit({ ev: 'items.append', feedSeq: 2, live: true, items: [{ id: 'r', type: 'agentMessage', text: 'Done.' }] });
  assert.ok(host.querySelector('[aria-label="Responding"]'));
  await act(async () => mock.timers.tick(28_000));
  await emit({ ev: 'session.patch', rev: 4, patch: { turn: 'idle' } });
  assert.match(text(host), /Worked 1m 8s/);
  assert.equal(button(host, /the steps$/), undefined, 'a turn that left no steps has nothing to fold');
});

test('a finished turn copies its reply and retries your last message', async () => {
  const rig = await mount(idle);
  await press(button(rig.host, /^Copy reply$/));
  await flush();
  assert.equal((globalThis as any).__clipboard, 'All clean.');
  assert.ok(((globalThis as any).__haptics ?? []).includes('selection'), 'a copy ticks');
  // a refused copy stays quiet
  (globalThis as any).__clipboardFails = true;
  await press(button(rig.host, /^Copy reply$/));
  await flush();
  assert.equal((globalThis as any).__clipboardFails, false);
  const sent: unknown[][] = [];
  const queue = rig.runtime.send;
  rig.runtime.send = (...args: unknown[]) => (sent.push(args), queue(...args));
  await press(button(rig.host, /^Retry$/));
  assert.deepEqual(sent, [['c', 'Clean up the build output', [], []]]);
});

test('a retry the phone cannot queue shows why', async () => {
  const rig = await mount(idle);
  rig.runtime.send = () => {
    throw new Error('The outbox is full.');
  };
  await press(button(rig.host, /^Retry$/));
  assert.match(text(rig.host), /The outbox is full\./);
  rig.runtime.send = () => {
    throw 'plain';
  };
  await press(button(rig.host, /^Retry$/));
  assert.match(text(rig.host), /plain/);
});

test('a turn without a reply or your message offers neither copy nor retry', async () => {
  const { host } = await mount({
    ...idle,
    items: [
      { role: 'step', text: 'Ran ls' },
      { role: 'step', text: 'Ran pwd' },
    ],
  });
  assert.equal(button(host, /^Copy reply$/), undefined);
  assert.equal(button(host, /^Retry$/), undefined);
});

test('a turn waiting for you is announced and a new message shows the steps again', async () => {
  const { host, emit } = await mount(idle);
  await press(button(host, /hide the steps/));
  assert.equal(button(host, /^Read 2 files/), undefined);
  // your next message starts a new turn: its steps are not folded
  await emit({
    ev: 'items.append',
    feedSeq: 1,
    live: true,
    items: [
      { id: 'u2', type: 'userMessage', content: [{ type: 'text', text: 'Again' }] },
      { id: 's1', type: 'commandExecution', command: 'ls', commandActions: [] },
      { id: 's2', type: 'commandExecution', command: 'pwd', commandActions: [] },
    ],
  });
  assert.ok(button(host, /^Ran 2 commands$/));
  await emit({ ev: 'session.patch', rev: 2, patch: { turn: 'awaitingUser' } });
  assert.match(text(host), /Waiting for you/);
  assert.equal(host.querySelector('[aria-live="polite"] [aria-label]')?.getAttribute('aria-label'), 'Waiting for you');
  await emit({ ev: 'session.patch', rev: 3, patch: { turn: 'running' } });
  assert.equal(host.querySelector('[aria-live="polite"]'), null, 'a running clock is not read out every second');
});

test('an empty chat has no turn line, and a turn without steps has none until it has run', async () => {
  const { host } = await mount({
    ...idle,
    items: [
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Hello' },
    ],
  });
  assert.doesNotMatch(text(host), /Worked/);
  assert.equal(button(host, /the steps/), undefined);
});

const files = (...counts: [number, number][]) => ({
  files: counts.map(([added, removed], i) => ({ path: `f${i}.ts`, status: 'modified', binary: false, added, removed })),
  total: counts.length,
});

test('a finished turn offers one Changes chip with the lines changed, which opens the Changes screen', async () => {
  let opened = 0;
  const { host, emit, calls } = await mount(idle, (m) => (m === 'diff.list' ? files([3, 1], [1, 1]) : undefined), {
    review: () => opened++,
  });
  const chip = button(host, /^Changes, 4 added, 2 removed$/);
  assert.match(chip!.textContent!, /Changes\+4 −2/);
  assert.deepEqual(calls.find(([m]) => m === 'diff.list')![1], { chatId: 'c', scope: 'uncommitted' });
  await press(chip);
  assert.equal(opened, 1);
  // the chip goes while a turn runs and the Mac is not asked about every edit
  const reads = () => calls.filter(([m]) => m === 'diff.list').length;
  await emit({ ev: 'session.patch', rev: 2, patch: { turn: 'running' } });
  assert.equal(button(host, /^Changes/), undefined);
  const before = reads();
  await emit({ ev: 'session.patch', rev: 3, patch: { turn: 'idle' } });
  await flush();
  assert.equal(reads(), before + 1, 'the end of the turn reads the changes again');
  assert.ok(button(host, /^Changes, 4 added, 2 removed$/));
});

test('the Changes chip names only what changed, and is absent without changes, a review screen or an answer', async () => {
  const only = async (reply: any, props: any = { review: () => {} }) =>
    (await mount(idle, (m) => (m === 'diff.list' ? reply : undefined), props)).host;
  assert.ok(button(await only(files([2, 0])), /^Changes, 2 added$/));
  assert.ok(button(await only(files([0, 5])), /^Changes, 5 removed$/));
  assert.ok(button(await only(files([0, 0])), /^Changes$/), 'a renamed or binary file changed lines it cannot count');
  assert.equal(button(await only(files()), /^Changes/), undefined, 'no changed files');
  assert.equal(button(await only(files([1, 1]), {}), /^Changes/), undefined, 'where the app offers no review');
  assert.equal(button(await only({ nope: true }), /^Changes/), undefined, 'a malformed answer');
  const refused = await mount(
    idle,
    (m) => {
      if (m === 'diff.list') throw new Error('offline');
      if (m === 'machine.hello') throw new Error('no hello');
      return undefined;
    },
    { review: () => {} },
  );
  assert.equal(button(refused.host, /^Changes/), undefined, 'a Mac that cannot say adds no chip and no error');
  assert.doesNotMatch(text(refused.host), /offline/);
});

test('counts read for another chat never show in this one', async () => {
  let release: (v: unknown) => void = () => {};
  const handler = (m: string, p: any) => {
    if (m !== 'diff.list') return undefined;
    return p.chatId === 'c' ? files([1, 1]) : new Promise((r) => (release = r));
  };
  const { host, render } = await mount(idle, handler, { review: () => {} });
  assert.ok(button(host, /^Changes, 1 added, 1 removed$/));
  await render({ chatId: 'd' });
  await flush();
  assert.equal(button(host, /^Changes/), undefined, 'chat d has not been read yet');
  await act(async () => release(files([7, 0])));
  await flush();
  assert.ok(button(host, /^Changes, 7 added$/));
});

test('a read that returns after the chat changed is dropped', async () => {
  const slow: Record<string, (v: unknown) => void> = {};
  const handler = (m: string, p: any) => (m === 'diff.list' ? new Promise((r) => (slow[p.chatId] = r)) : undefined);
  const { host, render } = await mount(idle, handler, { review: () => {} });
  await render({ chatId: 'd' });
  await flush();
  await act(async () => slow.c(files([9, 9])));
  await flush();
  assert.equal(button(host, /^Changes/), undefined, 'the old chat answered late');
  await act(async () => slow.d(files([1, 0])));
  await flush();
  assert.ok(button(host, /^Changes, 1 added$/));
});

test("the chip never shows the last turn's counts while the next turn is read, and says only files when the list was cut short", async () => {
  let release: (v: unknown) => void = () => {};
  let reads = 0;
  const { host, emit } = await mount(
    idle,
    (m) => {
      if (m !== 'diff.list') return undefined;
      return ++reads === 1 ? files([3, 1]) : new Promise((r) => (release = r));
    },
    { review: () => {} },
  );
  assert.ok(button(host, /^Changes, 3 added, 1 removed$/));
  await emit({ ev: 'session.patch', rev: 2, patch: { turn: 'running' } });
  await emit({ ev: 'session.patch', rev: 3, patch: { turn: 'idle' } });
  assert.equal(button(host, /^Changes/), undefined, 'the old counts are gone until the new read lands');
  await act(async () => release({ ...files([10, 0]), omitted: 5 }));
  await flush();
  assert.ok(button(host, /^Changes$/), 'a list cut short has no honest line total');
});

test('the live reply keeps its row while it streams, so words reveal in place as they arrive', async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 2_000_000 });
  const { host, emit } = await mount({
    rev: 1,
    feedSeq: 0,
    session: { turn: 'running', cards: [] },
    itemsShape: 'items',
    history: [{ role: 'user', text: 'Go' }],
    liveTurn: { id: 't1', status: 'running' },
    items: [{ id: 'r', type: 'agentMessage', text: 'Intro.' }],
  });
  assert.match(text(host), /Intro\./);
  await emit({ ev: 'items.delta', feedSeq: 1, itemId: 'r', field: 'text', text: '\n\nThe second block is half' });
  for (let i = 0; i < 20; i++) await act(async () => mock.timers.tick(50));
  assert.match(text(host), /second block/, 'words reveal as they arrive, without waiting for the block to finish');
  await emit({ ev: 'items.delta', feedSeq: 2, itemId: 'r', field: 'text', text: ' done.\n\nThird' });
  for (let i = 0; i < 20; i++) await act(async () => mock.timers.tick(50));
  assert.match(text(host), /The second block is half done\./);
});

test('a reply followed by a question for you is finished: it shows whole while the turn waits', async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 3_000_000 });
  const { host, emit } = await mount({
    rev: 1,
    feedSeq: 0,
    session: { turn: 'running', cards: [] },
    itemsShape: 'items',
    history: [{ role: 'user', text: 'Go' }],
    liveTurn: { id: 't1', status: 'running' },
    items: [{ id: 'r', type: 'agentMessage', text: "I'll" }],
  });
  await emit({ ev: 'items.delta', feedSeq: 1, itemId: 'r', field: 'text', text: ' check the repository first.' });
  for (let i = 0; i < 5; i++) await act(async () => mock.timers.tick(50));
  assert.doesNotMatch(text(host), /repository first/, 'still being written');
  await emit({ ev: 'session.patch', rev: 2, patch: { turn: 'awaitingUser' } });
  for (let i = 0; i < 10; i++) await act(async () => mock.timers.tick(50));
  assert.match(text(host), /I'll check the repository first\./);
});
