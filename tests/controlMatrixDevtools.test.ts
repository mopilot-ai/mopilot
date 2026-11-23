// Control matrix group X, the devtools group (G5, #3571): browser_perf_trace, browser_vitals, browser_accessibility_audit, browser_har and browser_record on the built-in browser and the user's Chrome, deferred on every harness, saving into the chat's folder, ended by the turn, narrated alike.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { makeTabs, OriginGrants } from './support/browser-host-tools/fixture.ts';
import { world as tierWorld, tiers, textOf } from './support/tool-tiers-kit.ts';
import { tick } from './support/async-scenarios.ts';
import { controlStep } from '../src/lib/agentNarration.ts';

const require = createRequire(import.meta.url);
const { createBrowserTools } = require('../electron/capabilities/browser/hostTools.cjs');
const { createChromeTools } = require('../electron/capabilities/browser/chromeTools.cjs');
const { SessionMcp } = require('../electron/capabilities/channels/sessionMcp.cjs');
const { sdkMcpServers } = require('../electron/capabilities/mcp/sdkMcp.cjs');
const { DEVTOOLS_SPECS, DevtoolsHub, auditText, WORLD } = require('../electron/capabilities/browser/devtools/tools.cjs');
const { VITALS_SOURCE } = require('../electron/capabilities/browser/devtools/vitals.cjs');
const { TurnTraces } = require('../electron/capabilities/browser/devtools/turnTrace.cjs');
const { A11Y_AUDIT_SOURCE } = require('../electron/capabilities/browser/devtools/a11yAudit.cjs');
const { REACT_SOURCE } = require('../electron/capabilities/browser/devtools/reactPage.cjs');

const DEV = Object.keys(DEVTOOLS_SPECS);
const CHROME_DEV = DEV.map((n) => n.replace(/^browser_/, 'chrome_'));
const dirs: string[] = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdev-'));
  dirs.push(d);
  return d;
};

/** A JPEG as the movie writer reads it: SOI, a SOF0 with the size, EOI. */
const jpeg = (w = 64, h = 40) =>
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0, 0xff, 0xd9]);
const TRACE = [
  { ph: 'M', name: 'thread_name', pid: 1, tid: 2, args: { name: 'CrRendererMain' } },
  { name: 'navigationStart', pid: 1, ts: 1_000_000, args: { data: { isLoadingMainFrame: true } } },
  { name: 'firstContentfulPaint', pid: 1, ts: 1_900_000 },
  { name: 'largestContentfulPaint::Candidate', pid: 1, ts: 2_200_000, args: { data: { size: 900 } } },
  { name: 'RunTask', ph: 'X', pid: 1, tid: 2, ts: 2_300_000, dur: 120_000 },
];
const VITALS = {
  url: 'https://a.example/page',
  lcp: { ms: 1200, element: 'img#hero', size: 1 },
  cls: 0.02,
  inp: null,
  fcp: 800,
  ttfb: 90,
  load: 1500,
  longTasks: { count: 0, totalMs: 0, longestMs: 0 },
  interactions: 0,
};
const AUDIT = {
  url: 'https://a.example/page',
  rulesRun: 25,
  passes: 20,
  violations: [
    {
      id: 'image-alt',
      impact: 'critical',
      help: 'Images need alt text',
      wcag: ['1.1.1'],
      count: 3,
      nodes: [{ selector: 'img', html: '<img src="a.png">', why: 'No alt.' }],
    },
  ],
  incomplete: [{ id: 'color-contrast', count: 2, nodes: [] }],
};

