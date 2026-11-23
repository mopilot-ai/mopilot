// Replay on a turn (src/lib/turnTrace.ts, TurnReplay.tsx): which trace is a turn's, frames and steps on the scrubber, playing, and the button only with the flag and a trace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h, render, settle, native } from './support/thread-view/fixture.ts';

const { MessageActions } = await import('../src/components/thread/view/MessageActions.tsx');
const { ReplayDialog } = await import('../src/components/thread/view/TurnReplay.tsx');
const { traceOfTurn, actionAtFrame, frameOfAction, actionLine, frameUrl } = await import('../src/lib/turnTrace.ts');

const action = (o: any = {}) => ({
  tool: 'browser_navigate',
  args: { url: 'https://shop.test/' },
  at: 1000,
  ms: 50,
  ok: true,
  error: null,
  before: 0,
  after: 1,
  ...o,
});
const trace = (o: any = {}) => ({
  version: 1,
  id: 't1',
  startedAt: 100_500,
  endedAt: 104_000,
  width: 64,
  height: 40,
  frames: [
    { file: 'frames/00001.jpg', at: 1000 },
    { file: 'frames/00002.jpg', at: 2000 },
    { file: 'frames/00003.jpg', at: 3000 },
  ],
  actions: [
    action(),
    action({
      tool: 'browser_computer',
      args: { action: 'left_click', ref: 'ref_1' },
      at: 1900,
      before: 1,
      after: 3,
      ok: false,
      error: 'covered',
    }),
  ],
  droppedActions: 0,
  console: [
    { at: 1500, level: 'error', text: 'boom' },
    { at: 1600, level: 'log', text: 'hi' },
  ],
  requests: 7,
  har: 'network.har',
  dir: '/data/browser-traces/c1/t1',
  ...o,
});

test('a turn’s trace is the latest that started within its time; a running turn has none', () => {
  const a = trace({ id: 'a', startedAt: 100_500 });
  const b = trace({ id: 'b', startedAt: 101_000 });
  const late = trace({ id: 'late', startedAt: 200_000 });
  assert.equal(traceOfTurn([a, b, late], 100, 104)?.id, 'b');
  assert.equal(traceOfTurn([a], 101, 104)?.id, 'a', 'a second of slack: a harness may round the turn’s start up');
  assert.equal(traceOfTurn([a], 102, 104), null, 'one that started well before the turn is not its own');
  assert.equal(traceOfTurn([trace({ id: 'last', startedAt: 104_900 })], 100, 104)?.id, 'last', 'turn times are whole seconds');
  assert.equal(traceOfTurn([late], 100, 104), null);
  assert.equal(traceOfTurn([trace({ endedAt: 110_000 })], 100, 104), null, 'a trace ends with its turn: one that ran on is a later turn’s');
  assert.equal(traceOfTurn([a], 100, null), null);
  assert.equal(traceOfTurn([a], undefined, 104), null);
});

test('a frame shows the step that began before it; a step shows its after frame, or its before one', () => {
  const t = trace();
  assert.equal(actionAtFrame(t, 0), 0);
  assert.equal(actionAtFrame(t, 1), 1);
  assert.equal(actionAtFrame(t, 9), -1, 'no such frame');
  assert.equal(actionAtFrame(trace({ actions: [action({ at: 5000 })] }), 0), -1, 'before the first step');
  assert.equal(frameOfAction(t, 1), 2);
  assert.equal(frameOfAction(trace({ actions: [action({ before: 2, after: 2 })] }), 0), 1, 'nothing new painted: the frame before it');
  assert.equal(frameOfAction(trace({ actions: [action({ before: 0, after: 0 })] }), 0), 0);
  assert.equal(frameOfAction(t, 7), 0);
  assert.equal(frameOfAction(trace({ frames: [] }), 0), 0);
  assert.equal(actionLine(action()), 'Opened shop.test');
  assert.equal(actionLine(action({ tool: 'chrome_navigate' })), 'Opened shop.test');
  assert.equal(frameUrl(t, 1), 'codex-asset:///data/browser-traces/c1/t1/frames/00002.jpg');
  assert.equal(frameUrl(t, 5), null);
});

