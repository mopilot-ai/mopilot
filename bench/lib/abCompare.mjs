// bench/lib/abCompare.mjs: the pure parts of bench/ab-compare (MoPilot vs Vercel agent-browser): reading snapshots, scoring fixture cases, building and rendering the report.
import path from 'node:path';

/** Pages measured by default: key, URL. */
export const DEFAULT_PAGES = {
  hn: 'https://news.ycombinator.com',
  wiki: 'https://en.wikipedia.org/wiki/Web_browser',
  gh: 'https://github.com/vercel-labs/agent-browser',
  mdn: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input',
  bbc: 'https://www.bbc.com/news',
  apple: 'https://www.apple.com/shop/buy-mac/macbook-air',
  npm: 'https://www.npmjs.com/package/agent-browser',
  so: 'https://stackoverflow.com/questions/tagged/javascript',
  ghissues: 'https://github.com/microsoft/playwright/issues',
  airbnb: 'https://www.airbnb.com',
};

/**
 * The fixture cases, in report order. `label` is the control's visible name (looked up in each tool's snapshot),
 * `kind` what the case checks: `click` (the click must produce `expect`), `refuse` (the click must NOT produce
 * `forbid`), `absent` (the label must not be listed), `listed` (the label must have a ref).
 */
export const FIXTURE_CASES = [
  { id: 'covered', title: 'Covered button', label: 'Covered button', kind: 'refuse', forbid: 'covered' },
  { id: 'hidden', title: 'Hidden button', label: 'Hidden button', kind: 'absent' },
  { id: 'onclick-div', title: 'onclick div', label: 'Clickable div', kind: 'click', expect: 'divclick' },
  { id: 'role-button', title: 'role=button custom element', label: 'ARIA button', kind: 'click', expect: 'aria' },
  { id: 'contenteditable', title: 'contenteditable', label: 'Editable area', kind: 'listed' },
  { id: 'open-shadow', title: 'Open shadow root', label: 'Open shadow button', kind: 'click', expect: 'open-shadow' },
  { id: 'closed-shadow', title: 'Closed shadow root', label: 'Closed shadow button', kind: 'click', expect: 'closed-shadow' },
  { id: 'cross-site-iframe', title: 'Cross-site iframe', label: 'Frame button', kind: 'click', expect: 'frame' },
  {
    id: 'closed-shadow-iframe',
    title: 'Closed shadow root in a cross-site iframe',
    label: 'Frame closed button',
    kind: 'click',
    expect: 'frame-closed',
  },
  { id: 'rerender-same', title: 'Re-render, same role and name', label: 'Save', kind: 'click', expect: 'save-new', rerender: 'swapSame()' },
  {
    id: 'rerender-different',
    title: 'Re-render, different element (must refuse)',
    label: 'Submit',
    kind: 'refuse',
    forbid: 'DELETE',
    rerender: 'swapOther()',
  },
];

/**
 * WebMCP cases (#3571, G6) on fixture/webmcp.html: the page's tools are listed (one is registered after load), and one
 * runs with its params and changes the page. Their results join the fixture table.
 */
export const WEBMCP_CASES = [
  {
    id: 'webmcp-list',
    title: 'WebMCP: page tools listed (one late)',
    kind: 'webmcp-list',
    expect: ['add_to_cart', 'search_catalog', 'later_tool'],
  },
  {
    id: 'webmcp-invoke',
    title: 'WebMCP: call a page tool',
    kind: 'webmcp-invoke',
    tool: 'add_to_cart',
    params: { sku: 'A1' },
    expect: 'cart-A1',
  },
];

/** The tool names in a WebMCP listing's text (JSON or not): every "name": "..." in it. */
export function webMcpNames(text) {
  return [...new Set([...String(text || '').matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]))];
}

/** One pass/fail for a WebMCP case. `observed`: { names, marker, error? }. */
export function scoreWebMcp(c, observed) {
  if (observed.error) return { pass: false, note: `error: ${String(observed.error).slice(0, 80)}` };
  if (c.kind === 'webmcp-list') {
    const missing = c.expect.filter((n) => !observed.names.includes(n));
    return { pass: !missing.length, note: missing.length ? `missing ${missing.join(', ')}` : `${observed.names.length} listed` };
  }
  return { pass: observed.marker === c.expect, note: observed.marker === c.expect ? 'ran' : `marker ${observed.marker}` };
}