/** Both surfaces' tools over one fake host whose tab answers the CDP the devtools send. */
function devWorld(host: any = undefined) {
  const uploads = tmp();
  const grants = new OriginGrants({ file: null, anchor: () => 'ask', ask: async () => ({ decision: 'deny' }) });
  grants.set('https://a.example', 'write');
  grants.set('https://r.example', 'read');
  const tabs = makeTabs();
  const ends: ((chatId: string) => void)[] = [];
  tabs.onTurnEnd = (fn: (chatId: string) => void) => (ends.push(fn), () => {});
  const dbg = new EventEmitter();
  const tab = tabs.tab;
  tab.id = 'tab_aaaaaa';
  tab.wc = tab.backend = { tabId: 7, debugger: dbg };
  const st: any = { password: false, page: null, sent: [], body: null };
  tab.send = async (method: string, params: any = {}) => {
    st.sent.push([method, params]);
    if (method === 'Runtime.evaluate' && params.contextId === 99)
      return st.page ?? { result: { value: params.expression.startsWith(VITALS_SOURCE) ? VITALS : AUDIT } };
    // browser_react's page-world reads (reactPage.cjs): the answer for its op
    if (method === 'Runtime.evaluate' && params.expression.startsWith(REACT_SOURCE))
      return { result: { value: st.react?.[JSON.parse(params.expression.slice(REACT_SOURCE.length + 1, -1)).op] } };
    if (method === 'Runtime.evaluate') return { result: { value: st.password } };
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'hook1' };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F1' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 99 };
    if (method === 'Tracing.end')
      setImmediate(() => dbg.emit('message', {}, 'Tracing.tracingComplete', { stream: 's1', dataLossOccurred: st.lost }, ''));
    if (method === 'IO.read') return { data: JSON.stringify({ traceEvents: TRACE }), eof: true };
    if (method === 'Network.getResponseBody') return { body: st.body ?? '{"ok":1}', base64Encoded: false };
    return {};
  };
  // a host with an image port (the app's) or none
  if (host) tabs.o = host;
  const deps = { tabs, grants, folders: () => ({ uploads, downloads: uploads }) };
  const browser = createBrowserTools(deps);
  const chrome = createChromeTools(deps);
  const ctx = { chatId: 'c1', segmentId: 's1' };
  const call = async (tools: any[], name: string, args: any = {}) =>
    (await tools.find((x) => x.name === name).handler(args, ctx))[0].text as string;
  const iab = (name: string, args?: any) => call(browser, `browser_${name}`, args);
  const bu = (name: string, args: any = {}) => call(chrome, `chrome_${name}`, { tabId: 7, ...args });
  const net = (method: string, p: any) => dbg.emit('message', {}, method, p, '');
  const frame = () => dbg.emit('message', {}, 'Page.screencastFrame', { data: jpeg().toString('base64'), sessionId: 1 }, '');
  const turnEnd = async () => {
    for (const fn of ends) fn('c1');
    await tick();
    await new Promise((r) => setTimeout(r, 20));
  };
  return { uploads, grants, tabs, tab, st, dbg, iab, bu, net, frame, turnEnd, browser, ctx };
}

test('CM-X30: the devtools group holds the six tools on both surfaces; ACP and a non-deferring Codex list them only after loading it, Claude Code defers them', async () => {
  assert.deepEqual(tiers.SURFACES.browser.groups.devtools.tools.filter((n: string) => DEV.includes(n)).sort(), [...DEV].sort());
  assert.deepEqual(
    tiers.SURFACES.browser.groups.chrome_devtools.tools.filter((n: string) => CHROME_DEV.includes(n)).sort(),
    [...CHROME_DEV].sort(),
  );
  for (const n of [...DEV, ...CHROME_DEV]) assert.deepEqual(tiers.groupOf(n)?.surface, 'browser', n);
  const w = tierWorld();
  const socket: any = new EventEmitter();
  socket.listen = async () => '/tmp/sock';
  await new SessionMcp({ sessions: w.sessions, socket, command: 'sage-mcp' }).prepare('acp1', {
    harnessPid: 1,
    chatId: 'chat',
    segmentId: 'acp1',
  });
  assert.ok(!(await w.list('acp1')).some((n) => DEV.includes(n) || CHROME_DEV.includes(n)), 'no fixed context');
  // a call through the more tool runs at once; a load lists them from the next turn
  assert.equal(textOf(await w.call('acp1', 'browser_more_tools', { call: 'browser_vitals', arguments: {} })), 'ran browser_vitals');
  assert.equal(
    textOf(await w.call('acp1', 'browser_more_tools', { call: 'chrome_har', arguments: { action: 'start', tabId: 7 } })),
    'ran chrome_har',
  );
  await w.call('acp1', 'browser_more_tools', { load: ['devtools', 'chrome_devtools'] });
  w.registry.turns.retire('chat');
  const listed = await w.list('acp1');
  for (const n of [...DEV, ...CHROME_DEV]) assert.ok(listed.includes(n), n);
  // Claude Code: none of them loads up front
  const sdk = {
    tool: (name: string, _d: string, _s: unknown, _h: unknown, options: any) => ({ name, options }),
    createSdkMcpServer: (o: any) => o,
  };
  const servers = sdkMcpServers({
    sdk,
    z: { fromJSONSchema: (s: unknown) => s },
    registry: w.registry,
    serverName: 'sage_aaaaaaaaaaaa',
    owner: { chatId: 'chat', segmentId: 's' },
  });
  const loading = new Map<string, boolean>();
  for (const [server, cfg] of servers as Map<string, any>)
    for (const t of cfg.tools) loading.set(`${server}/${t.name}`, t.options.alwaysLoad);
  for (const n of ['vitals', 'perf_trace', 'accessibility_audit', 'har', 'record', 'react'])
    for (const server of ['mopilot_browser', 'mopilot_chrome']) assert.equal(loading.get(`${server}/${n}`), false, `${server}/${n}`);
});

