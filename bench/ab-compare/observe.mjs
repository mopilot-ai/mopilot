// ab-compare's observability section: MoPilot's devtools modules (devtools/*.cjs, the code behind browser_vitals, _accessibility_audit, _har, _perf_trace and _record) and agent-browser's matching commands, each on fixture/observe.html. Headless only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const EVENTS = [
  'Network.requestWillBeSent',
  'Network.responseReceived',
  'Network.loadingFinished',
  'Network.loadingFailed',
  'Page.frameNavigated',
  'Page.screencastFrame',
  'Tracing.tracingComplete',
];
const REACT_URL = 'https://react.dev/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const attempt = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    return { error: String(e?.message || e) };
  }
};

/** A browser tool's tab over a Playwright CDP session: send, and the debugger's message events. */
async function tabOver(page, url) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  const dbg = new EventEmitter();
  for (const ev of EVENTS) cdp.on(ev, (p) => dbg.emit('message', {}, ev, p, ''));
  return { id: 'bench', chatId: 'bench', url, title: 'Observe fixture', backend: { debugger: dbg }, send: (m, p) => cdp.send(m, p ?? {}) };
}

/** Our side: each capability through the same modules the tools run. */
export async function oursObservability(newPage, url, repo) {
  const req = createRequire(path.join(repo, 'x.cjs'));
  const dev = './electron/capabilities/browser/devtools/';
  const { inWorld, auditText } = req(`${dev}tools.cjs`);
  const { VITALS_SOURCE, vitalsText } = req(`${dev}vitals.cjs`);
  const { A11Y_AUDIT_SOURCE } = req(`${dev}a11yAudit.cjs`);
  const { HarRecorder } = req(`${dev}harRecorder.cjs`);
  const { PerfTraces } = req(`${dev}perfTrace.cjs`);
  const { VideoRecorder } = req(`${dev}videoRecorder.cjs`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-observe-'));
  const page = await newPage();
  const out = {};
  try {
    await page.goto(url, { waitUntil: 'load' });
    await sleep(800);
    const tab = await tabOver(page, url);
    out.vitals = await attempt(async () => ({ text: vitalsText(await inWorld(tab, VITALS_SOURCE, { waitMs: 250 })) }));
    out.a11y = await attempt(async () => ({ text: auditText(await inWorld(tab, A11Y_AUDIT_SOURCE, { maxNodes: 5 })) }));
    out.har = await attempt(async () => {
      const har = new HarRecorder();
      await har.start('bench', tab);
      await page.reload({ waitUntil: 'load' });
      await sleep(800);
      return { text: JSON.stringify(await har.har(har.stop('bench'), 'bench')) };
    });
    out.trace = await attempt(async () => {
      const traces = new PerfTraces();
      const file = path.join(dir, 'trace.json');
      await traces.start('bench', tab, file);
      await page.reload({ waitUntil: 'load' });
      await sleep(800);
      await traces.stop('bench');
      return { text: fs.readFileSync(file, 'utf8') };
    });
    out.record = await attempt(async () => {
      const video = new VideoRecorder({});
      const file = path.join(dir, 'video.mov');
      await video.start('bench', tab, file);
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, 120);
        await sleep(150);
      }
      const r = video.stop('bench');
      return { bytes: r?.saved?.bytes ?? 0 };
    });
    // React needs a React page: react.dev (production React keeps its fibers on DOM nodes too)
    const { REACT_SOURCE } = req(`${dev}reactPage.cjs`);
    out.react = await attempt(async () => {
      await page.goto(REACT_URL, { waitUntil: 'load' });
      await sleep(1500);
      const r = await page.evaluate(`${REACT_SOURCE}(${JSON.stringify({ op: 'tree', maxNodes: 200 })})`);
      return { text: r.lines.join('\n') };
    });
  } finally {
    await page.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

/** agent-browser's side: its commands on the same page. `ab(args)` runs one. */
export async function abObservability(ab, url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-observe-ab-'));
  const out = {};
  try {
    await ab(['open', url]);
    await sleep(800);
    out.vitals = await attempt(() => ab(['vitals', '--json']));
    out.a11y = await attempt(() => ab(['a11y', '--json']));
    out.har = await attempt(async () => {
      const file = path.join(dir, 'net.har');
      await ab(['network', 'har', 'start']);
      await ab(['reload']);
      await sleep(800);
      await ab(['network', 'har', 'stop', file]);
      return { text: fs.readFileSync(file, 'utf8') };
    });
    out.trace = await attempt(async () => {
      const file = path.join(dir, 'trace.json');
      await ab(['trace', 'start']);
      await ab(['reload']);
      await sleep(800);
      await ab(['trace', 'stop', file]);
      return { text: fs.readFileSync(file, 'utf8') };
    });
    out.record = await attempt(async () => {
      const file = path.join(dir, 'video.webm');
      await ab(['record', 'start', file]);
      for (let i = 0; i < 6; i++) {
        await ab(['scroll', 'down', '120']);
        await sleep(150);
      }
      await ab(['record', 'stop']);
      return { bytes: fs.existsSync(file) ? fs.statSync(file).size : 0 };
    });
    out.react = await attempt(async () => {
      await ab(['close']).catch(() => {
        // the earlier session may already be gone
      });
      await ab(['open', '--enable', 'react-devtools', REACT_URL]);
      await sleep(1500);
      return ab(['react', 'tree']);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return out;
}
