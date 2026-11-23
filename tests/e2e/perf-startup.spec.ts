// Phase 0's startup and idle probes on the real app (docs/architecture/rust-core.md §2, docs/performance/measurement.md):
// ten launches on a profile of 200 chats each write the startup timeline in order (main's marks, the window's first
// paint, the first chat interactive), and an idle minute writes each process's samples, main's CPU time and the spawns.
// The medians and p95s are attached as startup.json and idle.json; the baseline itself is a release run (10 minutes idle).
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { expectCoreLoaded, probeFiles } from './fixtures/coreLoaded';

const LAUNCHES = 10;
const CHATS = 200;
/** How long the idle check stays idle: long enough for several idle samples (every 10 s). */
const IDLE_MS = 60_000;
const MARKS = ['boot', 'mainLoaded', 'whenReady', 'windowCreated', 'windowShown', 'appReady', 'firstPaint', 'chatInteractive'];

const id = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sidebar = (page: Page) => page.getByRole('complementary');
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });

test.use({
  harnesses: 'claude',
  // MOPILOT_REQUIRE_TIMES: boot times each file main loads (electron/perf/requireTimes.cjs)
  env: { MOPILOT_FLAGS: 'shared.perf.probe=1', MOPILOT_REQUIRE_TIMES: '1' },
  seed: {
    claudeSessions: Array.from({ length: CHATS }, (_, n) => ({
      id: id(n),
      cwd: 'proj',
      title: `Seeded chat ${n}`,
      turns: ['first question', 'second question'],
    })),
  },
});

/** One probe file's samples. */
const samplesOf = (userData: string, file: string) => readJsonLineLog(path.join(userData, 'perf', file));
/** Each mark's time in a run's samples, by name. */
const timelineOf = (samples: any[]) => Object.fromEntries(samples.filter((s) => s.kind === 'mark').map((s) => [s.name, s.ms]));
/** The CommonJS modules main had loaded at each of its marks, by name (a window's marks carry none). */
const modulesOf = (samples: any[]) =>
  Object.fromEntries(samples.filter((s) => s.kind === 'mark' && Number.isInteger(s.modules)).map((s) => [s.name, s.modules]));
/** In the window: its long animation frames and the scripts and stylesheets it loaded, times in ms since it started. */
const rendererTimeline = () => {
  const ms = (x: number) => Math.round(x);
  const file = (url: string) => url.split('/').pop()?.split('?')[0] ?? url;
  return {
    frames: performance.getEntriesByType('long-animation-frame').map((e: any) => ({
      start: ms(e.startTime),
      ms: ms(e.duration),
      blocking: ms(e.blockingDuration),
      // the frame's task work before rendering, and its style and layout
      work: ms((e.renderStart || e.startTime + e.duration) - e.startTime),
      layout: e.styleAndLayoutStart ? ms(e.startTime + e.duration - e.styleAndLayoutStart) : 0,
      scripts: e.scripts.map((x: any) => ({ file: file(x.sourceURL), fn: x.sourceFunctionName, invoker: x.invoker, ms: ms(x.duration) })),
    })),
    marks: performance.getEntriesByType('mark').map((m) => ({ name: m.name, at: ms(m.startTime) })),
    loaded: performance
      .getEntriesByType('resource')
      .filter((r) => /\.(m?js|css)$/.test(file(r.name)))
      .map((r: any) => ({ file: file(r.name), start: ms(r.startTime), ms: ms(r.duration), bytes: r.decodedBodySize })),
  };
};
/**
 * A sampled CPU profile (Chrome DevTools' Profiler) summed by self time: the functions and the files the renderer spent
 * its time in, slowest first, and the time outside script (idle, GC, the engine's own work).
 */