test('the Replay button shows only with the flag on and a trace for the turn, and opens the trace', async () => {
  const flags: Record<string, boolean> = { 'shared.browser.turnTrace': false };
  native.flags.isEnabled = (k: string) => !!flags[k];
  native.flags.onChanged = () => () => undefined;
  let saved: ((s: any) => void) | null = null;
  native.browser.onTraceSaved = (cb: any) => {
    saved = cb;
    return () => undefined;
  };
  let traces: any[] = [];
  let lists = 0;
  native.browser.turnTraces = async () => (lists++, traces);
  const actions = (threadId = 'c1', startedAt = 100) =>
    h(MessageActions, { text: 'Done', threadId, turnId: 't', startedAt, completedAt: 104 });
  let v = await render(actions());
  assert.equal(v.$('[aria-label="Replay"]'), null, 'flag off');
  await v.unmount();
  assert.equal(lists, 0, 'nothing is read with the flag off');
  flags['shared.browser.turnTrace'] = true;
  v = await render(actions());
  await settle(() => undefined);
  assert.equal(v.$('[aria-label="Replay"]'), null, 'no trace for the turn');
  // another chat's save leaves this one's list alone; this chat's is read again, and the button appears
  const before = lists;
  await settle(() => (saved as any)({ chatId: 'other', id: 'x', startedAt: 1, endedAt: 2 }));
  assert.equal(lists, before);
  traces = [trace()];
  await settle(() => (saved as any)({ chatId: 'c1', id: 't1', startedAt: 100_500, endedAt: 104_000 }));
  await settle(() => undefined);
  const button = v.$('[aria-label="Replay"]') as HTMLButtonElement;
  assert.ok(button);
  await settle(() => button.click());
  assert.ok(v.$('[aria-label="Frame"]'));
  assert.match(String(v.host.textContent), /7 requests · 2 console \(1 errors\)/);
  await settle(() => (v.$('[aria-label="Close"]') as HTMLButtonElement).click());
  assert.equal(v.$('[aria-label="Frame"]'), null);
  await v.unmount();
  // a quick turn whose time overlaps the trace's start but that ended long before it shows none
  v = await render(h(MessageActions, { text: 'hi', threadId: 'c1', turnId: 'q', startedAt: 99, completedAt: 100 }));
  await settle(() => undefined);
  assert.equal(v.$('[aria-label="Replay"]'), null);
  await v.unmount();
  // a list that fails reads as none
  native.browser.turnTraces = async () => {
    throw new Error('ipc');
  };
  v = await render(actions('c2'));
  await settle(() => undefined);
  assert.equal(v.$('[aria-label="Replay"]'), null);
  await v.unmount();
});

test('the dialog scrubs, plays to the end and back, jumps to a step, and marks a failed one', async () => {
  const t = trace();
  const v = await render(h(ReplayDialog, { trace: t, onClose: () => undefined }));
  const range = () => v.$('[aria-label="Frame"]') as HTMLInputElement;
  const img = () => v.$('img') as HTMLImageElement;
  assert.equal(img().getAttribute('src'), frameUrl(t, 0));
  assert.match(String(v.host.textContent), /1\/3/);
  // scrub
  await settle(() => {
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(range()), 'value')?.set;
    set?.call(range(), '2');
    range().dispatchEvent(new (range().ownerDocument.defaultView as any).Event('input', { bubbles: true }));
  });
  assert.match(String(v.host.textContent), /3\/3/);
  // play from the end starts over, and stops at the last frame
  const play = () => v.$('[aria-label="Play"], [aria-label="Pause"]') as HTMLButtonElement;
  await settle(() => play().click());
  assert.equal(play().getAttribute('aria-label'), 'Pause');
  assert.match(String(v.host.textContent), /1\/3/);
  await new Promise((r) => setTimeout(r, 700));
  await settle(() => undefined);
  assert.match(String(v.host.textContent), /3\/3/);
  assert.equal(play().getAttribute('aria-label'), 'Play');
  // pause mid-way
  await settle(() => play().click());
  await settle(() => play().click());
  assert.equal(play().getAttribute('aria-label'), 'Play');
  // a step jumps to its frame; the failed one is marked
  const steps = v.$$('ol button') as HTMLButtonElement[];
  assert.deepEqual(
    steps.map((s) => s.textContent),
    ['Opened shop.test', 'Clicked an element'],
  );
  await settle(() => steps[0].click());
  assert.match(String(v.host.textContent), /1\/3/);
  assert.equal(steps[0].getAttribute('aria-current'), 'step');
  assert.match(steps[1].className, /failed/);
  await v.unmount();
  // a trace with no frames
  const empty = await render(h(ReplayDialog, { trace: trace({ frames: [], console: [], actions: [] }), onClose: () => undefined }));
  assert.match(String(empty.host.textContent), /No frames/);
  assert.match(String(empty.host.textContent), /0\/0/);
  assert.match(String(empty.host.textContent), /7 requests · 0 console$/);
  await empty.unmount();
});
