// The parity edge scenarios (#1319, PW-*): their fixture pages and server routes, for edge.mjs and edgePages.mjs.

/** How long the stalled "Full report" holds its response open before it would complete. */
export const REPORT_STALL_MS = 90_000;

/** Items per colour on the catalog (PW-1): odd numbers, so a count in an answer is no coincidence. */
const CATALOG = { red: 17, blue: 23, green: 9 };

/** The two exports (PW-4): both download as report.csv, with different rows. */
export const EXPORTS = {
  1: 'id,city,units\n1,Porto,1203\n2,Faro,877\n3,Lisbon,4417\n4,Braga,610\n',
  2: 'id,city,units\n1,Bergen,2291\n2,Tromso,455\n3,Oslo,9902\n4,Bodo,318\n',
};

/**
 * The PW scenarios, in the Scenario shape of edge.mjs.
 * - PW-1 `stop-and-duplicate` (E-P15): a report that stalls after its headers must be stopped (the server sees the
 *   request go: report-aborted), and the catalog worked on in two tabs, one filter in each.
 * - PW-4 `download-prompt` (E-P2c): two downloads with one file name; the first one's third row is the answer.
 */
export const PARITY_SCENARIOS = [
  {
    id: 'stop-and-duplicate',
    edge: 'E-P15',
    title: 'Stop a stalled load, then work in a duplicated tab',
    path: '/s/stop',
    task:
      'On {url}, open the "Full report". It never finishes loading: stop it and go back to the catalog. Then duplicate ' +
      'the catalog tab, set the colour filter to red in the copy and to blue in the original, and tell me both item counts.',
    passAll: true,
    passOn: ['report-aborted', 'filter-red', 'filter-blue'],
    failOn: ['report-complete'],
    answer: [String(CATALOG.red), String(CATALOG.blue)],
  },
  {
    id: 'download-prompt',
    edge: 'E-P2c',
    title: 'Two downloads with the same file name',
    path: '/s/exports',
    task: 'On {url}, export both reports, then open the file the first export downloaded and tell me its third data row.',
    passAll: true,
    passOn: ['export-1', 'export-2'],
    answer: '4417',
  },
];

/** The catalog's script: a colour filter that shows its count and reports it. */
const CATALOG_SCRIPT = `const counts = ${JSON.stringify(CATALOG)};
const sel = document.getElementById('colour'), out = document.getElementById('count');
sel.onchange = () => {
  const n = counts[sel.value];
  out.textContent = n === undefined ? '' : 'Showing ' + n + ' ' + sel.value + ' items.';
  if (n !== undefined) report('filter-' + sel.value, { count: n });
};`;

/**
 * The PW fixture pages, by path, built with edgePages' page helper.
 * @param {(scenario: string, title: string, body: string, script?: string) => string} page
 */
export const parityPages = (page) => ({
  '/s/stop': () =>
    page(
      'stop-and-duplicate',
      'Catalog',
      `<p><label>Colour <select id="colour"><option value="">All</option><option value="red">Red</option><option value="blue">Blue</option><option value="green">Green</option></select></label></p>
<p id="count">Showing 49 items.</p><p><a data-keep href="/s/stop/report">Full report</a></p>`,
      CATALOG_SCRIPT,
    ),
  '/s/exports': () =>
    page(
      'download-prompt',
      'Exports',
      '<p><a data-keep href="/s/exports/1">Export Q1 report</a></p><p><a data-keep href="/s/exports/2">Export Q2 report</a></p>',
    ),
});

/**
 * The PW server routes: the stalled report (its headers now, the body only after REPORT_STALL_MS; `stall` names the
 * event for a request that goes first and for one that completes) and the two exports. Null for any other path.
 * @param {URL} url
 * @param {(scenario: string, event: string, data?: Record<string, unknown> | null) => Record<string, any>} at
 * @returns {{ status: number, headers: Record<string, string>, body: string, event: Record<string, any>,
 *   stall?: { ms: number, aborted: Record<string, any>, complete: Record<string, any> } } | null}
 */
export function parityHandle(url, at) {
  if (url.pathname === '/s/stop/report') {
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<!doctype html><title>Full report</title><h1>Full report</h1><p>All 49 items.</p>',
      stall: {
        ms: REPORT_STALL_MS,
        aborted: at('stop-and-duplicate', 'report-aborted'),
        complete: at('stop-and-duplicate', 'report-complete'),
      },
      event: at('stop-and-duplicate', 'report-started'),
    };
  }
  const exp = /^\/s\/exports\/([12])$/.exec(url.pathname);
  if (exp) {
    const n = /** @type {'1' | '2'} */ (exp[1]);
    return {
      status: 200,
      headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' },
      body: EXPORTS[n],
      event: at('download-prompt', `export-${n}`),
    };
  }
  return null;
}

/**
 * Holds a stalled answer open: its headers now, its body only after `stall.ms`. A request that goes first (the browser
 * stopped it or left the page) records `stall.aborted`; one that runs its course records `stall.complete`. `record`
 * logs an event, stamped when it happens.
 * @param {{ writeHead: Function, flushHeaders: Function, end: Function, on: Function }} res
 * @param {{ status: number, headers: Record<string, string>, body: string | Buffer,
 *   stall: { ms: number, aborted: Record<string, any>, complete: Record<string, any> } }} out
 * @param {(event: Record<string, any>) => void} record
 */
export function holdStalled(res, out, record, timers = { setTimeout, clearTimeout }, now = Date.now) {
  res.writeHead(out.status, { 'cache-control': 'no-store', ...out.headers });
  res.flushHeaders();
  let settled = false;
  const timer = timers.setTimeout(() => {
    settled = true;
    record({ ...out.stall.complete, at: now() });
    res.end(out.body);
  }, out.stall.ms);
  res.on('close', () => {
    if (settled) return;
    settled = true;
    timers.clearTimeout(timer);
    record({ ...out.stall.aborted, at: now() });
  });
}
