// bench/ab-compare/run.mjs: head-to-head of MoPilot's page agent against Vercel agent-browser; see README.md. Headless only: never launches MoPilot.
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  FIXTURE_CASES,
  WEBMCP_CASES,
  scoreWebMcp,
  webMcpNames,
  anyTruncated,
  clickMarker,
  contextCost,
  pageRow,
  parseArgs,
  renderSpecs,
  resolvePages,
  scoreCase,
  toMarkdown,
  totals,
  findRef,
} from '../lib/abCompare.mjs';
import { CAPABILITIES, observabilityMarkdown, observabilityRows } from '../lib/abObservability.mjs';
import { abObservability, oursObservability } from './observe.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const need = createRequire(path.join(HERE, 'package.json'));
const log = (...a) => console.error(...a);

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.error('node bench/ab-compare/run.mjs [--pages default|key,key|url,url] [--out dir] [--latest]');
  process.exit(0);
}
if (!fs.existsSync(path.join(HERE, 'node_modules'))) {
  log('installing bench/ab-compare dependencies...');
  await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: HERE });
}
const { chromium } = need('playwright-core');
const { getEncoding } = need('js-tiktoken');
const { PAGE_AGENT_SOURCE } = createRequire(path.join(REPO, 'x.cjs'))('./electron/capabilities/browser/pageAgent.cjs');
const { readThroughClosedRoots } = createRequire(path.join(REPO, 'x.cjs'))('./electron/capabilities/browser/closedShadow.cjs');
const { SPECS } = createRequire(path.join(REPO, 'x.cjs'))('./electron/capabilities/browser/hostToolSpecs.cjs');
const { WebMcpCatalog } = createRequire(path.join(REPO, 'x.cjs'))('./electron/capabilities/browser/webmcp.cjs');
const enc = getEncoding('o200k_base');
const count = (t) => enc.encode(t).length;

const CHROME = [
  process.env.AB_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
].find((p) => p && fs.existsSync(p));
if (!CHROME) throw new Error('No Chrome found; set AB_CHROME to its executable.');

// --- agent-browser: pinned in package.json, or the newest with --latest ---
let abBin = path.join(HERE, 'node_modules/.bin/agent-browser');
if (opts.latest) {
  const { stdout } = await run('npm', ['view', 'agent-browser', 'version']);
  const dir = path.join(os.tmpdir(), `ab-latest-${stdout.trim()}`);
  if (!fs.existsSync(dir)) await run('npm', ['install', '--prefix', dir, `agent-browser@${stdout.trim()}`, '--no-audit', '--no-fund']);
  abBin = path.join(dir, 'node_modules/.bin/agent-browser');
}
// the same Chrome feature for both arms: WebMCP's page API (agent-browser only enables the CDP domain by default)
const abEnv = { ...process.env, AGENT_BROWSER_EXECUTABLE_PATH: CHROME, AGENT_BROWSER_ARGS: '--enable-features=WebMCP' };
const ab = async (args, timeout = 60000) => {
  const t0 = Date.now();
  const { stdout } = await run(abBin, ['--session', 'abcmp', ...args], { env: abEnv, timeout, maxBuffer: 64 << 20 });
  return { text: stdout, ms: Date.now() - t0 };
};
const abVersion = (await run(abBin, ['--version'], { env: abEnv })).stdout.trim().replace(/^agent-browser\s+/, '');

// --- ours: the page agent's `tree` op, stitching cross-origin frames the way hostPage.readPage does ---
// WebMCP's page API is off in Chrome by default; agent-browser turns it on for the Chrome it manages, and so does this
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-features=WebMCP'] });
const newPage = () => browser.newPage({ viewport: { width: 1280, height: 800 } });

