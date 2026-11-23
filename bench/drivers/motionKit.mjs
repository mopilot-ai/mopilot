// VM-only glue for the cursor moments (#3810): the fixture page's server and event log, opening the fixture page for each agent surface, and compiling and starting the ScreenCaptureKit recorder. Thin on purpose; the plans and the analysis are in bench/lib/motion.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { BENCH_DIR } from '../lib/config.mjs';
import { classicFixtureSource, fixtureHtml } from '../lib/motion/fixture.mjs';
import { FIXTURE_APP_EXE, fixtureInfoPlist, openFixtureAppCommand, parsePidFile, QUIT_FIXTURE_SCRIPT } from '../lib/motion/fixtureApp.mjs';
import { fixtureQuery } from '../lib/motion/moments.mjs';
import { bashAsUser } from './gui.mjs';

const UID = process.env.BENCH_GUI_UID ?? '501';
const BIN = path.join(BENCH_DIR, 'results', '.bin');

/** Compiles bench/motion/<name>.swift once per source version into results/.bin; returns the binary. */
export function tool(/** @type {string} */ name) {
  const src = path.join(BENCH_DIR, 'motion', `${name}.swift`);
  const hash = crypto.createHash('sha256').update(readFileSync(src)).digest('hex').slice(0, 12);
  const bin = path.join(BIN, `${name}-${hash}`);
  if (!existsSync(bin)) {
    mkdirSync(BIN, { recursive: true });
    execFileSync('swiftc', ['-O', '-suppress-warnings', '-o', bin, src], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  return bin;
}

const FIXTURE_MODULE = path.join(BENCH_DIR, 'lib', 'motion', 'fixture.mjs');
const FIXTURE_PID_FILE = '/tmp/motion-fixture.pid';

/**
 * Compiles bench/motion/fixtureapp.swift once per source version into results/.bin/<hash>/MotionFixture.app, an ad-hoc
 * signed minimal bundle (a native window the vendors' and MoPilot's computer use all treat as an ordinary app); returns its path.
 */
export function buildFixtureApp() {
  const src = path.join(BENCH_DIR, 'motion', 'fixtureapp.swift');
  const plist = fixtureInfoPlist();
  const hash = crypto.createHash('sha256').update(readFileSync(src)).update(plist).digest('hex').slice(0, 12);
  const app = path.join(BIN, `motionfixture-${hash}`, 'MotionFixture.app');
  if (!existsSync(path.join(app, 'Contents', '_CodeSignature'))) {
    rmSync(app, { recursive: true, force: true });
    mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(path.join(app, 'Contents', 'Info.plist'), plist);
    execFileSync('swiftc', ['-O', '-suppress-warnings', '-o', path.join(app, 'Contents', 'MacOS', FIXTURE_APP_EXE), src], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  return app;
}

/** Quits the native fixture app; if it is still there, kills only the pid it wrote to its pid file. Never kills by name. */
export function closeFixture() {
  bashAsUser(`osascript -e ${JSON.stringify(QUIT_FIXTURE_SCRIPT)}`, 20);
  const pid = parsePidFile(existsSync(FIXTURE_PID_FILE) ? readFileSync(FIXTURE_PID_FILE, 'utf8') : null);
  if (pid) {
    bashAsUser(`sleep 1; kill -0 ${pid} 2>/dev/null && kill ${pid}; rm -f ${JSON.stringify(FIXTURE_PID_FILE)}`, 20);
  }
}

/**
 * Serves the fixture page on a free local port and keeps the events it reports. `/` is the page, `/fixture.mjs` the
 * plans module and `/fixture.js` its classic-script form (the page loads that one, WKWebView runs no ES modules), `POST /event` one JSON event.
 * @returns {Promise<{ url: string, events: any[], setPlan: (points: { x: number, y: number }[]) => void, close: () => void }>}
 */
export function startFixtureServer() {
  /** @type {any[]} */
  const events = [];
  /** the native-drawn fixture's current plan (`GET /plan`); a new seq restarts its dots */
  let plan = { seq: 0, points: /** @type {{ x: number, y: number }[]} */ ([]) };
  const server = http.createServer((req, res) => {
    if (req.url === '/plan') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(plan));
    } else if (req.method === 'POST' && req.url === '/event') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          events.push(JSON.parse(body));
        } catch {
          // a beacon that is not JSON is dropped
        }
        res.writeHead(204).end();
      });
    } else if (req.url?.startsWith('/fixture.mjs')) {
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(FIXTURE_MODULE));
    } else if (req.url?.startsWith('/fixture.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(classicFixtureSource(readFileSync(FIXTURE_MODULE, 'utf8')));
    } else res.writeHead(200, { 'content-type': 'text/html' }).end(fixtureHtml());
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        events,
        setPlan: (/** @type {{ x: number, y: number }[]} */ points) =>
          (plan = { seq: plan.seq + 1, points: points.map(({ x, y }) => ({ x, y })) }),
        close: () => server.close(),
      });
    }),
  );
}

