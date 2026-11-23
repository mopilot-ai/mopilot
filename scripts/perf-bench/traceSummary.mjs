// Turns a Chromium trace (Electron contentTracing, JSON events) into per-thread-class paint/composite/raster/GPU totals and the animations that failed to composite.
const THREADS = /** @type {const} */ ({
  CrRendererMain: 'rendererMain',
  Compositor: 'compositor',
  CompositorTileWorker: 'raster',
  CrGpuMain: 'gpuMain',
  VizCompositorThread: 'viz',
});
/** The events whose time makes up the profiler's (program) bucket, by the phase of the frame they belong to. */
export const PHASES = Object.freeze({
  style: ['UpdateLayoutTree', 'RecalcStyle'],
  layout: ['Layout'],
  prePaint: ['PrePaint', 'Layerize'],
  paint: ['Paint'],
  commit: ['Commit', 'UpdateLayer', 'CompositeLayers'],
  raster: ['RasterTask', 'ImageDecodeTask'],
  draw: ['DrawFrame', 'Graphics.Pipeline.DrawAndSwap', 'GPUTask'],
});
const PHASE_OF = new Map(Object.entries(PHASES).flatMap(([phase, names]) => names.map((n) => [n, phase])));
/** Frame boundaries: the main thread's frames (a rAF loop would force them, so none is used) and the frames the GPU drew. */
const FRAMES = /** @type {Record<string, 'main' | 'drawn'>} */ ({
  BeginMainThreadFrame: 'main',
  'ProxyMain::BeginMainFrame': 'main',
  'Graphics.Pipeline.DrawAndSwap': 'drawn',
});
const TASK = 'ThreadControllerImpl::RunTask';
const round = (/** @type {number} */ x) => Math.round(x * 100) / 100;

/**
 * @param {{ ph: string, name: string, pid: number, tid: number, dur?: number, args?: any }[]} events
 * @returns {{ threads: Record<string, { busyMs: number, tasks: number }>, phases: Record<string, { count: number, ms: number, thread: Record<string, number> }>, animations: { started: number, compositeFailed: number, byProperty: Record<string, number> }, frames: { main: number, drawn: number } }}
 */
export function summarizeTrace(events) {
  const kind = new Map();
  for (const e of events) {
    if (e.ph === 'M' && e.name === 'thread_name' && THREADS[e.args?.name]) kind.set(`${e.pid}:${e.tid}`, THREADS[e.args.name]);
  }
  const threads = Object.fromEntries(Object.values(THREADS).map((k) => [k, { busyMs: 0, tasks: 0 }]));
  const phases = Object.fromEntries(Object.keys(PHASES).map((p) => [p, { count: 0, ms: 0, thread: {} }]));
  const animations = { started: 0, compositeFailed: 0, byProperty: /** @type {Record<string, number>} */ ({}) };
  const frames = { main: 0, drawn: 0 };
  for (const e of events) {
    if (FRAMES[e.name] && /^[IXBb]$/.test(e.ph)) frames[FRAMES[e.name]] += 1;
    const thread = kind.get(`${e.pid}:${e.tid}`);
    if (e.ph === 'X' && thread) {
      const ms = (e.dur ?? 0) / 1000;
      if (e.name === TASK) {
        threads[thread].busyMs += ms;
        threads[thread].tasks += 1;
      }
      const phase = PHASE_OF.get(e.name);
      if (phase) {
        const p = phases[phase];
        p.count += 1;
        p.ms += ms;
        p.thread[thread] = round((p.thread[thread] ?? 0) + ms);
      }
    }
    if (e.name === 'Animation' && e.ph === 'b') {
      animations.started += 1;
      const failed = e.args?.data?.compositeFailed;
      if (failed) {
        animations.compositeFailed += 1;
        for (const prop of e.args.data.unsupportedProperties ?? []) animations.byProperty[prop] = (animations.byProperty[prop] ?? 0) + 1;
      }
    }
  }
  for (const t of Object.values(threads)) t.busyMs = round(t.busyMs);
  for (const p of Object.values(phases)) p.ms = round(p.ms);
  return { threads, phases, animations, frames };
}