async function oursTree(page, filter) {
  const seq = { n: 0 };
  const lines = [];
  const refFrame = new Map();
  const results = [];
  // Every frame that has its own CDP session (the top frame and cross-site iframes) goes over CDP through the app's
  // closed-shadow hand-over (closedShadow.cjs, as tab.agent does); a same-process frame is evaluated in the page.
  const sessions = new Map();
  const sessionFor = async (frame) => {
    if (sessions.has(frame)) return sessions.get(frame);
    /** @type {{ cdp: any, contextId: any } | null} */
    let found = null;
    try {
      const cdp = await page.context().newCDPSession(frame === page.mainFrame() ? page : frame);
      const worlds = [];
      cdp.on('Runtime.executionContextCreated', (e) => worlds.push(e.context));
      await cdp.send('Runtime.enable');
      const frameId = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
      found = { cdp, contextId: worlds.find((w) => w.auxData?.isDefault && w.auxData.frameId === frameId)?.id };
    } catch {
      found = null; // no session of its own
    }
    sessions.set(frame, found);
    return found;
  };
  const callIn = async (frame, op, args) => {
    await frame.evaluate(PAGE_AGENT_SOURCE);
    const own = await sessionFor(frame);
    let r;
    if (own?.contextId) {
      const { cdp, contextId } = own;
      const expression = `globalThis.__mopilotAgent.call(${JSON.stringify(op)}, ${JSON.stringify(args)}, ${seq.n})`;
      const send = (method, params) => cdp.send(method, params);
      const once = () => cdp.send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true });
      r = (await readThroughClosedRoots({ send }, op, contextId, '', once)).result.value;
    } else r = await frame.evaluate(([o, a, n]) => globalThis.__mopilotAgent.call(o, a, n), [op, args, seq.n]);
    seq.n = r.seq;
    return r.value;
  };
  const expand = async (frame, args, indent) => {
    const out = await callIn(frame, 'tree', args);
    results.push(out);
    for (const line of out.lines || []) {
      const m = /^\u0001FRAME (ref_\d+) (\d+)\u0001$/.exec(line);
      if (!m) {
        lines.push(indent + line);
        for (const r of line.matchAll(/\[(ref_\d+)\]/g)) refFrame.set(r[1], frame);
        continue;
      }
      for (const f of frame.childFrames()) {
        const el = await f.frameElement().catch(() => null);
        const ref = el && (await el.evaluate((e, s) => globalThis.__mopilotAgent?.refFor(e, s).ref, seq.n).catch(() => null));
        if (ref === m[1]) {
          await expand(f, { filter: args.filter, depth: args.depth - Number(m[2]) }, indent + '  '.repeat(Number(m[2])));
          break;
        }
      }
    }
  };
  await expand(page.mainFrame(), { filter, depth: 15, maxChars: 50000 }, '');
  return { text: lines.join('\n'), refFrame, truncated: anyTruncated(results), call: callIn };
}

/** A ref's click point in page coordinates, or the reason the product would not click. */
async function oursPoint(tree, ref) {
  const frame = tree.refFrame.get(ref);
  const loc = await tree.call(frame, 'locate', { ref, scroll: true, hit: true });
  if (loc?.error) return { refused: loc.error };
  if (loc.cover) return { refused: 'covered' };
  let { x, y } = loc;
  for (let f = frame; f.parentFrame(); f = f.parentFrame()) {
    const box = await (await f.frameElement()).boundingBox();
    x += box.x;
    y += box.y;
  }
  return { x, y };
}

async function oursPage(url, filter) {
  const page = await newPage();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 45000 }).catch(() => {
      /* a page that never finishes loading is still measured as it stands */
    });
    await page.waitForTimeout(1500);
    const t0 = Date.now();
    const tree = await oursTree(page, filter);
    return { tool: 'ours', text: tree.text, ms: Date.now() - t0, truncated: tree.truncated };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  } finally {
    await page.close();
  }
}

async function abPage(url) {
  const measure = async (flags) => {
    try {
      const r = await ab(['snapshot', ...flags], 30000);
      return { tool: 'ab', text: r.text, ms: r.ms };
    } catch (e) {
      return { error: String(e.message || e).slice(0, 200) };
    }
  };
  try {
    await ab(['open', url]);
    await new Promise((r) => setTimeout(r, 1500));
  } catch (e) {
    const error = String(e.message || e).slice(0, 200);
    return { abI: { error }, abIU: { error }, abC: { error } };
  }
  return { abI: await measure(['-i']), abIU: await measure(['-i', '-u']), abC: await measure(['-c']) };
}

// --- the fixture: 127.0.0.1:8801 serves the page, localhost:8802 the child, so the iframe is cross-site ---
const serve = (port, host, file) =>
  new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const f = path.join(HERE, 'fixture', (req.url ?? '').replace(/^\/|\?.*$/g, '') || file);
      if (!f.startsWith(path.join(HERE, 'fixture')) || !fs.existsSync(f)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(fs.readFileSync(f));
    });
    s.listen(port, host, () => resolve(s));
  });
const servers = [await serve(8801, '127.0.0.1', 'index.html'), await serve(8802, 'localhost', 'child.html')];
const FIXTURE_URL = 'http://127.0.0.1:8801/index.html';

async function fixtureOurs(c) {
  const page = await newPage();
  try {
    await page.goto(FIXTURE_URL, { waitUntil: 'load' });
    await page.waitForTimeout(500);
    const tree = await oursTree(page, 'interactive');
    const ref = findRef(tree.text, c.label, 'ours');
    let refused = false;
    if (ref && c.kind !== 'listed') {
      if (c.rerender) await page.evaluate(c.rerender);
      const p = await oursPoint(tree, ref);
      if (p.refused) refused = true;
      else await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(200);
    }
    return scoreCase(c, { ref, refused, marker: clickMarker(await page.locator('#count').innerText()) });
  } catch (e) {
    return { pass: false, note: `error: ${String(e.message || e).slice(0, 80)}` };
  } finally {
    await page.close();
  }
}

