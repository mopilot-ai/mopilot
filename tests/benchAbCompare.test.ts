// bench/lib/abCompare.mjs: argument parsing, snapshot reading, fixture scoring and the report of the agent-browser head-to-head.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  DEFAULT_PAGES,
  FIXTURE_CASES,
  anyTruncated,
  clickMarker,
  contextCost,
  countRefs,
  findRef,
  pageRow,
  parseArgs,
  renderSpecs,
  resolvePages,
  scoreCase,
  toMarkdown,
  totals,
} from '../bench/lib/abCompare.mjs';

const caseOf = (id: string) => FIXTURE_CASES.find((c) => c.id === id) as (typeof FIXTURE_CASES)[number];

test('parseArgs reads pages, out and latest, and rejects the rest', () => {
  assert.deepEqual(parseArgs([]), {
    pages: 'default',
    out: path.resolve('bench/ab-compare/out'),
    latest: false,
    observeOnly: false,
    help: false,
  });
  const o = parseArgs(['--pages', 'hn,wiki', '--out', 'x/y', '--latest', '-h']);
  assert.equal(o.pages, 'hn,wiki');
  assert.equal(o.out, path.resolve('x/y'));
  assert.equal(o.latest, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['--observe-only']).observeOnly, true);
  assert.throws(() => parseArgs(['--pages']), /needs a value/);
  assert.throws(() => parseArgs(['--out', '--latest']), /needs a value/);
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
});

test('resolvePages expands default, keys and urls', () => {
  assert.equal(resolvePages('default').length, Object.keys(DEFAULT_PAGES).length);
  assert.deepEqual(resolvePages('hn, https://example.com/a?b=1,'), [
    { key: 'hn', url: DEFAULT_PAGES.hn },
    { key: 'example-com-a-b-1', url: 'https://example.com/a?b=1' },
  ]);
});

test('countRefs and findRef read both tools snapshot formats', () => {
  const ab = '- button "Save" [ref=e12]\n- link "Save as" [ref=e13]\n- text "Save"';
  const ours = '- button "Save" [ref_4]\n  - link "More" [ref_5]';
  assert.equal(countRefs(ab, 'ab'), 2);
  assert.equal(countRefs(ours, 'ours'), 2);
  assert.equal(countRefs('nothing', 'ab'), 0);
  assert.equal(findRef(ab, 'Save', 'ab'), 'e12');
  assert.equal(findRef(ours, 'More', 'ours'), 'ref_5');
  assert.equal(findRef(ab, 'Missing', 'ab'), null);
  assert.equal(findRef('- button "Save"', 'Save', 'ab'), null);
});

test('clickMarker reads the counter', () => {
  assert.equal(clickMarker('clicks: save-new'), 'save-new');
  assert.equal(clickMarker('clicks: none'), 'none');
  assert.equal(clickMarker(''), 'unreadable');
  assert.equal(clickMarker(undefined as unknown as string), 'unreadable');
});

test('scoreCase judges each kind of case', () => {
  const hidden = caseOf('hidden');
  assert.deepEqual(scoreCase(hidden, { ref: null, marker: 'none', refused: false }), { pass: true, note: 'not listed' });
  assert.deepEqual(scoreCase(hidden, { ref: 'e1', marker: 'none', refused: false }), { pass: false, note: 'listed as e1' });
  const listed = caseOf('contenteditable');
  assert.deepEqual(scoreCase(listed, { ref: null, marker: 'none', refused: false }), { pass: false, note: 'not listed' });
  assert.deepEqual(scoreCase(listed, { ref: 'e2', marker: 'none', refused: false }), { pass: true, note: 'listed as e2' });
  const click = caseOf('rerender-same');
  assert.deepEqual(scoreCase(click, { ref: 'e3', marker: 'save-new', refused: false }), { pass: true, note: 'clicked' });
  assert.deepEqual(scoreCase(click, { ref: 'e3', marker: 'none', refused: true }), { pass: false, note: 'refused (stale or blocked)' });
  assert.deepEqual(scoreCase(click, { ref: 'e3', marker: 'save-old', refused: false }), { pass: false, note: 'marker save-old' });
  const refuse = caseOf('rerender-different');
  assert.deepEqual(scoreCase(refuse, { ref: 'e4', marker: 'DELETE', refused: false }), { pass: false, note: 'wrongly acted: DELETE' });
  assert.deepEqual(scoreCase(refuse, { ref: 'e4', marker: 'none', refused: true }), { pass: true, note: 'refused' });
  assert.deepEqual(scoreCase(refuse, { ref: 'e4', marker: 'none', refused: false }), { pass: true, note: 'no action' });
});

test('anyTruncated looks for a truncated result', () => {
  assert.equal(anyTruncated([null, { truncated: false }]), false);
  assert.equal(anyTruncated([{ truncated: false }, { truncated: true }]), true);
});

const count = (t: string) => t.length;
const raw = (text: string, tool: string, extra = {}) => ({ text, tool, ms: 5, ...extra });
const goodRaw = {
  oursInteractive: raw('- link "a" [ref_1]', 'ours', { truncated: true }),
  oursAll: raw('- link "a" [ref_1]\n- text', 'ours'),
  abI: raw('- link "a" [ref=e1]\n- link "b" [ref=e2]', 'ab'),
  abIU: raw('- link "a" [ref=e1] url', 'ab'),
  abC: raw('- x', 'ab'),
};