function profileSummary(profile: { nodes: any[]; samples: number[]; timeDeltas: number[] }) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const fns = new Map<string, number>();
  const files = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, ms: number) => m.set(k, (m.get(k) ?? 0) + ms);
  profile.samples.forEach((id, i) => {
    const { functionName, url, lineNumber } = byId.get(id).callFrame;
    const ms = (profile.timeDeltas[i] ?? 0) / 1000;
    const file = url ? (url.split('/').pop()?.split('?')[0] ?? url) : `(${functionName || 'native'})`;
    add(files, file, ms);
    add(fns, `${functionName || '(anonymous)'} ${file}:${lineNumber + 1}`, ms);
  });
  const top = (m: Map<string, number>, n: number) =>
    [...m]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([name, ms]) => ({ name, ms: Math.round(ms) }));
  return { ms: Math.round(profile.timeDeltas.reduce((n, d) => n + d, 0) / 1000), files: top(files, 25), functions: top(fns, 40) };
}

/** The renderer reloaded under the CPU profiler, up to the chat interactive again. */
async function profiledReload(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  await page.reload();
  await expect(composer(page)).toBeVisible();
  await sidebar(page)
    .getByText(`Seeded chat ${CHATS - 1}`, { exact: true })
    .first()
    .click();
  await expect(page.getByRole('main').getByText('fake-claude: second question', { exact: true })).toBeVisible();
  const { profile } = await cdp.send('Profiler.stop');
  await cdp.detach();
  return profileSummary(profile as any);
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

test('cold start: each launch writes its startup timeline in order, and a minute idle writes the process samples', async ({
  harness,
}, testInfo) => {
  test.setTimeout(LAUNCHES * 60_000 + IDLE_MS + 120_000);
  const userData = harness.env.MOPILOT_USER_DATA;
  /** each launch's samples: the probe file it wrote with the whole timeline (a launch may start another process, which
   * writes a file of its own) */
  const launches: any[][] = [];
  let renderer: Awaited<ReturnType<typeof rendererTimeline>> | null = null;
  let rendererProfile: ReturnType<typeof profileSummary> | null = null;
  let before = new Set<string>();
  for (let n = 0; n < LAUNCHES; n++) {
    if (n > 0) {
      before = new Set(probeFiles(userData));
      await harness.relaunch();
    }
    await expect(composer(harness.page)).toBeVisible();
    // the first chat interactive: a chat on screen with its history loaded (the newest, at the top of the list)
    await sidebar(harness.page)
      .getByText(`Seeded chat ${CHATS - 1}`, { exact: true })
      .first()
      .click();
    await expect(harness.page.getByRole('main').getByText('fake-claude: second question', { exact: true })).toBeVisible();
    // the window's marks reach main with its next send (once a second), and main writes once a second
    const mine = () =>
      probeFiles(userData)
        .filter((f) => !before.has(f))
        .find((f) => MARKS.every((name) => name in timelineOf(samplesOf(userData, f))));
    await expect.poll(mine, { timeout: 15_000 }).toBeTruthy();
    const file = mine() as string;
    expectCoreLoaded(samplesOf(userData, file));
    // the last launch's renderer timeline up to the chat interactive: its long frames (with the scripts in them) and the
    // scripts and stylesheets it loaded, which say where the time from first paint to the chat interactive goes
    if (n === LAUNCHES - 1) renderer = await harness.page.evaluate(rendererTimeline);
    if (n === LAUNCHES - 1) await harness.page.waitForTimeout(IDLE_MS);
    // read before a reload adds a second set of the window's marks to the file
    launches.push(samplesOf(userData, file));
    // the launch before the last: what the renderer runs from a load to the chat interactive, by function and file
    if (n === LAUNCHES - 2) rendererProfile = await profiledReload(harness.page);
    await harness.quit();
  }

  const timelines = launches.map(timelineOf);
  for (const t of timelines) {
    for (const name of MARKS) expect(typeof t[name], `${name} in ${JSON.stringify(t)}`).toBe('number');
    expect(t.boot).toBeLessThanOrEqual(t.mainLoaded);
    expect(t.mainLoaded).toBeLessThanOrEqual(t.whenReady);
    expect(t.whenReady).toBeLessThanOrEqual(t.windowCreated);
    expect(t.windowCreated).toBeLessThanOrEqual(t.appReady);
    expect(t.firstPaint).toBeLessThanOrEqual(t.chatInteractive);
  }
  // every mark each launch wrote, MARKS and the finer ones on startup's path (electron/app/startup.cjs), in time order
  const all = Object.keys(timelines[0])
    .filter((name) => timelines.every((t) => typeof t[name] === 'number'))
    .sort((a, b) => timelines[0][a] - timelines[0][b]);
  const startup = Object.fromEntries(
    all.map((name) => {
      const xs = timelines.map((t) => t[name] as number);
      return [name, { median: quantile(xs, 0.5), p95: quantile(xs, 0.95) }];
    }),
  );
  // main's module count at its marks: the same every launch (no timing in it), so the last launch's stands for them
  const modules = modulesOf(launches.at(-1)!);
  expect(modules.windowCreated).toBeLessThanOrEqual(modules.appReady);
  // what they were at whenReady, by package, heaviest first: what a lazy require would move out of startup
  const atReady = launches.at(-1)!.find((s) => s.kind === 'modules' && s.name === 'whenReady')?.packages ?? {};
  expect(Object.values(atReady).reduce((n: number, c: any) => n + c, 0)).toBe(modules.whenReady);
  const packages = Object.fromEntries(Object.entries(atReady).slice(0, 25));
  // each file's own load time (its nested requires left out), slowest first, from the last launch
  const requires = launches.at(-1)!.find((s) => s.kind === 'requires');
  expect(requires?.files).toBeGreaterThan(0);
  // what the window waited on main for until its chat was interactive: each channel's answers, slowest in total first
  const lastLaunch = launches.at(-1)!;
  const interactiveAt = lastLaunch.find((s) => s.kind === 'mark' && s.name === 'chatInteractive')?.t ?? Infinity;
  const byChannel = new Map<string, { count: number; ms: number; max: number }>();
  for (const s of lastLaunch.filter((x) => x.kind === 'invoke' && x.t <= interactiveAt)) {
    const v = byChannel.get(s.channel) ?? { count: 0, ms: 0, max: 0 };
    byChannel.set(s.channel, { count: v.count + s.count, ms: Math.round((v.ms + s.ms) * 10) / 10, max: Math.max(v.max, s.max) });
  }
  expect(byChannel.size).toBeGreaterThan(0);
  const invokes = Object.fromEntries([...byChannel].sort((a, b) => b[1].ms - a[1].ms).slice(0, 25));
  await testInfo.attach('renderer.json', {
    body: JSON.stringify({ ...renderer, profile: rendererProfile }, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('startup.json', {
    body: JSON.stringify({ launches: LAUNCHES, chats: CHATS, startup, modules, packages, requires, invokes, timelines }, null, 2),
    contentType: 'application/json',
  });

  // the last launch stayed idle a minute: its process, CPU and spawn samples
  const idle = launches.at(-1)!;
  const procs = idle.filter((s) => s.kind === 'proc');
  expect(procs.some((s) => s.type === 'Browser' && s.rssKb > 0)).toBe(true);
  expect(idle.filter((s) => s.kind === 'cpu').length).toBeGreaterThanOrEqual(2);
  expect(idle.filter((s) => s.kind === 'spawns').every((s) => Number.isInteger(s.count))).toBe(true);
  const last = Math.max(...procs.map((s) => s.t));
  await testInfo.attach('idle.json', {
    body: JSON.stringify(
      {
        seconds: IDLE_MS / 1000,
        processes: procs.filter((s) => s.t === last),
        cpu: idle.filter((s) => s.kind === 'cpu'),
        spawns: idle.filter((s) => s.kind === 'spawns').reduce((n, s) => n + s.count, 0),
        // which programs they were, over the whole idle run
        commands: idle
          .filter((s) => s.kind === 'spawns')
          .reduce((all: Record<string, number>, s) => {
            for (const [name, n] of Object.entries(s.commands as Record<string, number>)) all[name] = (all[name] ?? 0) + n;
            return all;
          }, {}),
        // and where in the app each was started (electron/perf/probe.cjs callerOf), most first
        sites: Object.fromEntries(
          Object.entries(
            idle
              .filter((s) => s.kind === 'spawns')
              .reduce((all: Record<string, number>, s) => {
                for (const [site, n] of Object.entries((s.sites ?? {}) as Record<string, number>)) all[site] = (all[site] ?? 0) + n;
                return all;
              }, {}),
          ).sort((a, b) => b[1] - a[1]),
        ),
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
});
