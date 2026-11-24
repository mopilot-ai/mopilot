// The window's side of the always-on renderer record (src/session/rendererRecord.ts, #5398 #5402): long tasks and slow input events become content-free lines about where the window was, a component's notes go the same way, and a minute holds at most twenty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import {
  installRendererRecord,
  LINES_PER_MINUTE,
  LONG_TASK_MS,
  SLOW_INPUT_GROUP_MS,
  SLOW_INPUT_MS,
} from '../src/session/rendererRecord.ts';
import { noteRenderer } from '../src/lib/rendererNote.ts';

type Rec = { cb: (l: { getEntries(): unknown[] }) => void; disconnected: boolean };
function fakeWindow(now = { ms: 0 }) {
  const made: Rec[] = [];
  class Observer {
    static supportedEntryTypes = ['longtask', 'event'];
    rec: Rec;
    constructor(cb: Rec['cb']) {
      this.rec = { cb, disconnected: false };
      made.push(this.rec);
    }
    observe() {}
    disconnect() {
      this.rec.disconnected = true;
    }
  }
  const doc = window.document;
  doc.body.innerHTML = '<div data-sidebar-chat="a"></div><div data-sidebar-chat="b"></div><div class="user-message"></div>';
  const win = { PerformanceObserver: Observer, performance: { now: () => now.ms }, document: doc } as any;
  return { win, made, now };
}
const deliver = (rec: Rec, ...entries: unknown[]) => rec.cb({ getEntries: () => entries });

test('a long task and a slow input event become lines with where the window was, and nothing under their thresholds does', () => {
  const lines: any[] = [];
  const { win, made } = fakeWindow();
  const stop = installRendererRecord(
    { perf: { record: (l) => void lines.push(l) } },
    { getState: () => ({ route: { name: 'thread' } }) },
    win,
  );
  const [tasks, events] = made;
  deliver(tasks, { duration: LONG_TASK_MS - 1 }, { duration: 351.4 });
  deliver(events, { name: 'keydown', duration: SLOW_INPUT_MS - 1, startTime: 0, processingStart: 5, processingEnd: 9 });
  deliver(events, { name: 'keydown', duration: 400, startTime: 100, processingStart: 340, processingEnd: 360 });
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], {
    what: 'longtask',
    ms: 351,
    route: 'thread',
    rows: 2,
    messages: 1,
    focused: lines[0].focused,
    visible: lines[0].visible,
  });
  assert.deepEqual(
    { what: lines[1].what, name: lines[1].name, ms: lines[1].ms, delay: lines[1].delay, processing: lines[1].processing },
    { what: 'slowInput', name: 'keydown', ms: 400, delay: 240, processing: 20 },
  );
  assert.equal(typeof lines[1].focused, 'boolean');
  stop();
  assert.ok(made.every((r) => r.disconnected));
});

test('what a component notes goes the same way, until the record stops', () => {
  const lines: any[] = [];
  const { win } = fakeWindow();
  const stop = installRendererRecord({ perf: { record: (l) => void lines.push(l) } }, { getState: () => ({}) }, win);
  noteRenderer({ what: 'composerRefused', inputType: 'insertText', count: 3, why: 'preparing' });
  assert.equal(lines[0].what, 'composerRefused');
  assert.equal(lines[0].why, 'preparing');
  assert.equal(lines[0].route, undefined, 'a window with no route says none');
  stop();
  noteRenderer({ what: 'composerRefused', count: 1 });
  assert.equal(lines.length, 1);
});

test('a window sends at most twenty lines a minute', () => {
  const lines: any[] = [];
  const { win, now } = fakeWindow();
  installRendererRecord({ perf: { record: (l) => void lines.push(l) } }, { getState: () => ({}) }, win);
  for (let i = 0; i < LINES_PER_MINUTE + 5; i++) noteRenderer({ what: 'longtask', ms: 300 });
  assert.equal(lines.length, LINES_PER_MINUTE);
  now.ms = 61_000;
  noteRenderer({ what: 'longtask', ms: 300 });
  assert.equal(lines.length, LINES_PER_MINUTE + 1);
});

test('a window without the observers still takes notes', () => {
  const lines: any[] = [];
  const win = { performance: { now: () => 0 }, document: window.document } as any;
  const stop = installRendererRecord({ perf: { record: (l) => void lines.push(l) } }, { getState: () => ({}) }, win);
  noteRenderer({ what: 'composerComposition', ms: 3000 });
  assert.equal(lines.length, 1);
  stop();
});

test('the slow input events one long task delays are one line a second, with how many they stand for', () => {
  const lines: any[] = [];
  const { win, made, now } = fakeWindow();
  installRendererRecord({ perf: { record: (l) => void lines.push(l) } }, { getState: () => ({}) }, win);
  const slow = (name: string) => ({ name, duration: 900, startTime: 0, processingStart: 800, processingEnd: 801 });
  deliver(made[1], slow('pointerover'), slow('pointerenter'), slow('pointerenter'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].count, undefined, 'the first stands for itself');
  now.ms = SLOW_INPUT_GROUP_MS + 1;
  deliver(made[1], slow('keydown'));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].count, 3, 'and the next says it stands for itself and the two folded into it');
  now.ms += SLOW_INPUT_GROUP_MS + 1;
  deliver(made[1], slow('keydown'));
  assert.equal(lines[2].count, undefined);
});
