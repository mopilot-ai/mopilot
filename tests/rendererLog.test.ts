// The always-on renderer record in main (electron/perf/rendererLog.cjs, #5398 #5402): a window's lines are kept only as known kinds, numbers and short words, a minute holds at most thirty per window, and nothing is written before it starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { PER_MINUTE, ROUTES, forgetRendererWindow, recordRenderer, startRendererLog } = require('../electron/perf/rendererLog.cjs');
const { register } = require('../electron/app/ipc/perf.cjs');

function rig(start = true) {
  let at = 1_000_000;
  const lines: any[] = [];
  if (start) startRendererLog({ dir: '/unused', log: { append: (l: string) => void lines.push(JSON.parse(l)) }, now: () => at });
  return { lines, tick: (ms: number) => (at += ms) };
}

test('nothing is kept before the record starts', () => {
  const r = rig(false);
  assert.equal(recordRenderer(1, { what: 'longtask', ms: 300 }), false);
  startRendererLog({ dir: '/unused', log: { append: () => assert.fail('written') } });
  assert.equal(recordRenderer(1, null), false);
  assert.deepEqual(r.lines, []);
});

test('a known kind keeps its numbers and short words, and drops text, ids, paths and anything unknown', () => {
  const r = rig();
  assert.equal(
    recordRenderer(7, {
      what: 'slowInput',
      name: 'keydown',
      ms: 312.6,
      delay: 200,
      processing: 40,
      rows: 155,
      messages: 9,
      route: 'thread',
      inputType: 'insertText',
      why: 'starting',
      focused: true,
      visible: false,
      text: 'my secret draft',
      path: '/Users/me/project',
      id: 'claude:1234',
    }),
    true,
  );
  assert.deepEqual(r.lines[0], {
    t: 1_000_000,
    kind: 'renderer',
    window: 7,
    what: 'slowInput',
    ms: 313,
    delay: 200,
    processing: 40,
    rows: 155,
    messages: 9,
    name: 'keydown',
    route: 'thread',
    inputType: 'insertText',
    why: 'starting',
    focused: true,
    visible: false,
  });
  for (const hostile of [
    { what: 'sendKeys' },
    {
      what: 'longtask',
      route: 'has a space and /slashes',
      name: 'x'.repeat(80),
      inputType: 'insert text',
      why: 'because',
      ms: -5,
      rows: Number.NaN,
      count: '3',
    },
    'longtask',
    [],
  ]) {
    const before = r.lines.length;
    recordRenderer(7, hostile);
    if (r.lines.length > before) assert.deepEqual(Object.keys(r.lines.at(-1)).sort(), ['kind', 't', 'what', 'window']);
  }
  assert.equal(recordRenderer(7, { what: 'longtask', ms: 5e9 }), true);
  assert.equal(r.lines.at(-1).ms, 10_000_000, 'a number is capped');
});

test('a window may add thirty lines a minute; the next minute starts afresh and says how many it lost', () => {
  const r = rig();
  for (let i = 0; i < PER_MINUTE; i++) assert.equal(recordRenderer(1, { what: 'longtask', ms: 250 }), true);
  assert.equal(recordRenderer(1, { what: 'longtask', ms: 250 }), false);
  assert.equal(recordRenderer(1, { what: 'longtask', ms: 250 }), false);
  assert.equal(recordRenderer(2, { what: 'longtask', ms: 250 }), true, 'another window has its own allowance');
  r.tick(61_000);
  assert.equal(recordRenderer(1, { what: 'composerRefused', count: 4 }), true);
  assert.equal(r.lines.at(-1).dropped, 2);
  assert.equal(recordRenderer(1, { what: 'composerRefused', count: 1 }), true);
  assert.equal(r.lines.at(-1).dropped, undefined);
});

test('the default log is a bounded file under the user data folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-log-'));
  try {
    startRendererLog({ dir });
    assert.equal(recordRenderer(3, { what: 'composerComposition', ms: 3000 }), true);
    const file = path.join(dir, 'perf', 'renderer.jsonl');
    await waitFor(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('composerComposition'), 'the line to be written');
    assert.match(fs.readFileSync(file, 'utf8'), /"what":"composerComposition"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('route, event name and input type come from fixed lists: a word that is not on one is dropped, whatever it looks like', () => {
  const r = rig();
  // each of these would pass for a short word; none is on a list (a chat title, a project name, a tool)
  for (const word of ['Quarterly-Report', 'billing', 'Bash', 'claude']) {
    recordRenderer(1, { what: 'slowInput', route: word, name: word, inputType: word, ms: 300 });
    assert.deepEqual(Object.keys(r.lines.at(-1)).sort(), ['kind', 'ms', 't', 'what', 'window'], `${word} is not kept`);
  }
  recordRenderer(1, { what: 'slowInput', route: 'review', name: 'compositionupdate', inputType: 'deleteContentBackward', ms: 300 });
  assert.deepEqual(
    [r.lines.at(-1).route, r.lines.at(-1).name, r.lines.at(-1).inputType],
    ['review', 'compositionupdate', 'deleteContentBackward'],
  );
});

test('the route list is the app routes: a new route is added to it with the route', () => {
  const model = fs.readFileSync(path.join(import.meta.dirname, '..', 'shared', 'model', 'window.d.ts'), 'utf8');
  const route = model.slice(model.indexOf('export type Route ='));
  const names = [...route.slice(0, route.indexOf(';\n')).matchAll(/name: '([a-zA-Z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...ROUTES].sort(), [...new Set(names)].sort());
});

test('MOPILOT_NO_RENDERER_RECORD turns the record off; 0 or an empty text leaves it on', () => {
  const kept: string[] = [];
  const log = { append: (l: string) => void kept.push(l) };
  for (const off of ['1', 'true', 'yes']) {
    startRendererLog({ dir: '/unused', log, env: { MOPILOT_NO_RENDERER_RECORD: off } });
    assert.equal(recordRenderer(1, { what: 'longtask', ms: 300 }), false, off);
  }
  for (const on of [undefined, '', '0']) {
    startRendererLog({ dir: '/unused', log, env: { MOPILOT_NO_RENDERER_RECORD: on } });
    assert.equal(recordRenderer(1, { what: 'longtask', ms: 300 }), true, String(on));
  }
  assert.equal(kept.length, 3);
});

test('a closed window is forgotten: its allowance does not outlive it, and the ipc listener forgets it when the window is destroyed', () => {
  const r = rig();
  for (let i = 0; i < PER_MINUTE; i++) recordRenderer(9, { what: 'longtask', ms: 250 });
  assert.equal(recordRenderer(9, { what: 'longtask', ms: 250 }), false);
  forgetRendererWindow(9);
  assert.equal(recordRenderer(9, { what: 'longtask', ms: 250 }), true, 'a new window with the same id starts afresh');
  assert.equal(r.lines.at(-1).dropped, undefined, 'and does not inherit the count of lines lost');

  let handler: any = null;
  register({ on: (channel: string, fn: unknown) => channel === 'perf:record' && (handler = fn) } as any);
  const destroyed: Array<() => void> = [];
  const sender = { id: 21, once: (_: string, fn: () => void) => destroyed.push(fn) };
  for (let i = 0; i < PER_MINUTE + 3; i++) handler({ sender }, { what: 'longtask', ms: 250 });
  assert.equal(destroyed.length, 1, 'one listener per window, however many lines it sends');
  destroyed[0]();
  const before = r.lines.length;
  handler({ sender }, { what: 'longtask', ms: 250 });
  assert.equal(r.lines.length, before + 1, 'destroyed: its count is gone');
});