test('pageRow counts tokens and refs, and records errors', () => {
  const row = pageRow('k', 'u', goodRaw, count);
  assert.equal(row.ours.interactive.tokens, 18);
  assert.equal(row.ours.interactive.truncated, true);
  assert.equal(row.ours.all.truncated, false);
  assert.equal(row.ab.i.refs, 2);
  const bad = pageRow('k', 'u', { ...goodRaw, abI: { error: 'timeout' }, oursAll: undefined }, count);
  assert.deepEqual(bad.ab.i, { error: 'timeout' });
  assert.deepEqual(bad.ours.all, { error: 'missing' });
});

test('totals sums only fully measured pages, and handles none', () => {
  const ok = pageRow('a', 'u', goodRaw, count);
  const bad = pageRow('b', 'u', { ...goodRaw, abC: { error: 'x' } }, count);
  const t = totals([ok, bad]);
  assert.equal(t.pages, 1);
  assert.equal(t.abI, ok.ab.i.tokens);
  assert.equal(t.ratioInteractive, Math.round((t.abI / t.oursInteractive) * 100) / 100);
  assert.equal(totals([]).ratioInteractive, null);
  assert.equal(
    totals([{ ...ok, ours: { ...ok.ours, interactive: { tokens: 0, refs: 0, ms: 1, truncated: false } } }]).ratioInteractive,
    null,
  );
});

test('renderSpecs keeps only the prefixed specs, compactly', () => {
  const text = renderSpecs({ browser_a: { d: 1 }, computer_b: { d: 2 }, browser_c: { d: 3 } });
  assert.equal(text, '{"browser_a":{"d":1},"browser_c":{"d":3}}');
  assert.equal(renderSpecs({ x_a: 1 }, 'x_'), '{"x_a":1}');
});

test('contextCost gives the ratio, or null without a baseline', () => {
  assert.deepEqual(contextCost(6600, 3300), { oursTokens: 6600, abTokens: 3300, ratio: 2 });
  assert.equal(contextCost(1, 0).ratio, null);
});

test('toMarkdown renders pages, the fixture and the context cost', () => {
  const ok = pageRow('a', 'u', goodRaw, count);
  const bad = pageRow('b', 'u', { ...goodRaw, abI: { error: 'timeout' } }, count);
  const report = {
    date: '2026-11-04',
    abVersion: '0.41.2',
    pages: [ok, bad],
    totals: totals([ok, bad]),
    fixture: [{ title: 'Covered button', ours: { pass: true, note: 'refused' }, ab: { pass: false, note: 'marker covered' } }],
    context: contextCost(6600, 3300),
  };
  const md = toMarkdown(report);
  assert.match(md, /agent-browser 0\.41\.2 vs MoPilot \(2026-11-04\)/);
  assert.match(md, /\| a \| 18 \| 25 \|/);
  assert.match(md, /\| b \| 18 \| 25 \| err \|/);
  assert.match(md, /\| Covered button \| PASS \(refused\) \| FAIL \(marker covered\) \|/);
  assert.match(md, /Default look: agent-browser `-i` costs/);
  assert.match(md, /schemas 6600, agent-browser `skills get core` 3300 \(2x\)/);
  const noOurs = pageRow('c', 'u', { ...goodRaw, oursInteractive: { error: 'x' } }, count);
  assert.match(toMarkdown({ ...report, pages: [noOurs] }), /\| c \| err \| 25 \| 39 \| 23 \| 3 \| - \| - \| no \|/);
  const none = toMarkdown({ ...report, pages: [], totals: totals([]) });
  assert.doesNotMatch(none, /Default look/);
  // --observe-only: no fixture cases ran, so the report stops before them
  const observeOnly = toMarkdown({ ...report, pages: [], totals: totals([]), fixture: [] });
  assert.doesNotMatch(observeOnly, /Fixture|Fixed context cost/);
});

test('WebMCP cases (#3571 G6): names come out of any listing, and each case passes only on its own evidence', async () => {
  const { WEBMCP_CASES, webMcpNames, scoreWebMcp } = await import('../bench/lib/abCompare.mjs');
  assert.deepEqual(webMcpNames('{"tools":[{"name": "a"},{"name":"b"},{"name":"a"}]}'), ['a', 'b']);
  assert.deepEqual(webMcpNames(undefined), []);
  const [list, invoke] = WEBMCP_CASES;
  assert.deepEqual(scoreWebMcp(list, { names: ['add_to_cart', 'search_catalog', 'later_tool'], marker: 'none' }), {
    pass: true,
    note: '3 listed',
  });
  assert.deepEqual(scoreWebMcp(list, { names: ['add_to_cart'], marker: 'none' }), {
    pass: false,
    note: 'missing search_catalog, later_tool',
  });
  assert.deepEqual(scoreWebMcp(invoke, { names: [], marker: 'cart-A1' }), { pass: true, note: 'ran' });
  assert.deepEqual(scoreWebMcp(invoke, { names: [], marker: 'none' }), { pass: false, note: 'marker none' });
  assert.deepEqual(scoreWebMcp(invoke, { error: 'webmcp_unsupported' }), { pass: false, note: 'error: webmcp_unsupported' });
});
