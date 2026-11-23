import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTrace } from '../scripts/perf-bench/traceSummary.mjs';

const meta = (pid: number, tid: number, name: string) => ({ ph: 'M', name: 'thread_name', pid, tid, args: { name } });
const x = (name: string, tid: number, dur: number) => ({ ph: 'X', name, pid: 1, tid, dur });

test('sums task time per thread class and frame phase, and counts animations that failed to composite', () => {
  const r = summarizeTrace([
    meta(1, 1, 'CrRendererMain'),
    meta(1, 2, 'Compositor'),
    meta(1, 3, 'CompositorTileWorker'),
    meta(1, 9, 'SomethingElse'),
    x('ThreadControllerImpl::RunTask', 1, 4000),
    x('ThreadControllerImpl::RunTask', 1, 1000),
    x('Paint', 1, 2000),
    x('Paint', 1, 500),
    x('RasterTask', 3, 3000),
    x('RasterTask', 9, 9999),
    x('Unrelated', 1, 7000),
    { ph: 'X', name: 'Layout', pid: 1, tid: 1 },
    {
      ph: 'b',
      name: 'Animation',
      pid: 1,
      tid: 1,
      args: { data: { compositeFailed: 8, unsupportedProperties: ['background-position', 'width'] } },
    },
    { ph: 'b', name: 'Animation', pid: 1, tid: 1, args: { data: { compositeFailed: 1 } } },
    { ph: 'b', name: 'Animation', pid: 1, tid: 1, args: { data: { compositeFailed: 0 } } },
    { ph: 'b', name: 'Animation', pid: 1, tid: 1 },
    { ph: 'e', name: 'Animation', pid: 1, tid: 1 },
    { ph: 'I', name: 'BeginMainThreadFrame', pid: 1, tid: 1 },
    { ph: 'X', name: 'ProxyMain::BeginMainFrame', pid: 1, tid: 1 },
    { ph: 'e', name: 'BeginMainThreadFrame', pid: 1, tid: 1 },
    { ph: 'X', name: 'Graphics.Pipeline.DrawAndSwap', pid: 1, tid: 2 },
  ]);
  assert.deepEqual(r.threads.rendererMain, { busyMs: 5, tasks: 2 });
  assert.deepEqual(r.phases.paint, { count: 2, ms: 2.5, thread: { rendererMain: 2.5 } });
  assert.deepEqual(r.phases.raster, { count: 1, ms: 3, thread: { raster: 3 } });
  assert.deepEqual(r.phases.layout, { count: 1, ms: 0, thread: { rendererMain: 0 } });
  assert.deepEqual(r.frames, { main: 2, drawn: 1 });
  assert.deepEqual(r.animations, { started: 4, compositeFailed: 2, byProperty: { 'background-position': 1, width: 1 } });
});

test('is empty for an empty trace', () => {
  const r = summarizeTrace([]);
  assert.deepEqual(r.threads.gpuMain, { busyMs: 0, tasks: 0 });
  assert.equal(r.animations.started, 0);
});
