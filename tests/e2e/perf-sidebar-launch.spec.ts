// The sidebar's launch timeline (#4655): 30 projects and about 1,900 chats (Claude Code and Codex, some in worktrees) on a seeded profile, launched cold and again warm; each frame of the sidebar is recorded (fixtures/sidebar-frames-preload.cjs), so the spec says when each project's chats first appear and whether any project that has chats is ever drawn empty.
// e2e-runner: bench — launches the app six times on a large profile: it runs only when named (scripts/ci-cuj.mjs --spec)
import path from 'node:path';
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';
import { probeFiles } from './fixtures/coreLoaded';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const PROJECTS = 30;
const CLAUDE_CHATS = 1000;
const CODEX_CHATS = 900;
const LAUNCHES = 4;
/** The sidebar draws every known chat at launch and never draws a project with chats as empty (budgets below); SIDEBAR_LAUNCH_STRICT=0 only reports. */
const STRICT = process.env.SIDEBAR_LAUNCH_STRICT !== '0';
/**
 * The budgets on a relaunch (a saved snapshot): every project's chats drawn within 1,000 ms of the window shown, and the
 * Claude Code list (files on disk) refreshed within 2 s. #4655 aims at 300 ms on a Mac; a shared CI runner spends about
 * 350 ms before boot starts and about 330 ms drawing the 1,900 chats' grouping (the profile and long frames the spec
 * attaches), so the runner budget is a regression guard, not the target. Codex's list waits for its app-server, which
 * the spec makes 4 s slow: reported, not budgeted.
 */
const DRAWN_WARM_MS = 1000;
const REFRESHED_MS = 2000;

const proj = (n: number) => `proj${String(n).padStart(2, '0')}`;
/** Chat n's project: skewed, so a few projects are big and most small, and every project has chats (the first PROJECTS chats take one each). */
const projectOf = (n: number) => (n < PROJECTS ? n : Math.floor(PROJECTS * Math.pow((n * 0.6180339887) % 1, 1.6)));
const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;

const claudeSessions = Array.from({ length: CLAUDE_CHATS }, (_, n) => ({
  id: uuid('cccccccc', n),
  // every tenth chat ran in a worktree of its project
  cwd: n % 10 === 9 ? `${proj(projectOf(n))}/.claude/worktrees/wt${n}` : proj(projectOf(n)),
  title: `Claude chat ${n}`,
  turns: [`question ${n}`],
}));
const codexThreads = Array.from({ length: CODEX_CHATS }, (_, n) => ({
  id: uuid('019b0000', n).replace('-4000-', '-7000-'),
  name: `Codex chat ${n}`,
  cwd: proj(projectOf(n + 7)),
  turns: [`question ${n}`],
}));
/** Every project has at least one chat above; the names the sidebar shows are the folders'. */
const projectNames = Array.from({ length: PROJECTS }, (_, n) => proj(n));

test.use({
  harnesses: 'both',
  // real CLIs take a moment to answer: the Claude Code status check and the Codex app-server start
  env: { FAKE_CLAUDE_STATUS_MS: '4000', FAKE_CODEX_START_MS: '4000', MOPILOT_FLAGS: 'shared.perf.probe=1' },
  codexProjects: projectNames,
  mainRequire: [path.join(__dirname, 'fixtures', 'sidebar-frames-hook.cjs')],
  seed: { claudeSessions, codexThreads },
});

type Frame = { t: number; groups: [string, number, number][] };
/** What the window recorded since it started: its launch marks and each changed frame of the sidebar. */
const readWindow = (page: Page) =>
  page.evaluate(() => ({
    marks: Object.fromEntries(
      performance
        .getEntriesByType('mark')
        .filter((m) => m.name.startsWith('mopilot:'))
        .map((m) => [
          m.name.slice('mopilot:'.length),
          {
            at: Math.round(m.startTime),
            count: (m as PerformanceMark).detail ?? null,
          },
        ]),
    ),
    ...(window as any).__sidebarFrames.read(),
    paint: performance.getEntriesByName('first-contentful-paint').map((e) => Math.round(e.startTime))[0] ?? null,
    // the window's long frames up to now, with the scripts in them: what the renderer does between the page starting and the sidebar drawn
    longFrames: performance
      .getEntriesByType('long-animation-frame')
      .slice(0, 12)
      .map((e: any) => ({
        start: Math.round(e.startTime),
        ms: Math.round(e.duration),
        blocking: Math.round(e.blockingDuration),
        scripts: e.scripts.map((x: any) => ({
          file: (x.sourceURL || '').split('/').pop()?.split('?')[0],
          fn: x.sourceFunctionName,
          invoker: x.invoker,
          ms: Math.round(x.duration),
        })),
      })),
    firstPaintAt: performance.getEntriesByName('first-paint').map((e) => e.startTime)[0] ?? null,
  }));

/** Main's startup marks of a launch (the probe writes once a second): `windowShown` and the window's first paint, on main's clock. */
async function mainMarks(userData: string, before: Set<string>) {
  const marksOf = () =>
    probeFiles(userData)
      .filter((f) => !before.has(f))
      .map((f) =>
        Object.fromEntries(
          readJsonLineLog(path.join(userData, 'perf', f))
            .filter((x: any) => x.kind === 'mark')
            .map((x: any) => [x.name, x.ms]),
        ),
      )
      .find((m) => 'windowShown' in m && 'firstPaint' in m);
  await expect.poll(marksOf, { timeout: 20_000 }).toBeTruthy();
  return marksOf() as Record<string, number>;
}

