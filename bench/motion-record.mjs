// Records one motion moment (bench/lib/motion/moments.mjs) in one app inside the benchmark VM: a screen recording of its front window (or, for the agent-cursor moments, the whole screen at a high frame rate) while the moment's steps play, plus the clock sync, marks, regions and the fixture page's event log bench/motion-metrics.mjs reads. Refuses to start anywhere but a VM. Usage: bench/README.md.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pickModel } from './drivers/desktop.mjs';
import { activate, asUser, clickAt, copy, focusProcess, frontWindowBounds, key, moveAppWindow, screenBounds } from './drivers/gui.mjs';
import { driveBuDirect, startDirectChrome, stopDirectChrome } from './drivers/buDirect.mjs';
import { closeFixture, openFixture, openNativeFixture, startFixtureServer, startSckRecorder } from './drivers/motionKit.mjs';
import { ARMS } from './lib/config.mjs';
import { planFor } from './lib/motion/fixture.mjs';
import { requireVm } from './lib/guard.mjs';
import { parseRecordArgs, syncSpot } from './lib/motion/cli.mjs';
import { closeFixtureWindowsArgs, frontFixtureTabArgs } from './lib/motion/fixtureChrome.mjs';
import { cursorCrop, parkedBounds } from './lib/motion/layout.mjs';
import { installJank, readJank } from './lib/motion/jank.mjs';
import { clickPoint, cursorPrompt, familyOf, MOTION_MODELS, resolveRegions, resolveSteps } from './lib/motion/moments.mjs';
import { startCapture } from '../scripts/motion-cdp/session.mjs';

requireVm('bench/motion-record.mjs');
const cfg = parseRecordArgs(process.argv.slice(2));
const arm = /** @type {any} */ (ARMS)[cfg.arm];
const family = familyOf(arm);
const UID = process.env.BENCH_GUI_UID ?? '501';
// async on purpose: the fixture page's server runs in this process, and a blocking sleep would leave the page's events unanswered
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CLICLICK = process.env.BENCH_CLICLICK ?? '/opt/homebrew/bin/cliclick';
const KEYS = { return: 36, escape: 53, tab: 48, n: 45, v: 9 };
const cursor = cfg.moment.cursor ?? null;
// a cursor moment with no task (calibration) plays no agent turn: the page moves its own target
const withAgent = !cursor || !!cursor.task;
const fixture = await startFixtureServer();
// the browser-use moment without an agent or the extension: MoPilot's AgentCursor drives a scratch Chrome (MOTION_BU_DIRECT_PROFILE, a bu-* folder) over CDP on this port (bench/drivers/buDirect.mjs)
const directPort = cfg.surface === 'bu' && process.env.MOTION_BU_DIRECT_PORT ? Number(process.env.MOTION_BU_DIRECT_PORT) : null;
const directProfile = process.env.MOTION_BU_DIRECT_PROFILE ?? '';
/** The page's address as the agent is told it (the surface adds the plan's query). */
let pageUrl = '';

// MoPilot's extension works only in tabs of its own group: its agent opens the page itself (the prompt gives the address), in a background tab that the operator fronts below
const extensionOpens = cfg.surface === 'bu' && !directPort && arm.kind === 'mopilot';
// the fixture page first (computer use and browser use need it open before the turn), the agent app after it; for the
// in-app browser the agent opens the page itself, so it only gets the address
if (cursor && withAgent) {
  // computer use on a click plan: the fixture app draws the dots itself (MOTION_CU_WEBVIEW=1 keeps the web page): a WKWebView in the VM guest can stay unpainted, and an agent that sees a blank window clicks nothing
  const plan = cfg.moment.cursor?.fixture;
  if (cfg.surface === 'cu' && !directPort && !process.env.MOTION_CU_WEBVIEW && (plan?.plan === 'move' || plan?.plan === 'repeat')) {
    openNativeFixture(fixture, planFor(plan, [1280, 800]).points, true);
    pageUrl = fixture.url;
  } else
    pageUrl = openFixture(/** @type {'cu' | 'iab' | 'bu'} */ (directPort ? 'iab' : cfg.surface), cfg.moment, fixture.url, {
      preopen: !extensionOpens,
    });
  if (directPort) startDirectChrome(directProfile, directPort, pageUrl);
  for (let waited = 0; cfg.surface !== 'iab' && !extensionOpens && !fixture.events.some((e) => e.type === 'ready'); waited += 500) {
    if (waited > 20000) throw new Error('the fixture page never reported ready');
    await sleep(500);
  }
}

