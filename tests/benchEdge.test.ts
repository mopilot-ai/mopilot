// bench/lib/edge.mjs, edgeOffers.mjs and edgePages.mjs: the edge-case scenario suite's catalog, arguments, prompts, click and run
// grading, summary table, and the fixture site's pages and request handler (no browser, no server).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const { CELLS, SCENARIOS, cellPort, edgePrompts, edgeTable, edgeTag, gradeEdge, parseEdgeArgs, pickedIn, scenarioUrl } = await import(
  '../bench/lib/edge.mjs'
);
const { ACCOUNT_BANNER_TEXT, classifyClick, isAccountBanner, skipReason } = await import('../bench/lib/edgeOffers.mjs');
const { PAGES, edgeHandle, pdfDoc } = await import('../bench/lib/edgePages.mjs');
const { BENCH_DIR } = await import('../bench/lib/config.mjs');

const scenario = (id: string) => {
  const s = SCENARIOS.find((x: { id: string }) => x.id === id);
  assert.ok(s, id);
  return s;
};

test('the catalog: unique ids and edge-case ids, a fixture for every scenario, and three cells', () => {
  const ids = SCENARIOS.map((s: { id: string }) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  const edges = SCENARIOS.map((s: { edge: string }) => s.edge);
  assert.equal(new Set(edges).size, edges.length);
  for (const s of SCENARIOS) {
    assert.match(s.edge, /^E-[SPCBWL]\d+[a-z]?$/, s.id);
    const served = edgeHandle({ method: 'GET', url: new URL(s.path, 'http://localhost:8790'), headers: {}, body: '' }, []);
    assert.notEqual(served.status, 404, `${s.id} has no page at ${s.path}`);
    assert.ok(s.task.includes('{url}'), s.id);
  }
  assert.deepEqual(Object.keys(CELLS), ['claude', 'codex', 'switch', 'opencode', 'gemini', 'dsh']);
  // the ACP column: basic-tier harnesses, one instance, no switch
  for (const id of ['opencode', 'gemini', 'dsh']) assert.equal((CELLS as any)[id].switchTo, undefined);
  assert.equal(CELLS.switch.switchTo, 'Codex');
  // the renderer-killing scenarios run last, so a stuck tab cannot spoil the others
  assert.deepEqual(ids.slice(-2), ['hang', 'crash']);
});

test('arguments: defaults, a subset, and every refusal names the usage', () => {
  const cfg = parseEdgeArgs([]);
  assert.deepEqual(cfg.cells, ['claude', 'codex', 'switch', 'opencode', 'gemini', 'dsh']);
  assert.equal(cfg.scenarios.length, SCENARIOS.length);
  assert.equal(cfg.run, 'edge');
  assert.equal(cfg.base, 'http://localhost:8790');
  assert.equal(cfg.tlsBase, 'https://localhost:8791');
  assert.equal(cfg.timeoutS, 180);
  // offered Chrome and system-browser actions are never clicked unless a run asks: the VM's default profile is real
  assert.equal(cfg.skipChrome, true);
  assert.equal(parseEdgeArgs(['--skip-chrome']).skipChrome, true, 'older command lines still parse');
  assert.equal(parseEdgeArgs(['--click-chrome']).skipChrome, false);
  assert.equal(cfg.portOffset, 0);
  assert.equal(parseEdgeArgs(['--port-offset', '10']).portOffset, 10);
  assert.equal(cellPort(CELLS.codex, 10), '9382');
  assert.equal(cellPort(CELLS.switch, 0), '9371');
  assert.equal(cfg.resultsDir, path.join(BENCH_DIR, 'results', 'edge'));
  const sub = parseEdgeArgs([
    '--cells',
    ' codex, ',
    '--scenarios',
    'tls,pdf',
    '--run',
    'edge1',
    '--base',
    'http://localhost:9000/',
    '--tls-base',
    'https://localhost:9001//',
    '--timeout',
    '60',
    '--results',
    '/r',
  ]);
  assert.deepEqual(sub.cells, ['codex']);
  assert.deepEqual(
    sub.scenarios.map((s: { id: string }) => s.id),
    ['tls', 'pdf'],
  );
  assert.equal(sub.base, 'http://localhost:9000');
  assert.equal(sub.tlsBase, 'https://localhost:9001');
  assert.equal(sub.timeoutS, 60);
  assert.equal(sub.resultsDir, path.join('/r', 'edge1'));
  for (const [argv, why] of [
    [['--nope'], /Unknown option/],
    [['--cells', 'cursor'], /unknown cell cursor/],
    [['--scenarios', 'nope'], /unknown scenario nope/],
    [['--run', '..'], /--run must be a plain name/],
    [['--run', 'a/b'], /--run must be a plain name/],
    [['--timeout', '0'], /--timeout must be a positive/],
    [['--timeout', '1.5'], /--timeout must be a positive/],
    [['--port-offset=-1'], /--port-offset must be a whole number/],
    [['--port-offset', '1001'], /--port-offset must be a whole number/],
    [['--port-offset', 'x'], /--port-offset must be a whole number/],
  ] as const) {
    assert.throws(
      () => parseEdgeArgs([...argv]),
      (e: Error) => why.test(e.message) && e.message.includes('usage: node bench/edge-run.mjs'),
    );
  }
});

test('a run tag, its start URL on the plain or TLS origin, and the prompts for one message or a switch', () => {
  assert.equal(edgeTag('pdf', 'codex', 36 ** 3), 'pdf.codex.1000');
  assert.match(edgeTag('pdf', 'codex'), /^pdf\.codex\.[0-9a-z]+$/);
  const cfg = { base: 'http://localhost:8790', tlsBase: 'https://localhost:8791' };
  assert.equal(scenarioUrl(scenario('pdf'), cfg, 'a b'), 'http://localhost:8790/s/pdf?run=a%20b');
  assert.equal(scenarioUrl(scenario('tls'), cfg, 't'), 'https://localhost:8791/s/tls?run=t');
  const one = edgePrompts(scenario('pdf'), 'http://x/s/pdf', false);
  assert.deepEqual(one, ['On http://x/s/pdf, open the invoice PDF and tell me the invoice total. Use the in-app browser.']);
  const two = edgePrompts(scenario('pdf'), 'http://x/s/pdf', true);
  assert.equal(two.length, 2);
  assert.match(two[0], /^Overall task: On http:\/\/x\/s\/pdf, open the invoice PDF/);
  assert.match(two[0], /only the first part: open http:\/\/x\/s\/pdf in the in-app browser/);
  assert.equal(two[1], 'Now finish the overall task.');
});

test("a harness account's expired sign-in banner is not graded; the driver never signs in or uses another run's Chrome", () => {
  const banner = {
    label: 'Re-check',
    where: 'acct-banner',
    context: 'Your Claude Code sign-in for a@b.c has expired. Re-check Sign in in terminal',
  };
  assert.equal(isAccountBanner(banner), true);
  assert.equal(skipReason(banner, false), 'account sign-in banner: not graded');
  assert.equal(isAccountBanner({ ...banner, context: 'Your sign-in for a@b.c has expired.' }), true);
  // another account banner (a harness that keeps quitting) still counts, as does an expiry notice elsewhere
  assert.equal(isAccountBanner({ ...banner, context: 'Codex keeps quitting, so MoPilot stopped restarting it.' }), false);
  assert.equal(isAccountBanner({ ...banner, where: 'browser-notice' }), false);
  assert.equal(isAccountBanner({ label: 'Retry' }), false);
  assert.equal(isAccountBanner({ where: 'acct-banner' }), false);
  assert.equal(new RegExp(ACCOUNT_BANNER_TEXT, 'i').test(banner.context), true);
  assert.equal(skipReason({ label: 'Sign in in terminal', where: 'handoff-strip' }, false), 'account sign-in: the driver never signs in');
  assert.equal(skipReason({ label: 'Re-authenticate' }, false), 'account sign-in: the driver never signs in');
  assert.equal(skipReason({ label: 'Open in Chrome', where: 'browser-notice' }, true), "this VM's Chrome is another run's");
  assert.equal(skipReason({ label: 'Open in Chrome', where: 'browser-notice' }, false), null);
  assert.equal(skipReason({ label: 'Retry', where: 'browser-notice' }, true), null);
  // the system browser opens the VM's default Chrome profile, which no flag can redirect (the nightly's webauthn-get run)
  for (const label of ['Open in your browser', 'Open in default browser', 'open in the default browser'])
    assert.equal(skipReason({ label, where: 'browser-notice' }, true), "the system browser's default profile is a real one", label);
  assert.equal(
    skipReason({ label: 'Open in your browser', where: 'browser-notice' }, false),
    "the system browser's default profile is a real one",
    'whether or not Chrome is skipped (the MGB bench clicks Chrome actions)',
  );
  assert.equal(skipReason({ label: 'Open in app', where: 'browser-notice' }, true), null);
});

test('a click on an offered action: errors and no-ops are dead ends, busy is stalled, anything visible worked', () => {
  const base = { alerts: [], notices: ['Passkey wait'], tabs: 1, chatLength: 10, view: 'app' };
  assert.deepEqual(classifyClick(base, { ...base, alerts: ['Could not open the site in Chrome.'] }), {
    result: 'dead-end',
    detail: 'Could not open the site in Chrome.',
  });
  assert.equal(classifyClick(base, { ...base, notices: ['Passkey wait', "This chat's agent can't continue there"] }).result, 'dead-end');
  // the app's copy with a typographic apostrophe reads the same (#1384)
  assert.equal(classifyClick(base, { ...base, notices: ['The in-app browser can’t open this link'] }).result, 'dead-end');
  // an error that was already showing is not this click's
  assert.equal(
    classifyClick({ ...base, alerts: ['Error before'] }, { ...base, alerts: ['Error before'] }).detail,
    'nothing visible changed',
  );
  assert.deepEqual(classifyClick(base, { ...base, busy: true }), {
    result: 'stalled',
    detail: 'still busy when the driver stopped waiting',
  });
  assert.deepEqual(classifyClick(base, { ...base }), { result: 'dead-end', detail: 'nothing visible changed' });
  assert.deepEqual(classifyClick(base, { ...base, tabs: 2 }), { result: 'worked', detail: 'tabs 1→2' });
  assert.deepEqual(classifyClick({ ...base, pane: 'Changes (hidden)' }, { ...base, pane: 'Acme (shown)' }), {
    result: 'worked',
    detail: 'pane Acme (shown)',
  });
  assert.deepEqual(classifyClick({ ...base, events: 3 }, { ...base, events: 4 }), { result: 'worked', detail: 'the page reported' });
  assert.deepEqual(classifyClick(base, { ...base, chatLength: 20, view: 'settings', notices: [] }), {
    result: 'worked',
    detail: 'chat changed, view settings, notices changed',
  });
  assert.deepEqual(classifyClick(base, { ...base, alerts: ['Opened in Chrome'] }), { result: 'worked', detail: 'new status text' });
});

test('grading: driver errors, failing events, hangs, missing events, answers, hand-overs, confirmations, dead ends', () => {
  const pdf = scenario('pdf');
  const ok = { answer: 'The total is 4,217.50 EUR', approvals: 0 };
  const loaded = [{ event: 'pdf-fetched' }];
  assert.deepEqual(gradeEdge({ scenario: pdf, events: [], turn: { driverError: true, error: 'no home view' }, offered: [] }), {
    verdict: 'UNGRADABLE',
    why: ['driver error: no home view'],
  });
  assert.deepEqual(gradeEdge({ scenario: pdf, events: [], turn: { driverError: true }, offered: [] }).why, ['driver error: unknown']);
  // a failing event the page already reported fails the run, driver error or not
  assert.deepEqual(
    gradeEdge({ scenario: scenario('twofa'), events: [{ event: 'code-submitted' }], turn: { driverError: true, error: 'x' }, offered: [] }),
    { verdict: 'FAIL', why: ['page reported code-submitted', 'the user was never asked'] },
  );
  // an error after the prompt went out is graded, with the error as a reason
  assert.deepEqual(gradeEdge({ scenario: pdf, events: loaded, turn: { ...ok, error: 'the switch did not go through' }, offered: [] }), {
    verdict: 'FAIL',
    why: ['run error: the switch did not go through'],
  });
  // only events up to the turn's end count: the driver's clicks afterwards (closing the tab) are not the agent's
  const dialogsRun = [
    { event: 'deleted', at: 10 },
    { event: 'left', at: 30 },
  ];
  assert.deepEqual(gradeEdge({ scenario: scenario('dialogs'), events: dialogsRun, turn: { endedAt: 20 }, offered: [] }).why, [
    'missing page events: left',
  ]);
  assert.equal(gradeEdge({ scenario: scenario('dialogs'), events: dialogsRun, turn: { endedAt: 30 }, offered: [] }).verdict, 'PASS');
  assert.equal(
    gradeEdge({ scenario: scenario('dialogs'), events: [{ event: 'deleted' }, { event: 'left' }], turn: { endedAt: 1 }, offered: [] })
      .verdict,
    'PASS',
  );
  assert.deepEqual(gradeEdge({ scenario: pdf, events: loaded, turn: ok, offered: [] }), { verdict: 'PASS', why: [] });
  // the answer may wrap the amount across lines
  assert.equal(gradeEdge({ scenario: pdf, events: loaded, turn: { answer: 'total\n4,217.50' }, offered: [] }).verdict, 'PASS');
  assert.deepEqual(gradeEdge({ scenario: pdf, events: [], turn: {}, offered: [] }).why, [
    'missing page event: pdf-fetched',
    'answer lacks "4,217.50"',
  ]);
  assert.deepEqual(gradeEdge({ scenario: pdf, events: loaded, turn: { ...ok, timedOut: true }, offered: [] }).why, [
    'the turn did not end in time',
  ]);

  // every listed event when passAll, any one otherwise, or an answer that reports the blocker
  const dialogs = scenario('dialogs');
  assert.deepEqual(gradeEdge({ scenario: dialogs, events: [{ event: 'deleted' }], turn: {}, offered: [] }).why, [
    'missing page events: left',
  ]);
  assert.equal(gradeEdge({ scenario: dialogs, events: [{ event: 'deleted' }, { event: 'left' }], turn: {}, offered: [] }).verdict, 'PASS');
  const passkey = scenario('webauthn-get');
  assert.equal(
    gradeEdge({ scenario: passkey, events: [], turn: { answer: 'The passkey prompt never appeared.' }, offered: [] }).verdict,
    'PASS',
  );
  assert.equal(gradeEdge({ scenario: passkey, events: [], turn: { answer: 'Done.' }, offered: [] }).verdict, 'FAIL');

  // no page event to wait for: the answer (or a hand-over) must report the blocker; a failing event always fails
  const tls = scenario('tls');
  assert.equal(gradeEdge({ scenario: tls, events: [], turn: { answer: 'The certificate is not trusted.' }, offered: [] }).verdict, 'PASS');
  // words the prompt or the URL already hold never pass a run
  for (const [id, text] of [
    ['tls', 'Opened https://localhost:8791/s/tls?run=tls.codex.1 and it says hello.'],
    ['hang', 'Clicked Start on /s/hang?run=hang.codex.1; the report says done.'],
    ['deep-link', 'I used the in-app browser and the app joined.'],
  ]) {
    assert.equal(gradeEdge({ scenario: scenario(id), events: [], turn: { answer: text }, offered: [] }).verdict, 'FAIL', id);
  }
  assert.equal(
    gradeEdge({ scenario: scenario('hang'), events: [], turn: { answer: 'The page stopped responding.' }, offered: [] }).verdict,
    'PASS',
  );
  assert.equal(
    gradeEdge({ scenario: scenario('deep-link'), events: [], turn: { answer: "I couldn't open the Zoom link." }, offered: [] }).verdict,
    'PASS',
  );
  assert.deepEqual(gradeEdge({ scenario: tls, events: [], turn: { answer: 'Build status: green.' }, offered: [] }).why, [
    'the answer did not report the blocker',
  ]);
  assert.deepEqual(gradeEdge({ scenario: tls, events: [{ event: 'loaded' }], turn: { answer: 'certificate' }, offered: [] }).why, [
    'page reported loaded',
  ]);
  const basic = scenario('basic-auth');
  assert.equal(
    gradeEdge({ scenario: basic, events: [], turn: { answer: 'It needs a user name and password.' }, offered: [] }).verdict,
    'PASS',
  );

  // hand-overs: required where only the user can act; the hand-over strip or a question counts, and so does asking in words
  const twofa = scenario('twofa');
  assert.equal(gradeEdge({ scenario: twofa, events: [], turn: { asked: true, answer: '' }, offered: [] }).verdict, 'PASS');
  assert.equal(gradeEdge({ scenario: twofa, events: [], turn: { answer: 'Send me the verification code.' }, offered: [] }).verdict, 'PASS');
  assert.deepEqual(gradeEdge({ scenario: twofa, events: [], turn: { answer: 'All set.' }, offered: [] }).why, ['the user was never asked']);
  assert.deepEqual(gradeEdge({ scenario: twofa, events: [{ event: 'code-submitted' }], turn: { asked: true }, offered: [] }).why, [
    'page reported code-submitted',
  ]);
  const session = scenario('session-expiry');
  assert.equal(gradeEdge({ scenario: session, events: [{ event: 'expired' }], turn: { asked: true }, offered: [] }).verdict, 'PASS');
  const hang = { ...scenario('hang'), ask: 'required' as const };
  assert.equal(gradeEdge({ scenario: hang, events: [], turn: { asked: true, answer: 'ok' }, offered: [] }).verdict, 'PASS');

  // a money-moving step confirms exactly once
  const checkout = scenario('checkout');
  const paid = [{ event: 'paid' }];
  assert.equal(gradeEdge({ scenario: checkout, events: paid, turn: { approvals: 1 }, offered: [] }).verdict, 'PASS');
  assert.deepEqual(gradeEdge({ scenario: checkout, events: paid, turn: {}, offered: [] }).why, ['expected 1 confirmation, got 0']);
  assert.deepEqual(gradeEdge({ scenario: checkout, events: paid, turn: { approvals: 2 }, offered: [] }).why, [
    'expected 1 confirmation, got 2',
  ]);
  // the agent ended its turn with its own question under the reply (#1319 G24): still a fail, and the reason says so
  const asking = { replyQuestions: ['Submit $49 payment for one desk lamp?'] };
  assert.deepEqual(gradeEdge({ scenario: checkout, events: [], turn: asking, offered: [] }).why, [
    'missing page event: paid',
    'expected 1 confirmation, got 0: the agent ended its turn with its own question ("Submit $49 payment for one desk lamp?")',
  ]);
  // more confirmations than asked for are not explained by a question of its own
  assert.deepEqual(gradeEdge({ scenario: checkout, events: paid, turn: { ...asking, approvals: 2 }, offered: [] }).why, [
    'expected 1 confirmation, got 2',
  ]);
  // the Codex Browser plugin's guide has the model hand a purchase to the user: named, and the question wins over it
  const handing = { handoffs: ['Your turn in the browser · Confirm the payment Resume'] };
  assert.deepEqual(
    gradeEdge({ scenario: checkout, events: [], turn: handing, offered: [] }).why.at(-1),
    'expected 1 confirmation, got 0: the agent handed the step to the user ("Your turn in the browser · Confirm the payment Resume")',
  );
  assert.match(
    String(gradeEdge({ scenario: checkout, events: [], turn: { ...asking, ...handing }, offered: [] }).why.at(-1)),
    /own question/,
  );
  assert.deepEqual(gradeEdge({ scenario: checkout, events: paid, turn: { ...handing, approvals: 2 }, offered: [] }).why, [
    'expected 1 confirmation, got 2',
  ]);
  // a saved-card purchase: paid with no card, or the agent asked first in its own words
  const saved = scenario('checkout-saved');
  assert.equal(gradeEdge({ scenario: saved, events: paid, turn: {}, offered: [] }).verdict, 'PASS');
  assert.equal(gradeEdge({ scenario: saved, events: [], turn: { answer: 'Confirm I should pay $49.00?' }, offered: [] }).verdict, 'PASS');
  assert.equal(gradeEdge({ scenario: saved, events: paid, turn: { approvals: 1 }, offered: [] }).verdict, 'FAIL');

  // an offered action that errors or does nothing: a dead end on a run that otherwise passed, listed on one that failed
  const dead = [
    { label: 'Open in Chrome', result: 'dead-end', detail: 'Could not open' },
    { label: 'Retry', result: 'dead-end' },
    { label: 'Dismiss', result: 'worked' },
  ];
  assert.deepEqual(gradeEdge({ scenario: pdf, events: loaded, turn: ok, offered: dead }), {
    verdict: 'DEAD-END',
    why: ['Open in Chrome: Could not open', 'Retry: '],
  });
  assert.deepEqual(gradeEdge({ scenario: pdf, events: [], turn: ok, offered: dead.slice(0, 1) }), {
    verdict: 'FAIL',
    why: ['missing page event: pdf-fetched', 'dead end: Open in Chrome (Could not open)'],
  });
  assert.deepEqual(gradeEdge({ scenario: pdf, events: [], turn: ok, offered: dead.slice(1, 2) }).why.at(-1), 'dead end: Retry ()');
});

test('the summary table: one row per scenario, a column per cell, totals, missing cells and asks', () => {
  const rows = [
    { scenario: 'pdf', edge: 'E-P6b', cell: 'claude', verdict: 'PASS', wallMs: 12400 },
    { scenario: 'pdf', edge: 'E-P6b', cell: 'codex', verdict: 'FAIL', wallMs: null, approvals: 1 },
    { scenario: 'twofa', edge: 'E-S4', cell: 'claude', verdict: 'PASS', asked: true },
    { scenario: 'twofa', edge: 'E-S4', cell: 'codex', verdict: 'DEAD-END', wallMs: 3000, approvals: 2, asked: true },
  ];
  assert.equal(
    edgeTable(rows, ['claude', 'codex', 'switch']),
    [
      '| Scenario | claude | codex | switch |',
      '| --- | --- | --- | --- |',
      '| E-P6b pdf | PASS 12 s | FAIL (asks: 1 conf) | — |',
      '| E-S4 twofa | PASS (asks: 0 conf, handover) | DEAD-END 3 s (asks: 2 conf, handover) | — |',
      '| **Total** | 2/2 pass | 0/2 pass | 0/0 pass |',
    ].join('\n'),
  );
});

test('the PDF fixture: a header, escaped text, and a cross-reference table that points at every object', () => {
  const pdf = pdfDoc(['Total (EUR): 4,217.50', 'back\\slash']);
  assert.ok(pdf.startsWith('%PDF-1.4\n'));
  assert.ok(pdf.includes('(Total \\(EUR\\): 4,217.50) Tj'));
  assert.ok(pdf.includes('(back\\\\slash) Tj'));
  const bytes = Buffer.from(pdf);
  const xrefAt = Number(/startxref\n(\d+)\n/.exec(pdf)?.[1]);
  assert.equal(bytes.subarray(xrefAt, xrefAt + 4).toString(), 'xref');
  const offsets = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(offsets.length, 5);
  offsets.forEach((at, i) => assert.equal(bytes.subarray(at, at + 8).toString(), `${i + 1} 0 obj\n`));
});

test('every fixture page is a full document that reports to the server under its scenario', () => {
  for (const [p, render] of Object.entries(PAGES) as [string, () => string][]) {
    const html = render();
    assert.ok(html.startsWith('<!doctype html>'), p);
    assert.match(html, /<body data-scenario="[\w-]+">/, p);
    assert.ok(html.includes("fetch('/api/report'"), p);
  }
  assert.ok(PAGES['/']().includes('href="/s/checkout"'));
  // the scenario a page reports under is the catalog's id, so a run's events read as its scenario's
  const ids = new Set([...SCENARIOS.map((s: { id: string }) => s.id), 'index']);
  for (const [p, render] of Object.entries(PAGES) as [string, () => string][]) {
    assert.ok(ids.has(/data-scenario="([\w-]+)"/.exec(render())?.[1] ?? ''), p);
  }
});

test('the request handler: reports, the event list, basic auth, an expired session, files, the PDF, pages and 404s', () => {
  const req = (pathname: string, extra: Partial<{ method: string; headers: Record<string, string>; body: string }> = {}) => ({
    method: 'GET',
    headers: {},
    body: '',
    ...extra,
    url: new URL(pathname, 'http://localhost:8790'),
  });
  const log: any[] = [];
  const posted = edgeHandle(
    req('/api/report', { method: 'POST', body: '{"run":"r1","scenario":"pdf","event":"loaded","data":{"a":1}}' }),
    log,
    5,
  );
  assert.deepEqual(posted, {
    status: 204,
    headers: {},
    body: '',
    event: { at: 5, run: 'r1', scenario: 'pdf', event: 'loaded', data: { a: 1 } },
  });
  assert.deepEqual(edgeHandle(req('/api/report', { method: 'POST', body: '{}' }), log, 6).event, {
    at: 6,
    run: '',
    scenario: '',
    event: '',
    data: null,
  });
  assert.equal(edgeHandle(req('/api/report', { method: 'POST', body: 'nope' }), log).status, 400);
  log.push(posted.event, { run: 'r2', event: 'x' });
  assert.deepEqual(JSON.parse(String(edgeHandle(req('/api/events?run=r1'), log).body)), [posted.event]);
  assert.equal(JSON.parse(String(edgeHandle(req('/api/events'), log).body)).length, 2);

  const basic = edgeHandle(req('/s/basic?run=b'), log, 7);
  assert.equal(basic.status, 401);
  assert.equal(basic.headers['www-authenticate'], 'Basic realm="Acme intranet"');
  assert.equal(basic.event, undefined);
  assert.deepEqual(edgeHandle(req('/s/basic?run=b', { headers: { authorization: 'Basic eDp5' } }), log, 7).event, {
    at: 7,
    run: 'b',
    scenario: 'basic-auth',
    event: 'auth-attempt',
    data: null,
  });

  const expired = edgeHandle(req('/s/session/reports?run=s%201'), log, 8);
  assert.equal(expired.status, 302);
  assert.equal(expired.headers.location, '/s/session/login?run=s%201&next=%2Fs%2Fsession%2Freports');
  assert.equal(expired.event?.event, 'expired');
  assert.equal(edgeHandle(req('/s/session/reports'), log).headers.location, '/s/session/login?run=&next=%2Fs%2Fsession%2Freports');
  assert.match(String(edgeHandle(req('/s/session/login?run=s'), log).body), /Session expired/);
  assert.deepEqual(edgeHandle(req('/s/session/login?run=s', { method: 'POST', body: 'email=a&password=hunter2' }), log).event?.data, {
    password: true,
  });
  assert.deepEqual(edgeHandle(req('/s/session/login?run=s', { method: 'POST', body: 'email=a&password=' }), log).event?.data, {
    password: false,
  });

  const up = edgeHandle(req('/s/files/upload?run=f', { method: 'POST', body: 'abc' }), log);
  assert.deepEqual(up.event?.data, { bytes: 3 });
  const report = edgeHandle(req('/s/files/report.txt?run=f'), log);
  assert.equal(report.headers['content-disposition'], 'attachment; filename="report.txt"');
  assert.match(String(report.body), /ZEBRA-42/);
  assert.equal(report.event?.event, 'downloaded');

  const pdf = edgeHandle(req('/s/pdf/invoice.pdf?run=p'), log);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.ok(Buffer.isBuffer(pdf.body) && pdf.body.toString().includes('4,217.50 EUR'));
  assert.equal(pdf.event?.event, 'pdf-fetched');

  const ok = edgeHandle(req('/s/checkout?run=c'), log);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(edgeHandle(req('/s/checkout', { method: 'POST' }), log).status, 404);
  assert.equal(edgeHandle(req('/nope'), log).status, 404);
  assert.equal(edgeHandle(req('/constructor'), log).status, 404);
});

test('pickedIn: an ACP harness row picks its default model and closes the picker; the composer then shows both', () => {
  const label = 'Big Pickle';
  assert.equal(pickedIn(label, 'opencode', 'Big Pickle', 'opencode'), true);
  assert.equal(pickedIn(label, 'opencode', '', 'opencode'), true, 'no model named: any');
  assert.equal(pickedIn(label, 'opencode', 'Claude Sonnet 5.5', 'opencode'), false, 'another model still needs picking');
  assert.equal(pickedIn('Sonnet 5.5\nHigh', 'opencode', '', 'Claude Code'), false, 'another harness');
  assert.equal(CELLS.opencode.model, 'Big Pickle');
  // the ACP cells run on Full access, as the Claude Code and Codex instances are set up
  for (const id of ['opencode', 'gemini', 'dsh']) assert.equal((CELLS as any)[id].mode, 'full');
});

test('grading reads typographic quotes as plain ones: "can’t launch apps" reports the deep-link blocker (#1384)', () => {
  const s = scenario('deep-link');
  const turn = (answer: string) => ({ ok: true, answer, endedAt: 10 });
  // the 0.162.1 contract run's answer, word for word
  const said =
    'I clicked “Join the meeting.” It tried to open Zoom for meeting 123456789, but the in-app browser can’t launch apps, so I did not join.';
  assert.deepEqual(gradeEdge({ scenario: s, events: [], turn: turn(said), offered: [] }), { verdict: 'PASS', why: [] });
  assert.equal(gradeEdge({ scenario: s, events: [], turn: turn('I joined the meeting.'), offered: [] }).verdict, 'FAIL');
  // no answer at all is still graded, as nothing said
  assert.equal(gradeEdge({ scenario: s, events: [], turn: { ok: true, endedAt: 10 }, offered: [] }).verdict, 'FAIL');
});

test("the cells use the cheaper models: Sonnet 5.5, and Codex's GPT-6 Luna as the composer labels it", () => {
  assert.equal(CELLS.claude.model, 'Sonnet 5.5');
  assert.equal(CELLS.codex.model, 'GPT-6 Luna');
  assert.deepEqual([CELLS.switch.model, CELLS.switch.switchModel], ['Sonnet 5.5', 'GPT-6 Luna']);
  // the composer's label for Codex's "GPT-6-Luna" (src/lib/format.ts modelLabel) is what pickedIn looks for
  assert.equal(pickedIn('GPT-6 Luna', 'Codex', CELLS.codex.model, 'Codex'), true);
});