/**
 * Opens the fixture page the way a surface needs it, in the GUI session. CU: the native "Motion fixture" app (a WKWebView
 * window at the screen's top left; not a browser, so MoPilot's computer use may click it; the agent can only see pixels). BU: the bench's Chrome with the vendor's extension (`bench-chrome.mjs`,
 * on the profile in MOPILOT_BENCH_CHROME_PROFILE). IAB: nothing; the prompt tells the agent to open the page in its own browser.
 * @param {'cu' | 'iab' | 'bu'} surface @param {import('../lib/motion/moments.mjs').Moment} moment @param {string} baseUrl @param {{ preopen?: boolean }} [o] bu only
 */
export function openFixture(surface, moment, baseUrl, { preopen = true } = {}) {
  const url = `${baseUrl}${fixtureQuery(moment)}`;
  if (surface === 'iab') return url;
  if (surface === 'cu') {
    // an app left by an earlier or crashed run would sit in front of the new one and take the agent's clicks (`open -na` always starts another)
    closeFixture();
    bashAsUser(openFixtureAppCommand(buildFixtureApp(), url, FIXTURE_PID_FILE));
  } else {
    const profile = process.env.MOPILOT_BENCH_CHROME_PROFILE;
    if (!profile) throw new Error('the bu surface needs MOPILOT_BENCH_CHROME_PROFILE: the bench Chrome profile with the vendor extension');
    // preopen false: Chrome starts (extension on, no page) and the agent opens the page itself, as MoPilot's extension needs
    execFileSync('node', [path.join(BENCH_DIR, 'bench-chrome.mjs'), profile, '40', ...(preopen ? [url] : [])], { stdio: 'inherit' });
  }
  return url;
}

/**
 * Gives the native fixture app drawing the dots itself (no web view: the same window and events as the page, for a run whose subject is the click path into a plain AppKit view) its next plan,
 * starting the app on the first one; every later plan restarts the dots in the same window, so the product's remembered window stays valid.
 * @param {Awaited<ReturnType<typeof startFixtureServer>>} server @param {{ x: number, y: number }[]} points the dots, in the 1280x800 content view's points
 * @param {boolean} launch true for the run's first plan
 */
export function openNativeFixture(server, points, launch) {
  server.setPlan(points);
  if (launch) {
    closeFixture();
    bashAsUser(openFixtureAppCommand(buildFixtureApp(), `${server.url}?native=1`, FIXTURE_PID_FILE));
  }
}

/**
 * Starts the ScreenCaptureKit recorder (bench/motion/sckrecord.swift) in the GUI session. Its first stdout line is the
 * wall-clock ms of the first frame; stop() writes `<out>.stop`, which the tool polls for and finishes the file on (a signal would stop launchctl, not the tool), and resolves with the exit code.
 * @param {string} out the .mov path @param {{ seconds: number, fps: number }} o
 * @returns {Promise<{ originMs: number, stop: () => Promise<number | null>, finished: Promise<number | null> }>}
 */
export function startSckRecorder(out, { seconds, fps }) {
  const child = spawn('launchctl', ['asuser', UID, tool('sckrecord'), out, String(seconds), String(fps)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const finished = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return new Promise((resolve, reject) => {
    let line = '';
    child.stdout.on('data', (chunk) => {
      line += chunk;
      if (!line.includes('\n')) return;
      const first = JSON.parse(line.split('\n')[0]);
      resolve({ originMs: first.startedAtMs, finished, stop: () => (writeFileSync(`${out}.stop`, ''), finished) });
    });
    child.on('error', reject);
    // an exit before the first frame (after it, `reject` is a no-op) fails the start
    void finished.then(() => reject(new Error('sckrecord exited before its first frame (no Screen Recording grant for it?)')));
  });
}
