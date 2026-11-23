// The CU cursor driven by MoPilot's REAL computer-use helper on a real native window, for screen recording in the mopilot-cuj guest (#3810): a scripted fake Claude CLI issues desktop_app_click calls (no model, no vendor app) at the dots of the bench's "Motion fixture" app.
// e2e-runner: bench — VM-only (MOPILOT_REAL_HELPER=1 and a macOS guest): it runs only when named, and skips everywhere else
// Like cuj-cursor-motion-timeline.spec.ts, but nothing is faked below the model: the app launches native/helper/build/MoPilot.app (SAGE_CU_FAKE_HELPER is unset), the grant goes through the product's own app-access card, and every click
// goes through AppScopedControl, the PhantomCursor overlay and the helper's real CGEvent path into a WKWebView. The page logs each click it receives (trusted, client coordinates), so a click that missed its dot fails the test;
// the cursor tip as the overlay drew it just before that click must sit where the page was clicked. The real helper stamps no clicks: the page's click time stands in for the helper's (a few ms later), and the overlay trace hook gives the cursor timeline.
// Needs in the guest: the built helper, the Rust core (scripts/build-core.mjs, or MOPILOT_CORE), Accessibility, Screen Recording and Input Monitoring for the helper, ScreenCaptureKit's window-picker consent given once, and the GUI session's user (BENCH_GUI_UID, default 501).
// Run: MOPILOT_REAL_HELPER=1 npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/cuj-cursor-motion-real-helper.spec.ts  (zsh ~/vm-cuj-run.sh <dir> cuj-cursor-motion-real-helper). Record the screen yourself (bench/motion/sckrecord.swift); the test prints its start time.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures/app';
import type { Page } from '@playwright/test';
import { waitFor } from '../support/waitFor';
import { planApproach } from '../../shared/cursorApproach.mjs';
import { formatReport, measureClick, seesCursor } from '../../scripts/cursor-timeline-report.mjs';
import { insideVirtualMachine } from '../../scripts/release-suites.cjs';

test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');
// the gate: a person asks for this run (the env) and the machine is a virtual machine (the hypervisor flag); a CI runner passes neither
const REAL = process.env.MOPILOT_REAL_HELPER === '1' && insideVirtualMachine();
test.skip(!REAL, 'drives the real helper on a real window: it runs only with MOPILOT_REAL_HELPER=1 inside a virtual machine');
const HELPER_APP = path.resolve(__dirname, '../../native/helper/build/MoPilot.app');
test.use({
  harnesses: 'claude',
  mainRequire: [path.resolve(__dirname, 'fixtures/cursor-trace-hook.cjs')],
  // computer use counts the VM as attended (only honored inside a VM: electron/platform/virtualMachine.cjs); computerHelper stays off, so the real helper is launched
  env: { MOPILOT_BENCH_ATTENDED: '1' },
});

type Pt = { x: number; y: number };
interface Plan {
  name: string;
  fixture: { plan: 'move'; distance: number } | { plan: 'repeat' };
}
// the first page's first dot is the first click of the run (no previous point); each move plan then walks four out-and-back pairs (0, 45, 90 and 135 degrees) of that distance, and the repeat plan clicks one point six times
const ALL_PLANS: Plan[] = [
  { name: '400 pt', fixture: { plan: 'move', distance: 400 } },
  { name: '100 pt', fixture: { plan: 'move', distance: 100 } },
  { name: '200 pt', fixture: { plan: 'move', distance: 200 } },
  { name: 'same point', fixture: { plan: 'repeat' } },
];
// MOTION_ONLY_PLAN="200 pt" runs one plan (a short run for a screen recording); MOTION_EVENTS_OUT=<file> saves the page's event log after the plans, for the bench's cursor analysis of that recording
const PLANS: Plan[] = process.env.MOTION_ONLY_PLAN ? ALL_PLANS.filter((p) => p.name === process.env.MOTION_ONLY_PLAN) : ALL_PLANS;
const STOP_PLAN: Plan = { name: 'stop', fixture: { plan: 'move', distance: 200 } };
const CALIBRATION: Pt[] = [
  { x: 300, y: 300 },
  { x: 900, y: 700 },
];