test('CM-X31: vitals and the accessibility audit run in the isolated devtools world on the built-in browser and in Chrome, never the page world', async () => {
  const w = devWorld({ images: null });
  for (const out of [await w.iab('vitals'), await w.bu('vitals', { waitMs: 50 })]) {
    assert.match(out, /^Web Vitals of https:\/\/a\.example\/page:\nLCP: 1200 ms \(good\), img#hero/);
    assert.match(out, /INP: not measured \(no interaction yet\)/);
  }
  const audit = await w.bu('accessibility_audit', { rules: ['image-alt'], maxNodes: 1 });
  assert.match(
    audit,
    /1 rule violated, 20 passed, 25 run\.\n\[critical\] image-alt \(3\): Images need alt text WCAG 1\.1\.1\.\n {2}- img <img src="a\.png"> — No alt\.\n {2}… and 2 more\nNeeds a manual check: color-contrast \(2\)\./,
  );
  const evals = w.st.sent.filter(([m, p]) => m === 'Runtime.evaluate' && p.contextId === 99);
  assert.equal(evals.length, 3);
  assert.deepEqual(w.st.sent.find(([m]) => m === 'Page.createIsolatedWorld')[1], {
    frameId: 'F1',
    worldName: WORLD,
    grantUniveralAccess: false,
  });
  assert.ok(evals[1][1].expression.endsWith('({"waitMs":50})'));
  assert.ok(evals[2][1].expression.startsWith(A11Y_AUDIT_SOURCE) && evals[2][1].expression.includes('"maxNodes":1'));
  // a page check that throws is a failed call, with its message
  w.st.page = { exceptionDetails: { exception: { description: 'TypeError: boom' } } };
  await assert.rejects(w.iab('vitals'), /The page check failed: TypeError: boom/);
  w.st.page = { exceptionDetails: { text: 'Uncaught' } };
  await assert.rejects(w.iab('accessibility_audit'), /The page check failed: Uncaught/);
  // a selector that matched nothing says so, rather than reading as a clean page
  assert.equal(
    auditText({ url: 'u', error: 'selector matched no element' }),
    'Accessibility audit of u: nothing audited, the selector matched no element.',
  );
  // the audit's text: plural rules, no WCAG, no why, nothing open
  assert.equal(
    auditText({
      url: 'u',
      passes: 1,
      rulesRun: 3,
      violations: [1, 2].map((i) => ({ id: `r${i}`, impact: 'minor', help: 'h', count: 1, nodes: [{ selector: 's', html: '<a>' }] })),
    }),
    'Accessibility audit of u: 2 rules violated, 1 passed, 3 run.\n[minor] r1 (1): h\n  - s <a>\n[minor] r2 (1): h\n  - s <a>',
  );
});

test('CM-X32: a performance trace streams to the chat folder with LCP, FCP, CLS, INP and long tasks; reload needs write access', async () => {
  const w = devWorld();
  assert.equal(await w.iab('perf_trace', { action: 'stop' }), 'Nothing is tracing in this chat. Call start first.');
  await assert.rejects(w.iab('perf_trace', { action: 'pause' }), /action must be "start" or "stop"/);
  assert.match(
    await w.bu('perf_trace', { action: 'start', reload: true, filename: 'load' }),
    /^Tracing 7, reloaded\. Do what you want to measure/,
  );
  assert.equal(w.tabs.called('history').at(-1)[1], 'reload');
  // Chrome's buffer filled: the trace is kept and says so
  w.st.lost = true;
  const out = await w.bu('perf_trace', { action: 'stop' });
  assert.match(
    out,
    /^Saved a trace of \d+\.\d s \(5 events, 1 KB\) to .*\/traces\/load\.json\. Chrome dropped part of it \(its buffer filled\)\.\nLCP 1200 ms \(good\), FCP 900 ms \(good\), CLS 0 \(good\), INP not measured \(no interaction\)\. Long tasks on the main thread: 1 \(120 ms in all, longest 120 ms\)\./,
  );
  const file = /to (.*load\.json)\./.exec(out)?.[1] as string;
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).traceEvents.length, 5);
  assert.ok(file.startsWith(fs.realpathSync(w.uploads)));
  // a site allowed for reading may be traced; a reload is a write, so it asks (here the user says no)
  w.st.lost = false;
  w.tab.url = 'https://r.example/';
  await assert.rejects(w.iab('perf_trace', { action: 'start', reload: true }), /The user did not allow https:\/\/r\.example/);
  assert.match(await w.iab('perf_trace', { action: 'start' }), /^Tracing tab_aaaaaa\. /);
  // a second start is refused, and leaves no empty file behind
  const traces = () => fs.readdirSync(path.join(fs.realpathSync(w.uploads), 'traces')).length;
  const before = traces();
  await assert.rejects(w.iab('perf_trace', { action: 'start' }), /A trace is already running/);
  assert.equal(traces(), before);
  // the turn ends: the trace is saved, and the next call says so
  await w.turnEnd();
  assert.match(await w.iab('perf_trace', { action: 'stop' }), /^Earlier: Saved a trace .* It stopped by itself: the turn ended\./);
  // a trace lost at the turn end is told once too
  await w.iab('perf_trace', { action: 'start' });
  w.tab.send = async (m: string) => {
    if (m === 'Tracing.end') throw new Error('detached');
    return {};
  };
  await w.turnEnd();
  assert.match(await w.iab('perf_trace', { action: 'stop' }), /^Earlier: the trace that stopped by itself was lost \(detached\)\./);
});