// the app in front, nothing focused but its main window (Esc closes a leftover popover)
// (keys and clicks below go only to that app: another one in front stops the recording, gui.mjs toFront)
// a MoPilot instance is driven over its CDP port (it may run in the background and never reach the front); vendor apps by keyboard
const overCdp = arm.kind === 'mopilot' && withAgent && !!cfg.cdp;
if (withAgent && !overCdp) {
  if (directPort) activate('Google Chrome');
  else if (arm.kind === 'mopilot') focusProcess('Electron');
  else activate(arm.app);
  await sleep(1000);
  key(KEYS.escape);
  await sleep(500);
}
// the app's own window, checked in front in the same call: another app's window would be recorded and clicked
const bounds = withAgent && !overCdp ? frontWindowBounds() : [0, 0, 0, 0];
// a moment over the whole screen (computer use moves over other apps' windows) records and measures the screen
const window = /** @type {[number, number, number, number]} */ (cfg.moment.screen ? screenBounds() : bounds);
if (window.length !== 4 || !window.every(Number.isFinite)) throw new Error(`no front window: ${bounds.join(',')}`);
/** The checkout's short commit: from git, else from the `.synced-sha` file vm-sync.sh leaves in a checkout with no .git. */
function ownVersion() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return readFileSync('.synced-sha', 'utf8').trim();
  }
}
const version =
  arm.kind === 'mopilot'
    ? ownVersion()
    : execFileSync('defaults', ['read', `/Applications/${arm.app}.app/Contents/Info.plist`, 'CFBundleShortVersionString'], {
        encoding: 'utf8',
      }).trim();

mkdirSync(cfg.dir, { recursive: true });
const mov = `${cfg.moment.id}.mov`;
const movPath = path.join(cfg.dir, mov);
// the cursor starts away from the sync point (in the screen's corner, on no window), so the sync move always shows
asUser(CLICLICK, ['m:1,1']);
const spawnAt = Date.now();
// ScreenCaptureKit at a high frame rate for the cursor moments (frame times in the wall clock, no cursor sync needed);
// otherwise `screencapture -v` of the window's rect, -C with the cursor (the clock sync moves it), -k click rings, -x no sounds
const useSck = cfg.recorder === 'sck' && !!cursor;
/** @type {Awaited<ReturnType<typeof startSckRecorder>> | null} */
let sck = null;
/** @type {Promise<unknown>} */
let finished;
if (useSck) {
  sck = await startSckRecorder(movPath, { seconds: cfg.seconds, fps: cfg.fps });
  finished = sck.finished;
} else {
  const recorder = spawn(
    'launchctl',
    ['asuser', UID, '/usr/sbin/screencapture', '-v', '-C', '-k', '-x', `-V${cfg.seconds}`, `-R${window.join(',')}`, movPath],
    { stdio: 'ignore' },
  );
  finished = new Promise((resolve, reject) => {
    recorder.on('exit', (code) => (code === 0 ? resolve(null) : reject(new Error(`screencapture exited with ${code}`))));
    recorder.on('error', reject);
  });
}
await sleep(1500);
// the clock sync: the cursor jumps to the middle of the title bar, which the recording sees
const sync = syncSpot(window);
const syncAt = Date.now();
if (!useSck) {
  asUser(CLICLICK, [`m:${window[0] + sync.point[0]},${window[1] + sync.point[1]}`]);
  await sleep(500);
}

