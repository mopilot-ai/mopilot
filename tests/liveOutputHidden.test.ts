// Live Bash output (electron/harness/claude/liveOutput.cjs) asks the CLI for nothing while every window is hidden and reads fresh on the first tick after one shows; anyWindowVisible (electron/harness/claude/windowVisibility.cjs) is its source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';

const req = createRequire(import.meta.url);
const { createLiveOutput } = req('../electron/harness/claude/liveOutput.cjs');
const { anyWindowVisible, electronWindows } = req('../electron/harness/claude/windowVisibility.cjs');

test('a hidden window parks the poll; the first tick after it shows reads and forwards fresh output', async () => {
  const fns = new Set<() => void>();
  let shown = false;
  let reads = 0;
  const sent: any[] = [];
  const live = createLiveOutput({
    q: { getTaskOutput: async () => (reads++, { output: `out${reads}` }) },
    emit: (m: any) => sent.push(m),
    visible: () => shown,
    timers: { setInterval: (fn: () => void) => (fns.add(fn), { fn }), clearInterval: (h: any) => void fns.delete(h.fn) },
  });
  live.onMessage({ type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'tu1', task_type: 'local_bash' });
  for (const fn of fns) fn();
  await tick();
  assert.equal(reads, 0);
  shown = true;
  for (const fn of fns) fn();
  await tick();
  assert.equal(reads, 1);
  assert.equal(sent[0].output, 'out1');
});

test('anyWindowVisible: a shown window counts, hidden/minimized/destroyed ones do not, no Electron counts as visible', () => {
  const win = (o: object) => ({ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, ...o });
  const bw = (...w: object[]) => ({ getAllWindows: () => w });
  assert.equal(anyWindowVisible(bw(win({}))), true);
  assert.equal(
    anyWindowVisible(bw(win({ isVisible: () => false }), win({ isMinimized: () => true }), win({ isDestroyed: () => true }))),
    false,
  );
  assert.equal(anyWindowVisible(bw()), false);
  assert.equal(anyWindowVisible({} as any), true);
  assert.equal(typeof anyWindowVisible(), 'boolean');
});

test('electronWindows: the BrowserWindow when Electron loads, undefined when it does not (or is only a path string)', () => {
  const BrowserWindow = {};
  assert.equal(
    electronWindows(() => ({ BrowserWindow })),
    BrowserWindow,
  );
  assert.equal(
    electronWindows(() => '/path/to/electron'),
    undefined,
  );
  assert.equal(
    electronWindows(() => {
      throw new Error('no electron');
    }),
    undefined,
  );
  // the default loader never throws, whether or not Electron is installed here
  assert.doesNotThrow(() => electronWindows());
});