// the bench modules are native ES modules (import.meta): Playwright's CommonJS loader cannot require them, so they load through a real import()
const nativeImport = new Function('p', 'return import(p)') as (p: string) => Promise<any>;
const benchPath = (rel: string) => path.resolve(__dirname, '../../bench', rel);
// the fixture window the product lists and grants is named after its executable
const FIXTURE_APP_NAME = 'MotionFixture';
const FIXTURE_QUERY = 'Motion fixture';

const call = (name: string, args: object) => `CUCALL mcp__mopilot_computer__${name} ${JSON.stringify(args)}`;
const shot = call('app_screenshot', { app: FIXTURE_APP_NAME });
const clickAtPx = (p: Pt) => call('app_click', { app: FIXTURE_APP_NAME, coordinate: [p.x, p.y] });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The cursor stays parked on its point after the click (Sky's does, until its next action): it must still be there this long after the click. */
const PARKED_FOR_MS = 200;
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** An invariant of the run, measured: a broken one is listed (soft) so one bad click does not hide the table; CURSOR_TIMELINE_STRICT=1 fails the test on it. */
const STRICT = !!process.env.CURSOR_TIMELINE_STRICT;
const findings: string[] = [];
const check = (ok: boolean, message: string) => {
  if (ok) return;
  findings.push(message);
  if (STRICT) expect.soft(ok, message).toBe(true);
};

async function send(page: Page, lines: string[]) {
  await composer(page).fill(lines.join('\n'));
  await expect(composer(page)).toHaveText(lines.join(''));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test('real helper cursor motion: scripted desktop_app_click on the native fixture window, the overlay and the page agree', async ({
  page,
  harness,
}) => {
  test.setTimeout(900_000);
  expect(fs.existsSync(HELPER_APP), `the helper is not built at ${HELPER_APP}: run node scripts/build-helper.mjs`).toBe(true);
  const { buildFixtureApp, closeFixture, openNativeFixture, startFixtureServer } = await nativeImport(benchPath('drivers/motionKit.mjs'));
  const { planFor } = await nativeImport(benchPath('lib/motion/fixture.mjs'));
  buildFixtureApp();
  const server = await startFixtureServer();
  try {
    await run();
  } finally {
    closeFixture();
    server.close();
  }

  async function run() {
    const trace = () =>
      harness.app.evaluate(() => {
        const t = (globalThis as any).__cursorTrace;
        return { events: t.events, samples: t.samples, mode: t.mode, errors: t.errors, system: t.system };
      }) as Promise<{ events: any[]; samples: any[]; mode: string | null; errors: string[]; system: unknown }>;
    const approachCount = async () => (await trace()).events.filter((e) => e.ev === 'approach' && e.kind === 'click').length;
    const pageClicks = (since: number) => server.events.filter((e) => e.type === 'click' && e.t >= since);
    const turnDone = async () => {
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 120_000 });
      await sleep(900);
    };
    /** Gives the native fixture window a plan (the first one starts the app); resolves with its ready event. */
    const openPlan = async (plan: Plan, launch = false) => {
      const before = server.events.length;
      const openedAt = Date.now();
      openNativeFixture(server, planFor(plan.fixture, [1280, 800]).points, launch);
      await waitFor(async () => server.events.slice(before).some((e) => e.type === 'ready'), `the ${plan.name} page to load`, {
        timeoutMs: 60_000,
      });
      await sleep(1500);
      // MOTION_FIXTURE_FRONT=1: the target app is the one the user has in front (the helper takes another route for it)
      if (process.env.MOTION_FIXTURE_FRONT)
        execFileSync('launchctl', [
          'asuser',
          process.env.BENCH_GUI_UID ?? '501',
          '/usr/bin/osascript',
          '-e',
          'tell application "MotionFixture" to activate',
        ]);
      const ready = server.events.slice(before).find((e) => e.type === 'ready');
      return { ready, openedAt };
    };

    await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
    // the first window: calibration (below) and the access request, which goes through the product's own approval card
    const firstPage = await openPlan(PLANS[0], true);
    await send(page, [call('request_access', { apps: [FIXTURE_QUERY], reason: 'Click the fixture dots' }), 'CUSTEPS']);
    await expect(page.locator('.sage-approval')).toContainText(`Allow Claude Code to use ${FIXTURE_APP_NAME}?`, { timeout: 60_000 });
    await page
      .locator('.sage-approval')
      .getByRole('button', { name: /^Allow/ })
      .click();
    await turnDone();

    // calibration: two clicks at known screenshot pixels, read back as client coordinates by the page, give the pixels per point and the title bar's size
    const calibrationStart = Date.now();
    await send(page, [shot, ...CALIBRATION.map(clickAtPx), 'CUSTEPS']);
    await expect.poll(() => pageClicks(calibrationStart).length, { timeout: 90_000 }).toBeGreaterThanOrEqual(CALIBRATION.length);
    await turnDone();
    const [c1, c2] = pageClicks(calibrationStart);
    expect(c1.trusted && c2.trusted, 'the helper’s clicks reach the page as trusted events').toBe(true);
    const ppp = (CALIBRATION[1].x - CALIBRATION[0].x) / (c2.cx - c1.cx);
    expect(Number.isFinite(ppp) && ppp >= 0.9 && ppp <= 4, `pixels per point from the calibration clicks: ${ppp}`).toBe(true);
    /** the window's origin relative to the page's, in points (the title bar above the web view) */
    const off = { x: CALIBRATION[0].x / ppp - c1.cx, y: CALIBRATION[0].y / ppp - c1.cy };
    const toPixels = (p: Pt): Pt => ({ x: Math.round((p.x + off.x) * ppp), y: Math.round((p.y + off.y) * ppp) });
    const calibrationApproaches = await approachCount();

    interface Row {
      dot: Pt;
      /** the nominal move that brings the cursor to this dot from the previous one (null: the first dot, or a repositioning) */
      move: { distance: number; angle: number | null } | null;
    }
    const rows: Row[] = [];
    const clickLists: { plan: Plan; since: number; count: number; first: number }[] = [];
    let expected = calibrationApproaches;
    /** Runs one plan's clicks in one turn. */
    const runPlan = async (plan: Plan, ready: any, since: number, limit: number) => {
      const viewport = ready.viewport as [number, number];
      const dots = planFor(plan.fixture as any, viewport).points.slice(0, limit);
      expect(dots.length, `the ${plan.name} page has dots`).toBeGreaterThan(0);
      await send(page, [shot, ...dots.map((d: any) => clickAtPx(toPixels(d))), 'CUSTEPS']);
      await expect.poll(() => pageClicks(since).length, { timeout: 180_000 }).toBeGreaterThanOrEqual(dots.length);
      await turnDone();
      for (const d of dots) rows.push({ dot: d, move: d.move });
      clickLists.push({ plan, since, count: dots.length, first: expected });
      expected += dots.length;
    };

    // 1. the sequence: the first window is the first plan's; the others open one by one
    console.log(`real helper run starts: ${new Date().toISOString()} (record the screen from here)`);
    await runPlan(PLANS[0], firstPage.ready, Date.now(), 12);
    for (const plan of PLANS.slice(1)) {
      const w = await openPlan(plan);
      await runPlan(plan, w.ready, w.openedAt, plan.fixture.plan === 'repeat' ? 6 : 12);
    }
    if (process.env.MOTION_EVENTS_OUT) fs.writeFileSync(process.env.MOTION_EVENTS_OUT, `${JSON.stringify(server.events)}\n`);
    // 2. Stop while the second click's cursor is on its way
    const stopPage = await openPlan(STOP_PLAN);
    const baseEvents = (await trace()).events.length;
    const stopDots = planFor(STOP_PLAN.fixture as any, stopPage.ready.viewport).points.slice(0, 3);
    await send(page, [shot, ...stopDots.map((d: any) => clickAtPx(toPixels(d))), 'CUSTEPS']);
    await expect(page.locator('.cu-activity.cu-app').getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 60_000 });
    const showsSince = () =>
      harness.app.evaluate(
        (_, from) => (globalThis as any).__cursorTrace.events.slice(from).filter((e: any) => e.ev === 'showInactive').length,
        baseEvents,
      );
    // the second click's cursor has just shown: Stop now
    await waitFor(async () => (await showsSince()) >= 2, 'the second cursor to show', { timeoutMs: 30_000 });
    await page.locator('.cu-activity.cu-app').getByRole('button', { name: 'Stop' }).click({ noWaitAfter: true, timeout: 5000 });
    const stoppedAt = performance.timeOrigin + performance.now();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 60_000 });
    await sleep(2000);

    // -- analysis
    const t = await trace();
    t.samples.sort((a, b) => a.t - b.t);
    const approaches = t.events.filter((e) => e.ev === 'approach' && e.kind === 'click');
    const shows = t.events.filter((e) => e.ev === 'showInactive');
    const table: { name: string; m: any }[] = [];
    const landed: string[] = [];
    let flat = 0;
    for (const { plan, since, count, first: firstApproach } of clickLists) {
      const planClicks = pageClicks(since).slice(0, count);
      for (let i = 0; i < count; i += 1) {
        const a = approaches[firstApproach + i];
        const row = rows[flat + i];
        const label = `${plan.name} #${i + 1}${row.move ? ` ${row.move.distance} pt @${row.move.angle ?? '-'}°` : ' (no move)'}`;
        const clicked = planClicks[i];
        if (!a || !clicked) {
          table.push({ name: label, m: { seen: false } });
          check(false, `${label}: ${a ? 'the page got no click' : 'no cursor approach was traced'}`);
          continue;
        }
        const win = a.bounds as { x: number; y: number; width: number; height: number };
        const local = (p: Pt): Pt => ({ x: p.x - win.x, y: p.y - win.y });
        const target = local(a.to);
        const prevA = i > 0 && approaches[firstApproach + i - 1];
        const prev = prevA ? local(prevA.to) : null;
        const next = approaches[firstApproach + i + 1];
        const shownAt = shows.find((s) => s.t >= a.t)?.t ?? null;
        const m = measureClick({
          samples: t.samples,
          target,
          prev,
          approachAt: a.t,
          clickAt: clicked.t,
          until: next ? Math.min(next.t, clicked.t + 800) : clicked.t + 800,
          shownAt,
          // the overlay window's own hide: the sampler stops with a hidden window
          hiddenAt: t.events.find((e) => e.ev === 'hide' && e.t >= a.t)?.t ?? null,
        });
        table.push({ name: label, m });
        check(
          clicked.hit === true && clicked.trusted === true,
          `${label}: the click landed on its dot (hit ${clicked.hit}, trusted ${clicked.trusted})`,
        );
        landed.push(`${label}: page click at (${clicked.cx}, ${clicked.cy}) client`);
        if (m.seen) {
          // the cursor the user saw must end where the page was clicked: the last tip before the click, in window points
          const tip = [...t.samples].reverse().find((s) => seesCursor(s) && s.t >= a.t && s.t <= clicked.t + 30);
          const clickedLocal = { x: clicked.cx + off.x, y: clicked.cy + off.y };
          if (tip)
            check(
              dist(tip, clickedLocal) <= 8,
              `${label}: cursor tip ${dist(tip, clickedLocal).toFixed(1)} pt from where the page was clicked`,
            );
          const p = planApproach({ from: prev, to: target, bounds: { x: 0, y: 0, width: win.width, height: win.height } });
          check(
            Math.abs(m.startPt - p.distance) <= 6,
            `${label}: starts ${p.distance.toFixed(0)} pt away (measured ${m.startPt.toFixed(1)})`,
          );
          check(m.clickAfterArrivalMs == null || m.clickAfterArrivalMs >= 0, `${label}: the click goes after the cursor arrived`);
          // the cursor stays parked on its point after the click (it leaves with the chat's next action or the end of the turn)
          check(
            m.goneAfterClickMs == null || m.goneAfterClickMs >= PARKED_FOR_MS,
            `${label}: the cursor is still on its point ${PARKED_FOR_MS} ms after the click (gone ${m.goneAfterClickMs?.toFixed(0) ?? 'never'} ms after)`,
          );
        } else check(false, `${label}: the cursor was seen`);
      }
      flat += count;
    }
    const report = formatReport(table);
    console.log(
      `real-helper cursor timeline (sampler: ${t.mode}; ppp ${ppp.toFixed(2)}; title bar ${off.y.toFixed(1)} pt; system animation settings ${JSON.stringify(t.system)}; errors: ${t.errors.slice(0, 3).join(' | ') || 'none'})\n${report}`,
    );
    await test.info().attach('cursor-timeline.txt', { body: report, contentType: 'text/plain' });
    await test.info().attach('cursor-trace.json', {
      body: JSON.stringify({
        table,
        events: t.events,
        samples: t.samples,
        mode: t.mode,
        errors: t.errors,
        pageEvents: server.events,
        ppp,
        off,
      }),
      contentType: 'application/json',
    });
    await test.info().attach('page-clicks.txt', { body: landed.join('\n'), contentType: 'text/plain' });
    expect(t.samples.filter(seesCursor).length, `sampler (${t.mode}) ${t.errors.join(' | ')}`).toBeGreaterThan(50);

    // a cursor shows from its click's approach until the chat's next approach or the next hide (the end of the turn, Stop): none shows outside those windows
    const hideTimes = t.events.filter((e) => e.ev === 'hide').map((e) => e.t as number);
    const allApproaches = approaches.map((a) => a.t as number);
    const spans = allApproaches.map((from, i) => {
      const next = allApproaches[i + 1] ?? Infinity;
      const hidden = hideTimes.find((h) => h > from) ?? Infinity;
      return [from, Math.min(next, hidden) + 60] as const;
    });
    const stray = t.samples.filter(
      (s) => seesCursor(s) && !spans.some(([from, to]) => s.t >= from && s.t <= to) && s.t < (t.events[baseEvents]?.t ?? Infinity),
    );
    check(stray.length === 0, `no cursor outside a click's approach-to-next-action window (${stray.length} samples)`);

    // Stop mid-approach: the second click never reaches the page and the cursor is gone at once
    const cancelAt = t.events.slice(baseEvents).find((e) => e.ev === 'cancel')?.t ?? null;
    const stopClicks = pageClicks(stopPage.openedAt).length;
    test
      .info()
      .annotations.push({ type: 'stop', description: `Stop at ${stoppedAt.toFixed(0)}, cancel at ${cancelAt}, page clicks ${stopClicks}` });
    check(cancelAt != null, 'Stop cancelled the cursor');
    if (cancelAt != null) {
      check(cancelAt - stoppedAt <= 500, `Stop reached the cursor in ${(cancelAt - stoppedAt).toFixed(0)} ms`);
      check(t.samples.filter((s) => seesCursor(s) && !s.frame && s.t > cancelAt + 20).length === 0, 'Stop: no cursor after it');
    }
    check(stopClicks === 1, `Stop mid-approach: only the first click reached the page (${stopClicks})`);
    await test.info().attach('findings.txt', { body: findings.join('\n') || 'none', contentType: 'text/plain' });
    console.log(`findings (${findings.length}${STRICT ? ', strict' : ''}):\n${findings.join('\n')}`);
    // a click that missed its dot is a failure whatever the strictness: the helper did not click where the cursor was shown
    expect(
      findings.filter((f) => /landed on its dot|got no click|no cursor approach/.test(f)),
      'every scripted click reached its dot',
    ).toEqual([]);
  }
});