// with --cdp, the app's Animation domain and a screencast run alongside the recording, from the same marks; for a
// cursor moment the page's long tasks and long animation frames are collected instead (renderer jank while the agent works)
/** @type {any} */
let browser = null;
/** @type {Awaited<ReturnType<typeof startCapture>> | null} */
let cdpCapture = null;
/** @type {any} */
let cdpPage = null;
if (cfg.cdp) {
  const { chromium } = await import('@playwright/test');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${cfg.cdp}`);
  const pages = browser.contexts().flatMap((/** @type {any} */ c) => c.pages());
  cdpPage = pages.find((/** @type {any} */ p) => p.url().includes(cfg.cdpTarget) && !p.url().startsWith('devtools:'));
  if (!cdpPage)
    throw new Error(`no page matching "${cfg.cdpTarget}" on port ${cfg.cdp}: ${pages.map((/** @type {any} */ p) => p.url()).join(', ')}`);
  if (cursor) await installJank(cdpPage);
  else cdpCapture = await startCapture(cdpPage, { dir: path.join(cfg.dir, 'cdp'), reduced: false, quality: 80 });
}

/** @type {Record<string, number>} */
const marks = {};
const prompt = cursor ? cursorPrompt(cfg.moment, /** @type {'cu' | 'iab' | 'bu'} */ (cfg.surface), pageUrl, family) : null;
if (!withAgent) {
  // calibration: the page starts its moving target when it loads, under the running recorder
  marks.send = Date.now();
  openFixture('cu', cfg.moment, fixture.url);
}
/** @type {import('node:child_process').ChildProcess | null} */
let armTurn = null;
/** @type {Promise<void> | null} */
let directTurn = null;
if (directPort) {
  marks.send = Date.now();
  directTurn = driveBuDirect({ port: directPort, events: fixture.events }).catch((/** @type {Error} */ e) =>
    console.log(`direct: ${e.message}`),
  );
}
if (overCdp && (cfg.surface === 'cu' || extensionOpens)) {
  // the instance's window may sit over the fixture (a click there would hit it, not the fixture): park it in the corner first
  // best effort: another Electron process on the machine (a crashed run's, with no window) can be the one the name picks
  try {
    moveAppWindow('Electron', parkedBounds(/** @type {[number, number, number, number]} */ (screenBounds())));
  } catch (e) {
    console.error(`could not park the MoPilot window (${e instanceof Error ? e.message.split('\n')[0] : e}); going on`);
  }
  // the fixture was opened last, so it is in front: a user's agent works in a background app while their own is in front, and the helper takes another route (a real pointer) for a frontmost one
  try {
    // MOTION_FIXTURE_FRONT=1 leaves the fixture in front: an agent acting on the app the user has in front
    // browser use: the page is the Chrome window the operator fronts below, so MoPilot's window stays parked beside it
    if (cfg.surface === 'cu' && !process.env.MOTION_FIXTURE_FRONT) focusProcess('Electron');
  } catch (e) {
    console.error(`could not bring the MoPilot window forward (${e instanceof Error ? e.message.split('\n')[0] : e}); going on`);
  }
  await sleep(1000);
}
/** The operator's step for the extension arm: whenever the fixture tab is in the background, bring it (and Chrome) to the front; stopped when the recording ends. */
const fronting = extensionOpens
  ? setInterval(() => {
      const child = spawn('launchctl', ['asuser', UID, '/usr/bin/osascript', ...frontFixtureTabArgs()], { stdio: 'ignore' });
      child.on('error', () => {
        // a tick that did not start only delays the front by half a second
      });
    }, 500)
  : null;
if (overCdp) {
  // the chat is started and the prompt sent over CDP by the benchmark's MoPilot driver (new chat on the arm's harness and model); the turn runs while the page is recorded
  marks.send = Date.now();
  armTurn = spawn(
    'node',
    [
      path.join(process.env.HOME ?? '', 'bench', 'runner', 'mopilot-arm.mjs'),
      ...[
        '--port',
        String(arm.port),
        '--harness',
        arm.harness,
        '--model',
        arm.model,
        '--timeout',
        String(cfg.seconds),
        '--prompt',
        prompt ?? '',
      ],
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let armOut = '';
  armTurn.stdout?.on('data', (chunk) => {
    armOut += chunk;
  });
  // the driver's whole report (transcript, steps, approvals) is kept beside the recording
  armTurn.on('exit', () => {
    mkdirSync(cfg.dir, { recursive: true });
    writeFileSync(path.join(cfg.dir, `${cfg.moment.id}.arm.json`), armOut);
    console.log(`arm: ${armOut.slice(0, 300)}`);
  });
}
for (const step of withAgent && !overCdp && !directPort ? resolveSteps(cfg.moment, { prompt: prompt ?? '', url: pageUrl }) : []) {
  if (step.do === 'newChat') {
    key(KEYS.n, 'command down');
    await sleep(2500);
  } else if (step.do === 'model') {
    // Claude Desktop keeps the model per session; ChatGPT and MoPilot instances are set up with theirs (bench/README.md)
    if (family === 'claude') pickModel(arm, MOTION_MODELS.claude);
  } else if (step.do === 'paste') {
    copy(step.text);
    key(KEYS.v, 'command down');
  } else if (step.do === 'key') key(KEYS[step.key], step.mods ?? '');
  else if (step.do === 'click') {
    const at = clickPoint(step, family);
    if (at) clickAt(window[0] + at[0], window[1] + at[1]);
  } else if (step.do === 'wait') await sleep(step.ms);
  else marks[step.name] = Date.now();
}
if (cursor && withAgent && !overCdp && cfg.surface === 'cu') {
  // the agent app has the turn: park its window small in the screen's corner, so it cannot cover the fixture's viewport
  // (a window the agent raises later lands over the page; this one stays where it was put)
  moveAppWindow(
    arm.kind === 'mopilot' ? 'Electron' : arm.app,
    parkedBounds(/** @type {[number, number, number, number]} */ (screenBounds())),
  );
  await sleep(500);
}
if (cursor) {
  // the turn is over when the page says done (or the time is up); then a tail, for the idle fade
  const deadline = spawnAt + cfg.seconds * 1000;
  const tail = (cursor.tailSeconds ?? 3) * 1000;
  while (Date.now() < deadline && !fixture.events.some((e) => e.type === 'done')) await sleep(500);
  await sleep(Math.max(0, Math.min(tail, deadline - Date.now())));
  marks.end = Date.now();
  if (armTurn && armTurn.exitCode === null) armTurn.kill();
  await directTurn;
  if (sck) await sck.stop();
}
await finished;
if (fronting) clearInterval(fronting);
/** @type {string | null} */
let jankFile = null;
if (cdpCapture) {
  const summary = await cdpCapture.finish({
    title: `${arm.app}: animations during ${cfg.moment.id}`,
    arm: cfg.arm,
    family,
    moment: cfg.moment.id,
    marks,
    // the moment's regions as fractions of the page's viewport
    regions: (vp) => resolveRegions(cfg.moment, family, [0, 0, vp[0], vp[1]]),
  });
  console.log(`cdp: ${summary}`);
} else if (cdpPage) {
  jankFile = `${cfg.moment.id}.jank.json`;
  writeFileSync(path.join(cfg.dir, jankFile), `${JSON.stringify(await readJank(cdpPage))}\n`);
}
// a browser reached over CDP is only disconnected, not closed
if (browser) await browser.close();
/** @type {string | null} */
let eventsFile = null;
if (cursor) {
  eventsFile = `${cfg.moment.id}.events.json`;
  // the native fixture's ready event does not name its plan (the page's does): the analysis needs it for the ground truth
  const events = fixture.events.map((e) => (e.type === 'ready' && !e.fixture && cursor.fixture ? { ...e, fixture: cursor.fixture } : e));
  writeFileSync(path.join(cfg.dir, eventsFile), `${JSON.stringify(events)}\n`);
  // the cu fixture is its own native app; bu's is a Chrome window, and only that one: the profile's other windows are the run's
  closeFixture();
  if (directPort) stopDirectChrome(directProfile);
  else {
    try {
      asUser('osascript', closeFixtureWindowsArgs(), undefined, 20);
    } catch (e) {
      // a window left open only stays on the screen; the recording is already saved
      console.warn(`the fixture window was not closed: ${e instanceof Error ? e.message : e}`);
    }
  }
}

fixture.close();

const recording = {
  schema: 2,
  arm: cfg.arm,
  family,
  version,
  moment: cfg.moment.id,
  surface: cfg.surface,
  recorder: cfg.recorder,
  mov,
  seconds: cfg.seconds,
  window,
  // a ScreenCaptureKit recording of a cursor moment is at 1x (sckrecord without --retina): one pixel per point, cropped to the fixture's window for computer use
  ...(sck ? { pxPerPoint: 1 } : {}),
  ...(sck && cfg.surface === 'cu' ? { crop: cursorCrop(fixture.events.find((e) => e.type === 'ready')) } : {}),
  regions: resolveRegions(cfg.moment, family, window),
  sync: sck ? { clock: 'wall', originMs: sck.originMs, spawnAt, syncAt, region: sync.region } : { spawnAt, syncAt, region: sync.region },
  marks,
  files: { events: eventsFile, jank: jankFile, transcript: null, transcriptKind: arm.transcripts ?? null },
  models: MOTION_MODELS,
  recordedAt: new Date().toISOString(),
};
const file = path.join(cfg.dir, `${cfg.moment.id}.json`);
writeFileSync(file, `${JSON.stringify(recording, null, 1)}\n`);
console.log(file);