/** The command line: `--pages default|key,key|url,url`, `--out dir`, `--latest`, `--observe-only` (only the observability rows), `--help`. */
export function parseArgs(argv) {
  const opts = { pages: 'default', out: path.resolve('bench/ab-compare/out'), latest: false, observeOnly: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--latest') opts.latest = true;
    else if (a === '--observe-only') opts.observeOnly = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--pages' || a === '--out') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`);
      if (a === '--pages') opts.pages = v;
      else opts.out = path.resolve(v);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

/** `default` or a comma list of known keys and URLs → [{ key, url }]. */
export function resolvePages(spec) {
  if (spec === 'default') return Object.entries(DEFAULT_PAGES).map(([key, url]) => ({ key, url }));
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) =>
      DEFAULT_PAGES[s] ? { key: s, url: DEFAULT_PAGES[s] } : { key: s.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-'), url: s },
    );
}

const AB_REF = /\[ref=(e\d+)\]/;
const OUR_REF = /\[(ref_\d+)\]/;

/** Number of refs in an agent-browser snapshot (`[ref=e12]`) or in ours (`[ref_12]`). */
export function countRefs(text, tool) {
  const re = tool === 'ab' ? /\[ref=e\d+\]/g : /\[ref_\d+\]/g;
  return (text.match(re) || []).length;
}

/** The ref of the first line that names `label` (as a quoted name or as the text of the line), or null. */
export function findRef(text, label, tool) {
  const quoted = `"${label}"`;
  for (const line of text.split('\n')) {
    if (!line.includes(quoted)) continue;
    const m = (tool === 'ab' ? AB_REF : OUR_REF).exec(line);
    if (m) return m[1];
  }
  return null;
}

/** Page text of the fixture's click counter → the last click's marker (`none` when nothing was clicked). */
export function clickMarker(counterText) {
  return /clicks:\s*(\S+)/.exec(counterText || '')?.[1] ?? 'unreadable';
}

/**
 * One pass/fail for a fixture case. `observed` is { ref, marker, refused }: the ref found for the label
 * (null when not listed), the counter marker after the click attempt, and whether the tool refused to click.
 */
export function scoreCase(c, observed) {
  const { ref, marker } = observed;
  if (c.kind === 'absent') return { pass: ref === null, note: ref === null ? 'not listed' : `listed as ${ref}` };
  if (ref === null) return { pass: false, note: 'not listed' };
  if (c.kind === 'listed') return { pass: true, note: `listed as ${ref}` };
  if (c.kind === 'click')
    return {
      pass: marker === c.expect,
      note: marker === c.expect ? 'clicked' : observed.refused ? 'refused (stale or blocked)' : `marker ${marker}`,
    };
  if (marker === c.forbid) return { pass: false, note: `wrongly acted: ${marker}` };
  return { pass: true, note: observed.refused ? 'refused' : 'no action' };
}

/** A tool's truncation of a page: ours reports a flag; agent-browser's output has no marker, so it is false. */
export function anyTruncated(frameResults) {
  return frameResults.some((r) => r && r.truncated === true);
}

/** One page's row from the raw measurements ({ text, ms, truncated?, error? } per mode). Counts go through `count`. */
export function pageRow(key, url, raw, count) {
  const mode = (m) =>
    m && !m.error
      ? { tokens: count(m.text), refs: countRefs(m.text, m.tool), ms: m.ms, truncated: m.truncated === true }
      : { error: m?.error || 'missing' };
  return {
    key,
    url,
    ours: { interactive: mode(raw.oursInteractive), all: mode(raw.oursAll) },
    ab: { i: mode(raw.abI), iu: mode(raw.abIU), c: mode(raw.abC) },
  };
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** Totals over the pages where every mode measured: tokens per mode and our default-look ratio against `ab -i`. */
export function totals(rows) {
  const ok = rows.filter((r) => [r.ours.interactive, r.ours.all, r.ab.i, r.ab.iu, r.ab.c].every((m) => m.tokens !== undefined));
  const t = (pick) => sum(ok.map((r) => pick(r).tokens));
  const out = {
    pages: ok.length,
    oursInteractive: t((r) => r.ours.interactive),
    oursAll: t((r) => r.ours.all),
    abI: t((r) => r.ab.i),
    abIU: t((r) => r.ab.iu),
    abC: t((r) => r.ab.c),
  };
  out.ratioInteractive = out.oursInteractive ? Math.round((out.abI / out.oursInteractive) * 100) / 100 : null;
  return out;
}

/** The tool schemas a model carries: every spec whose name starts with `prefix`, as the compact JSON the model is sent. */
export function renderSpecs(specs, prefix = 'browser_') {
  return JSON.stringify(Object.fromEntries(Object.entries(specs).filter(([name]) => name.startsWith(prefix))));
}

/** Fixed context cost: { ours, ab, ratio } from the two token counts. */
export function contextCost(oursTokens, abTokens) {
  return { oursTokens, abTokens, ratio: abTokens ? Math.round((oursTokens / abTokens) * 100) / 100 : null };
}

const fmt = (m) => (m.error ? `err` : `${m.tokens}`);
const mark = (r) => (r.pass ? 'PASS' : 'FAIL');

/** The report as markdown, the table posted to the tracking issue. */
export function toMarkdown(report) {
  const L = [];
  L.push(`### agent-browser ${report.abVersion} vs MoPilot (${report.date})`, '');
  L.push('**Tokens per page (o200k)**', '');
  L.push('| page | ours -i | ours all | ab -i | ab -i -u | ab -c | refs ours/ab | ours ms | truncated |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|:-:|');
  for (const r of report.pages) {
    const refs = r.ours.interactive.error || r.ab.i.error ? '-' : `${r.ours.interactive.refs}/${r.ab.i.refs}`;
    L.push(
      `| ${r.key} | ${fmt(r.ours.interactive)} | ${fmt(r.ours.all)} | ${fmt(r.ab.i)} | ${fmt(r.ab.iu)} | ${fmt(r.ab.c)} | ${refs} | ${r.ours.interactive.ms ?? '-'} | ${r.ours.interactive.truncated ? 'yes' : 'no'} |`,
    );
  }
  const t = report.totals;
  L.push(`| **total (${t.pages} pages)** | ${t.oursInteractive} | ${t.oursAll} | ${t.abI} | ${t.abIU} | ${t.abC} | | | |`, '');
  if (t.ratioInteractive) L.push(`Default look: agent-browser \`-i\` costs ${t.ratioInteractive}x our interactive look.`, '');
  if (!report.fixture.length) return L.join('\n');
  L.push('**Fixture** (one click or check per case)', '');
  L.push('| case | ours | agent-browser |', '|---|---|---|');
  for (const c of report.fixture) L.push(`| ${c.title} | ${mark(c.ours)} (${c.ours.note}) | ${mark(c.ab)} (${c.ab.note}) |`);
  L.push('');
  const k = report.context;
  L.push(
    `**Fixed context cost (o200k):** our \`browser_*\` schemas ${k.oursTokens}, agent-browser \`skills get core\` ${k.abTokens} (${k.ratio}x).`,
    '',
  );
  return L.join('\n');
}