test('CM-X33: a HAR records the chat tabs’ traffic with secrets REDACTED, ends with the turn and is saved where the next call says', async () => {
  const w = devWorld();
  assert.equal(await w.iab('har', { action: 'stop' }), 'Nothing is recording in this chat. Call start first.');
  await assert.rejects(w.bu('har', { action: 'go' }), /action must be "start" or "stop"/);
  assert.match(await w.bu('har', { action: 'start' }), /^Recording this chat's network traffic, starting with 7\./);
  await tick();
  const request = (id: string, post?: string) => {
    w.net('Network.requestWillBeSent', {
      requestId: id,
      timestamp: 1,
      wallTime: 1_700_000_000,
      type: 'XHR',
      request: {
        method: post ? 'POST' : 'GET',
        url: `https://a.example/api?token=abc&q=${id}`,
        headers: { Cookie: 'sid=1', 'Content-Type': 'application/json' },
        postData: post,
      },
    });
    w.net('Network.responseReceived', {
      requestId: id,
      response: { status: 200, mimeType: 'application/json', headers: { 'Set-Cookie': 'x=1' } },
    });
    w.net('Network.loadingFinished', { requestId: id, timestamp: 1.2, encodedDataLength: 8 });
  };
  request('r1', '{"user":"me","password":"hunter2"}');
  // the page now has a password field: the next touch hears it, and bodies of it are left out
  w.st.password = true;
  await w.iab('vitals');
  await new Promise((r) => setTimeout(r, 10));
  request('r2', '{"password":"hunter2"}');
  w.st.password = false;
  assert.match(await w.bu('har', { action: 'start' }), /^Dropped the earlier recording \(2 requests, not saved\)\./);
  await new Promise((r) => setTimeout(r, 10));
  w.st.body = 'x'.repeat(700_000);
  request('r3');
  request('r4');
  const out = await w.iab('har', { action: 'stop', filename: 'flow' });
  assert.match(out, /^Saved a HAR of 2 requests \(1\.\d MB\) to .*\/har\/flow\.har\.$/);
  const har = JSON.parse(fs.readFileSync(/to (.*flow\.har)\./.exec(out)?.[1] as string, 'utf8'));
  const [e] = har.log.entries;
  assert.equal(e.request.url, 'https://a.example/api?token=REDACTED&q=r3');
  assert.deepEqual(
    e.request.headers.find((h: any) => h.name === 'Cookie'),
    { name: 'Cookie', value: 'REDACTED' },
  );
  assert.deepEqual(e.response.headers, [{ name: 'Set-Cookie', value: 'REDACTED' }]);
  assert.ok(!JSON.stringify(har).includes('hunter2'));
  // the turn ends while it records: saved into the chat's folder, told once by the next call
  await w.iab('har', { action: 'start' });
  request('r5', 'a=1&password=hunter2');
  await w.turnEnd();
  assert.match(
    await w.iab('har', { action: 'stop' }),
    /^Earlier: Saved a HAR of 1 requests \(\d+ KB\) to .*network-.*\.har\. It stopped by itself: the turn ended\.$/,
  );
  assert.equal(await w.iab('har', { action: 'stop' }), 'Nothing is recording in this chat. Call start first.');
  // a recording with no folder known (started outside a tool) is not saved at the turn end, and one that can't be written is noted
  const hub = w.tabs.devtools as InstanceType<typeof DevtoolsHub>;
  await hub.har.start('c2', { ...w.tab, chatId: 'c2' });
  await hub.endTurn('c2');
  assert.equal(hub.harSaved.has('c2'), false);
  hub.roots.set('c3', path.join(w.uploads, 'missing', '\0bad'));
  await hub.har.start('c3', { ...w.tab, chatId: 'c3' });
  await hub.endTurn('c3');
  assert.equal(hub.harSaved.has('c3'), false);
});

test('CM-X34: a video records the tab’s screencast to a .mov in the chat folder, leaves password pages out, and ends with the turn', async () => {
  const w = devWorld();
  assert.equal(await w.bu('record', { action: 'stop' }), 'Nothing is recording in this chat. Call start first.');
  await assert.rejects(w.iab('record', { action: 'export' }), /action must be "start" or "stop"/);
  assert.match(await w.bu('record', { action: 'start', filename: 'demo' }), /^Recording 7 to a video\. Call stop to save it/);
  await tick();
  assert.ok(w.st.sent.some(([m]) => m === 'Page.startScreencast'));
  w.frame();
  await new Promise((r) => setTimeout(r, 80));
  w.frame();
  // a page with a password field: its frames are left out
  w.st.password = true;
  await w.iab('vitals');
  await new Promise((r) => setTimeout(r, 80));
  w.frame();
  const out = await w.iab('record', { action: 'stop' });
  assert.match(
    out,
    /^Saved a video of 2 frames \(64x40, \d\.\d s, 1 KB\) to .*\/recordings\/demo\.mov\. 1 frames were left out .* Attach it with browser_file_upload/,
  );
  assert.equal(
    fs
      .readFileSync(/to (.*demo\.mov)\./.exec(out)?.[1] as string)
      .subarray(4, 8)
      .toString(),
    'ftyp',
  );
  // nothing kept: the empty movie is removed and the call says so; a start while recording ends the earlier one
  await w.iab('record', { action: 'start' });
  assert.match(
    await w.iab('record', { action: 'start' }),
    /^The earlier recording ended: Nothing was recorded: no frame of an ordinary page came in\.\nRecording tab_aaaaaa/,
  );
  w.st.password = false;
  await w.iab('vitals');
  await new Promise((r) => setTimeout(r, 10));
  w.frame();
  await w.turnEnd();
  assert.match(
    await w.iab('record', { action: 'stop' }),
    /^Earlier: Saved a video of 1 frames .* It stopped by itself: the turn ended\. Attach it/,
  );
  await w.iab('record', { action: 'start' });
  await w.turnEnd();
  assert.equal(
    await w.iab('record', { action: 'start', filename: 'again' }).then((t) => t.split('\n')[0]),
    'Earlier: Nothing was recorded before it stopped (the turn ended): no frame of an ordinary page came in.',
  );
  assert.ok(fs.readdirSync(path.join(fs.realpathSync(w.uploads), 'recordings')).every((f) => f.endsWith('.mov')));
});

test('CM-X35: the devtools tools are narrated alike on the built-in browser and in Chrome, on every harness', () => {
  const mcp = (tool: string, args: unknown, server = 'sage') => ({
    id: 's',
    type: 'mcpToolCall',
    server,
    tool,
    arguments: args,
    status: 'completed',
    result: { content: [] },
  });
  const cases: [string, any, string][] = [
    ['vitals', {}, 'Measured the page’s Web Vitals'],
    ['accessibility_audit', {}, 'Audited the page’s accessibility'],
    ['perf_trace', { action: 'start' }, 'Started a performance trace'],
    ['perf_trace', { action: 'stop' }, 'Saved a performance trace'],
    ['har', { action: 'start' }, 'Started recording network traffic'],
    ['har', { action: 'stop' }, 'Saved the network traffic'],
    ['record', { action: 'start' }, 'Started recording a video'],
    ['record', { action: 'stop' }, 'Saved a video of the page'],
    ['react', { action: 'tree' }, 'Inspected React components'],
    ['react', { action: 'renders_start' }, 'Started counting React renders'],
    ['react', { action: 'renders_stop' }, 'Counted React renders'],
  ];
  for (const [name, args, done] of cases)
    for (const item of [
      mcp(`mcp__mopilot_browser__${name}`, args),
      mcp(`mcp__sage_0123456789ab__browser_${name}`, args),
      mcp(`sage.browser_${name}`, args),
      { id: 's', type: 'dynamicToolCall', tool: `browser_${name}`, arguments: args, status: 'completed', contentItems: [] },
      mcp(`mcp__mopilot_chrome__${name}`, args),
    ])
      assert.equal(controlStep(item)?.done, done, `${item.tool} ${JSON.stringify(args)}`);
});

test('CM-X36: React inspection reads the page world on the built-in browser and in Chrome; counting renders reloads the page and is a write', async () => {
  const w = devWorld();
  w.st.react = {
    tree: { react: true, count: 2, lines: ['App [1]', '  Cart [2]'] },
    inspect: { name: 'Cart', id: 2, source: null, owners: ['App'], props: { items: 3 }, state: null, hooks: [] },
    renders: { installed: true, commits: 3, components: [{ name: 'Cart', count: 3, ms: 0 }] },
  };
  for (const out of [await w.iab('react', { action: 'tree' }), await w.bu('react', { action: 'tree' })])
    assert.equal(out, '2 components in ' + out.split(' ')[3] + ' inspect one by its [id]:\nApp [1]\n  Cart [2]');
  assert.match(await w.bu('react', { action: 'inspect', id: 2 }), /^Cart \[2\], inside App\nprops: /);
  assert.match(await w.iab('react', { action: 'renders_start' }), /^Counting React renders in tab_aaaaaa/);
  assert.equal(w.tabs.called('history').at(-1)[1], 'reload');
  assert.equal(await w.bu('react', { action: 'renders_stop' }), '3 commits. Renders by component:\nCart: 3');
  const evals = w.st.sent.filter(([m, p]: any) => m === 'Runtime.evaluate' && p.expression.startsWith(REACT_SOURCE));
  assert.ok(evals.length === 4 && evals.every(([, p]: any) => p.contextId === undefined));
  // on a site allowed for reading, the tree reads and the reload asks (here the user says no)
  w.tab.url = 'https://r.example/';
  assert.match(await w.iab('react', { action: 'tree' }), /^2 components/);
  await assert.rejects(w.iab('react', { action: 'renders_start' }), /The user did not allow https:\/\/r\.example/);
});

test('CM-X37: with turn replays on, a built-in browser turn is traced through the page gate and the registry wrap on any harness; off, nothing is', async () => {
  const w = devWorld();
  const root = tmp();
  let on = false;
  const saved: any[] = [];
  const traces = new TurnTraces({
    enabled: () => on,
    root: (chatId: string) => path.join(root, chatId),
    onSaved: (c: string, s: any) => saved.push([c, s]),
  });
  w.tabs.traces = traces;
  const vitals = traces.wrap(w.browser.find((t: any) => t.name === 'browser_vitals'));
  await vitals.handler({}, w.ctx);
  assert.equal(traces.chats.size, 0, 'off: no trace');
  on = true;
  await vitals.handler({}, w.ctx);
  w.frame();
  await new Promise((r) => setTimeout(r, 300));
  w.frame();
  const summary = await traces.endTurn('c1');
  assert.equal(summary.actions, 1);
  assert.ok(summary.frames >= 1);
  assert.deepEqual(
    saved.map(([c]) => c),
    ['c1'],
  );
  const [trace] = traces.list('c1');
  assert.equal(trace.actions[0].tool, 'browser_vitals');
  assert.ok(trace.actions[0].ok);
});