async function fixtureAb(c) {
  try {
    await ab(['open', FIXTURE_URL]);
    const text = (await ab(['snapshot', '-i'])).text;
    const ref = findRef(text, c.label, 'ab');
    let refused = false;
    if (ref && c.kind !== 'listed') {
      if (c.rerender) await ab(['eval', c.rerender]);
      await ab(['click', `@${ref}`], 15000).catch(() => {
        refused = true;
      });
    }
    const marker = clickMarker((await ab(['get', 'text', '#count'])).text);
    return scoreCase(c, { ref, refused, marker });
  } catch (e) {
    return { pass: false, note: `error: ${String(e.message || e).slice(0, 80)}` };
  }
}

// --- WebMCP (#3571, G6): ours is the app's own catalog (webmcp.cjs) over the page's CDP session, as tab.cjs attaches it ---
const WEBMCP_URL = 'http://127.0.0.1:8801/webmcp.html';
const WEBMCP_EVENTS = ['WebMCP.toolsAdded', 'WebMCP.toolsRemoved', 'WebMCP.toolResponded', 'Page.frameNavigated', 'Page.frameDetached'];

async function webMcpOurs(c) {
  const page = await newPage();
  try {
    const cdp = await page.context().newCDPSession(page);
    const dbg = new EventEmitter();
    for (const e of WEBMCP_EVENTS) cdp.on(e, (p) => dbg.emit('message', {}, e, p, ''));
    Object.assign(dbg, { sendCommand: (m, p) => cdp.send(m, p) });
    const tab = { id: 'tab_bench', frames: new Map(), backend: { debugger: dbg }, send: (m, p) => cdp.send(m, p) };
    Object.defineProperty(tab, 'url', { get: () => page.url() });
    await cdp.send('Page.enable');
    await page.goto(WEBMCP_URL, { waitUntil: 'load' });
    const catalog = new WebMcpCatalog(tab);
    await catalog.watch();
    await page.waitForTimeout(800);
    const names = catalog.list().map((t) => t.name);
    if (c.kind === 'webmcp-invoke') {
      const r = await catalog.invoke(catalog.find(c.tool, undefined), c.params, { timeoutMs: 10000 });
      if (r.status !== 'Completed') return scoreWebMcp(c, { error: `${r.status} ${r.errorText || ''}` });
    }
    return scoreWebMcp(c, { names, marker: clickMarker(await page.locator('#count').innerText()) });
  } catch (e) {
    return scoreWebMcp(c, { error: e.message || e });
  } finally {
    await page.close();
  }
}

async function webMcpAb(c) {
  try {
    await ab(['open', WEBMCP_URL]);
    await new Promise((r) => setTimeout(r, 800));
    const names = webMcpNames((await ab(['webmcp', 'list', '--json'])).text);
    if (c.kind === 'webmcp-invoke') await ab(['webmcp', 'invoke', c.tool, '--params', JSON.stringify(c.params)]);
    return scoreWebMcp(c, { names, marker: clickMarker((await ab(['get', 'text', '#count'])).text) });
  } catch (e) {
    return scoreWebMcp(c, { error: e.message || e });
  }
}

// --- run ---
const pages = [];
for (const { key, url } of opts.observeOnly ? [] : resolvePages(opts.pages)) {
  log(`page ${key}`);
  const raw = { oursInteractive: await oursPage(url, 'interactive'), oursAll: await oursPage(url, 'all'), ...(await abPage(url)) };
  pages.push(pageRow(key, url, raw, count));
}
const fixture = [];
for (const c of opts.observeOnly ? [] : FIXTURE_CASES) {
  log(`fixture ${c.id}`);
  fixture.push({ id: c.id, title: c.title, ours: await fixtureOurs(c), ab: await fixtureAb(c) });
}
log('observability');
const OBSERVE_URL = 'http://127.0.0.1:8801/observe.html';
const oursObs = await oursObservability(newPage, OBSERVE_URL, REPO);
const abObs = await abObservability(ab, OBSERVE_URL);
const observability = observabilityRows(Object.fromEntries(CAPABILITIES.map((c) => [c.id, { ours: oursObs[c.id], ab: abObs[c.id] }])));
for (const c of WEBMCP_CASES) {
  log(`fixture ${c.id}`);
  fixture.push({ id: c.id, title: c.title, ours: await webMcpOurs(c), ab: await webMcpAb(c) });
}
const core = (await ab(['skills', 'get', 'core'])).text;
const context = contextCost(count(renderSpecs(SPECS)), count(core));
await ab(['close']).catch(() => {
  /* the session may already be gone */
});
await browser.close();
for (const s of servers) s.close();

const report = {
  date: new Date().toISOString().slice(0, 10),
  abVersion,
  chrome: CHROME,
  pages,
  totals: totals(pages),
  fixture,
  context,
  observability,
};
fs.mkdirSync(opts.out, { recursive: true });
const base = path.join(opts.out, `ab-compare-${report.date}`);
fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
const markdown = `${toMarkdown(report)}\n${observabilityMarkdown(observability)}`;
fs.writeFileSync(`${base}.md`, markdown);
log(markdown);
log(`wrote ${base}.json and ${base}.md`);
console.log(JSON.stringify(report, null, 2));