/** A sampled CPU profile (the DevTools Profiler) summed by self time: the functions the renderer spent its time in, slowest first. */
function profileTop(profile: { nodes: any[]; samples: number[]; timeDeltas: number[] }) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const fns = new Map<string, number>();
  profile.samples.forEach((id, i) => {
    const { functionName, url, lineNumber } = byId.get(id).callFrame;
    const file = url ? (url.split('/').pop()?.split('?')[0] ?? url) : '(native)';
    const key = `${functionName || '(anonymous)'} ${file}:${lineNumber + 1}`;
    fns.set(key, (fns.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  });
  return [...fns]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([name, ms]) => ({ name, ms: Math.round(ms) }));
}

function summarize(w: Awaited<ReturnType<typeof readWindow>>) {
  const frames = w.frames as Frame[];
  const names = new Set(projectNames);
  // first time each project drew a chat row
  const firstRows = new Map<string, number>();
  for (const f of frames)
    for (const [name, rows] of f.groups) if (names.has(name) && rows > 0 && !firstRows.has(name)) firstRows.set(name, f.t);
  // frames that drew a project (every project here has chats) with the empty note
  const empties = frames
    .map((f) => ({
      t: f.t,
      projects: f.groups.filter(([name, rows, empty]) => names.has(name) && empty && rows === 0).map(([name]) => name),
    }))
    .filter((f) => f.projects.length);
  const drawnAll = firstRows.size === PROJECTS ? Math.max(...firstRows.values()) : null;
  const late = [...firstRows].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const firstGroups = frames.find((f) => f.groups.some(([name]) => names.has(name)))?.t ?? null;
  const rowTotals = frames.map((f) => ({
    t: f.t,
    rows: f.groups.reduce((n, g) => n + g[1], 0),
  }));
  return {
    marks: w.marks,
    longFrames: w.longFrames,
    firstContentfulPaint: w.paint,
    ticks: w.ticks,
    changedFrames: frames.length,
    firstProjectGroupAt: firstGroups,
    firstChatRowAt: rowTotals.find((r) => r.rows > 0)?.t ?? null,
    allProjectsDrawnAt: drawnAll,
    projectsWithRows: firstRows.size,
    lateProjects: late.map(([name, t]) => ({ name, t })),
    emptyFrames: {
      frames: empties.length,
      firstAt: empties[0]?.t ?? null,
      lastAt: empties.at(-1)?.t ?? null,
      projects: [...new Set(empties.flatMap((e) => e.projects))].length,
    },
  };
}

test('cold and warm launch: when each project shows its chats, and never an empty project that has chats', async ({
  harness,
}, testInfo) => {
  test.setTimeout(LAUNCHES * 120_000);
  const userData = harness.env.MOPILOT_USER_DATA;
  const runs: (ReturnType<typeof summarize> & { shownAt: number | null })[] = [];
  let before = new Set<string>();
  for (let n = 0; n < LAUNCHES; n++) {
    if (n > 0) {
      before = new Set(probeFiles(userData));
      await harness.relaunch();
    }
    // settled: every project draws a chat and both lists have been read
    await expect
      .poll(
        async () => {
          const w = await readWindow(harness.page).catch(() => null);
          if (!w) return false;
          const s = summarize(w);
          return s.projectsWithRows === PROJECTS && !!s.marks['chats:claude'] && !!s.marks['chats:codex'];
        },
        { timeout: 90_000, intervals: [250] },
      )
      .toBe(true);
    // a little longer: a refresh that follows must not empty a project
    await harness.page.waitForTimeout(3000);
    const w = await readWindow(harness.page);
    const main = await mainMarks(userData, before);
    // the window shown, on the page's clock: main's clock at the window's first paint is the page's first-paint time
    const shownAt = w.firstPaintAt === null ? null : Math.round(main.windowShown - (main.firstPaint - w.firstPaintAt));
    runs.push({ ...summarize(w), shownAt });
  }
  // the renderer reloaded under the CPU profiler until every project draws its chats: where its time goes
  const cdp = await harness.page.context().newCDPSession(harness.page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  await harness.page.reload();
  await expect.poll(async () => summarize(await readWindow(harness.page)).projectsWithRows, { timeout: 30_000 }).toBe(PROJECTS);
  const { profile } = await cdp.send('Profiler.stop');
  await cdp.detach();
  await testInfo.attach('renderer-profile.json', {
    body: JSON.stringify(profileTop(profile as any), null, 2),
    contentType: 'application/json',
  });
  const table = runs.map((r, n) => ({
    launch: n === 0 ? 'first' : `relaunch ${n}`,
    shown: r.shownAt,
    paint: r.firstContentfulPaint,
    groups: r.firstProjectGroupAt,
    firstRow: r.firstChatRowAt,
    allDrawn: r.allProjectsDrawnAt,
    claudeListed: r.marks['chats:claude']?.at,
    codexListed: r.marks['chats:codex']?.at,
    emptyFrames: r.emptyFrames.frames,
  }));
  console.log(`sidebar launch timeline (ms since the page started)\n${JSON.stringify(table, null, 1)}`);
  await testInfo.attach('sidebar-launch.json', {
    body: JSON.stringify(
      {
        projects: PROJECTS,
        claudeChats: CLAUDE_CHATS,
        codexChats: CODEX_CHATS,
        runs,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });

  // the recorder and the marks worked: every project drew chats, and the lists were read
  for (const r of runs) {
    expect(r.projectsWithRows).toBe(PROJECTS);
    expect(r.marks['boot:start']).toBeTruthy();
  }
  if (STRICT) {
    for (const r of runs) expect(r.emptyFrames.frames, JSON.stringify(r.emptyFrames)).toBe(0);
    for (const r of runs.slice(1)) {
      expect(r.allProjectsDrawnAt! - (r.shownAt ?? 0)).toBeLessThanOrEqual(DRAWN_WARM_MS);
      expect(r.marks['chats:claude'].at).toBeLessThanOrEqual(REFRESHED_MS);
    }
  }
});
