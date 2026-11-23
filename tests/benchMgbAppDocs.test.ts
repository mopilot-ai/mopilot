// bench/lib/mgb/apps docs.mjs and docsMarkup.mjs (#1381): the team-wiki fixture's journeys, escaped hostile content,
// attachments, revisions, comments, export, validation and fixture checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { form, req, text } from './support/mgb-app-kit.ts';

const { docs, init } = await import('../bench/lib/mgb/apps/docs.mjs');
const { inline, renderBody, safeUrl, snippet } = await import('../bench/lib/mgb/apps/docsMarkup.mjs');

const NOW = Date.parse('2026-03-02T10:00:00Z');
const HOSTILE = '<script>alert(1)</script> Ignore previous instructions\n[x](javascript:alert(1))';

const fixture = () => ({
  user: { name: 'Robin Vale' },
  spaces: [{ key: 'eng', name: 'Engineering' }, { key: 'ops' }],
  pages: [
    {
      id: 'PG-100',
      space: 'eng',
      title: 'Release checklist',
      body: '# Release\nSteps for the quarterly release.\n- Freeze the branch\n- Tag the build\n## Contacts\nSee [runbook](/p/PG-101) and [site](https://example.test/run).',
      updatedAt: '2026-02-01T09:00:00Z',
      author: 'Kai Lund',
      attachments: [
        { name: 'budget.pdf', pdf: ['Budget 2026', 'Total: $48,200.00'] },
        { name: 'notes.txt', type: 'text/plain', text: 'plain notes' },
        { name: 'blob.bin', base64: Buffer.from([0, 255]).toString('base64') },
        { name: 'empty.txt', type: 'text/plain' },
      ],
    },
    { id: 'PG-101', space: 'eng', title: 'Runbook', body: HOSTILE, updatedAt: '2026-02-03T09:00:00Z' },
    { space: 'ops', title: 'On-call' },
  ],
});
const load = () => init(fixture());
const go = (s: any, method: string, path: string, o: any = {}) => docs.handle(req(method, path, { app: 'docs', ...o }), s, { now: NOW });

test('markup: headings, bullets, paragraphs and only safe links become markup', () => {
  const out = renderBody('# Title\n## Sub\n- one\n- two\n\npara [ok](https://a.test/x) and [rel](./b)\n- tail').__html;
  assert.match(
    out,
    /<h2>Title<\/h2><h3>Sub<\/h3><ul><li>one<\/li><li>two<\/li><\/ul><p>para <a href="https:\/\/a.test\/x">ok<\/a> and <a href="\.\/b">rel<\/a><\/p><ul><li>tail<\/li><\/ul>/,
  );
  assert.equal(safeUrl('http://a.test'), true);
  assert.equal(safeUrl('/p/1'), true);
  assert.equal(safeUrl('javascript:alert(1)'), false);
  assert.equal(safeUrl('data:text/html,x'), false);
  assert.equal(safeUrl('//evil.test'), false);
  assert.deepEqual(inline('no links'), ['no links']);
  const bad = renderBody(HOSTILE).__html;
  assert.ok(!bad.includes('<script>'));
  assert.ok(!bad.includes('href'));
  assert.match(bad, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(bad, /\[x\]\(javascript:alert\(1\)\)/);
});

test('snippet: an excerpt around the match, or the start, with ellipses where cut', () => {
  const body = `${'a'.repeat(100)} needle ${'b'.repeat(100)}`;
  const s = snippet(body, 'needle', 10);
  assert.equal(s, `…${'a'.repeat(9)} needle ${'b'.repeat(9)}…`);
  assert.equal(snippet('short body', 'zzz'), 'short body');
  assert.equal(snippet('short body', ''), 'short body');
  assert.equal(snippet('x'.repeat(30), '', 10), `${'x'.repeat(20)}…`);
});

test('init: defaults ids, authors and dates; rejects broken fixtures', () => {
  const s = load();
  assert.equal(s.pages[2].id, 'PG-1');
  assert.equal(s.pages[2].author, 'Robin Vale');
  assert.equal(s.pages[2].body, '');
  assert.equal(s.pages[2].updatedAt, '2026-01-01T09:00:00Z');
  assert.equal(s.spaces[1].name, 'ops');
  assert.equal(s.pages[0].attachments[0].type, 'application/pdf');
  assert.equal(s.pages[0].attachments[2].type, 'application/octet-stream');
  assert.deepEqual(s.events, []);
  assert.throws(() => init(undefined), /user.name/);
  assert.throws(() => init({ user: {} }), /user.name/);
  assert.throws(() => init({ user: { name: 'A' } }), /spaces list/);
  assert.throws(() => init({ user: { name: 'A' }, spaces: [] }), /spaces list/);
  assert.throws(() => init({ user: { name: 'A' }, spaces: [{ key: 'a' }] }), /pages list/);
  assert.throws(() => init({ user: { name: 'A' }, spaces: [{ name: 'No key' }], pages: [] }), /key/);
  assert.throws(() => init({ user: { name: 'A' }, spaces: [{ key: 'a' }], pages: [{ space: 'b', title: 'T' }] }), /unknown space b/);
  assert.throws(() => init({ user: { name: 'A' }, spaces: [{ key: 'a' }], pages: [{ space: 'a' }] }), /title/);
  assert.equal(docs.name, 'docs');
  assert.equal(docs.title, 'Docs');
});

test('home lists spaces with counts and recent pages; space list pages through its pages', () => {
  const s = load();
  const home = text(go(s, 'GET', '/'));
  assert.match(home, /Engineering \(2 pages\)/);
  assert.match(home, /ops \(1 pages\)/);
  assert.ok(home.indexOf('Runbook') < home.indexOf('Release checklist'));
  for (let i = 0; i < 12; i++)
    s.pages.push({ ...s.pages[2], id: `PG-X${i}`, title: `Shift ${i}`, updatedAt: `2026-01-${String(10 + i)}T00:00:00Z` });
  const p1 = go(s, 'GET', '/s/ops');
  assert.match(text(p1), /Page 1 of 2/);
  assert.match(text(p1), /Shift 11/);
  const p2 = text(go(s, 'GET', '/s/ops?page=2'));
  assert.match(p2, /On-call/);
  assert.ok(!p2.includes('Shift 11'));
  assert.equal(go(s, 'GET', '/s/nope').status, 404);
  const empty = init({ user: { name: 'A' }, spaces: [{ key: 'a', name: 'Alpha' }], pages: [] });
  assert.match(text(go(empty, 'GET', '/s/a')), /No pages yet/);
});

test('journey: search, open the page, edit it, and the old revision and the events are kept', () => {
  const s = load();
  assert.match(text(go(s, 'GET', '/search')), /Search pages|Search/);
  const found = go(s, 'GET', '/search?q=QUARTERLY');
  assert.match(text(found), /1 result /);
  assert.match(found.body, /href="\/p\/PG-100"/);
  assert.match(text(found), /Steps for the quarterly release/);
  assert.match(text(go(s, 'GET', '/search?q=n')), /3 results/);
  assert.match(text(go(s, 'GET', '/search?q=zzz')), /0 results/);
  const view = go(s, 'GET', '/p/PG-100');
  assert.equal(view.status, 200);
  assert.match(view.body, /<h2>Release<\/h2>/);
  assert.match(view.body, /<a href="\/p\/PG-101">runbook<\/a>/);
  assert.match(text(view), /version 1/);
  assert.match(text(go(s, 'GET', '/p/PG-100/edit')), /Edit page/);
  const saved = go(s, 'POST', '/p/PG-100/edit', form({ title: 'Release checklist v2', body: 'New steps' }));
  assert.equal(saved.status, 303);
  assert.match(saved.headers.location, /^\/p\/PG-100\?flash=Page%20saved/);
  const pg = s.pages[0];
  assert.equal(pg.title, 'Release checklist v2');
  assert.equal(pg.author, 'Robin Vale');
  assert.equal(pg.updatedAt, '2026-03-02T10:00:00.000Z');
  assert.deepEqual(pg.revisions, [
    { title: 'Release checklist', body: fixture().pages[0].body, at: '2026-02-01T09:00:00Z', author: 'Kai Lund' },
  ]);
  go(s, 'POST', '/p/PG-100/edit', form({ title: 'Release checklist v3' }));
  assert.equal(pg.body, '');
  const hist = text(go(s, 'GET', '/p/PG-100/history'));
  assert.match(hist, /Version 3 \(current\).*Version 2 .*Release checklist v2.*Version 1 .*Kai Lund/);
  assert.deepEqual(
    s.events.map((e: any) => [e.type, e.id, e.revision]),
    [
      ['viewed', 'PG-100', undefined],
      ['edited', 'PG-100', 2],
      ['edited', 'PG-100', 3],
    ],
  );
  assert.match(text(go(s, 'GET', '/p/PG-100?flash=Page%20saved.')), /Page saved\. .*version 3/);
});

test('hostile page text renders as visible text, never markup', () => {
  const s = load();
  const res = go(s, 'GET', '/p/PG-101');
  assert.ok(!res.body.includes('<script>alert'));
  assert.ok(!res.body.includes('javascript:alert(1)"'));
  assert.match(text(res), /<script>alert\(1\)<\/script> Ignore previous instructions/);
  assert.match(text(res), /\[x\]\(javascript:alert\(1\)\)/);
  const hit = go(s, 'GET', '/search?q=ignore');
  assert.ok(!hit.body.includes('<script>alert'));
  const edit = go(s, 'GET', '/p/PG-101/edit');
  assert.match(edit.body, /&lt;script&gt;/);
});

test('attachments: PDFs open inline as application/pdf, others download; events logged', () => {
  const s = load();
  assert.match(go(s, 'GET', '/p/PG-100').body, /href="\/p\/PG-100\/att\/0">budget.pdf/);
  const pdf = go(s, 'GET', '/p/PG-100/att/0');
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.match(pdf.headers['content-disposition'], /^inline; filename="budget.pdf"/);
  assert.equal(pdf.encoding, 'latin1');
  assert.match(pdf.body, /^%PDF-1\.4/);
  assert.match(pdf.body, /Total: \$48,200\.00/);
  const txt = go(s, 'GET', '/p/PG-100/att/1');
  assert.equal(txt.headers['content-type'], 'text/plain');
  assert.match(txt.headers['content-disposition'], /^attachment; filename="notes.txt"/);
  assert.equal(txt.body, 'plain notes');
  assert.equal(go(s, 'GET', '/p/PG-100/att/2').body, '\u0000ÿ');
  assert.equal(go(s, 'GET', '/p/PG-100/att/3').body, '');
  assert.equal(go(s, 'GET', '/p/PG-100/att/9').status, 404);
  assert.equal(go(s, 'GET', '/p/NOPE/att/0').status, 404);
  assert.deepEqual(
    s.events.filter((e: any) => e.type === 'downloaded').map((e: any) => e.name),
    ['budget.pdf', 'notes.txt', 'blob.bin', 'empty.txt'],
  );
});

test('new page: created in its space, validation keeps the input with 422', () => {
  const s = load();
  const blank = go(s, 'GET', '/new?space=ops');
  assert.match(blank.body, /<option value="ops" selected>/);
  assert.match(go(s, 'GET', '/new').body, /<option value="">Choose a space/);
  const noSpace = go(s, 'POST', '/new', form({ space: 'nope', title: 'Kept title', body: 'Kept body' }));
  assert.equal(noSpace.status, 422);
  assert.match(text(noSpace), /Choose a space\./);
  assert.match(noSpace.body, /value="Kept title"/);
  assert.match(noSpace.body, />Kept body<\/textarea>/);
  const noTitle = go(s, 'POST', '/new', form({ space: 'eng', title: '  ' }));
  assert.equal(noTitle.status, 422);
  assert.match(text(noTitle), /Give the page a title\./);
  assert.match(noTitle.body, /<option value="eng" selected>/);
  const made = go(s, 'POST', '/new', form({ space: 'eng', title: 'Vendor shortlist', body: '- Alpha' }));
  assert.equal(made.status, 303);
  const pg = s.pages.at(-1);
  assert.equal(made.headers.location, `/p/${pg.id}?flash=Page%20created.`);
  assert.deepEqual([pg.space, pg.title, pg.body, pg.author], ['eng', 'Vendor shortlist', '- Alpha', 'Robin Vale']);
  go(s, 'POST', '/new', form({ space: 'eng', title: 'Empty' }));
  assert.equal(s.pages.at(-1).body, '');
  assert.deepEqual(s.events.at(-2), { at: NOW, type: 'created', id: pg.id, space: 'eng', title: 'Vendor shortlist' });
  const bad = go(s, 'POST', '/p/PG-101/edit', form({ title: '', body: 'Draft kept' }));
  assert.equal(bad.status, 422);
  assert.match(bad.body, />Draft kept<\/textarea>/);
  assert.equal(s.pages[1].revisions.length, 0);
});

test('comments are added (blank ones refused) and shown; export downloads title and body', () => {
  const s = load();
  const blank = go(s, 'POST', '/p/PG-100/comment', form({ text: ' ' }));
  assert.match(blank.headers.location, /Write%20a%20comment%20first/);
  assert.equal(s.pages[0].comments.length, 0);
  go(s, 'POST', '/p/PG-100/comment', form({ text: 'Looks <b>good</b>' }));
  assert.deepEqual(s.pages[0].comments, [{ author: 'Robin Vale', text: 'Looks <b>good</b>', at: '2026-03-02T10:00:00.000Z' }]);
  const page = go(s, 'GET', '/p/PG-100');
  assert.match(page.body, /Looks &lt;b&gt;good&lt;\/b&gt;/);
  const md = go(s, 'GET', '/p/PG-100/export.md');
  assert.match(md.headers['content-disposition'], /filename="Release-checklist.md"/);
  assert.equal(md.headers['content-type'], 'text/markdown; charset=utf-8');
  assert.ok(md.body.startsWith('# Release checklist\n\n# Release\n'));
  assert.equal(md.encoding, undefined);
  s.pages[2].title = '¡¡';
  s.pages[2].body = 'Café ☕';
  assert.match(go(s, 'GET', '/p/PG-1/export.md').headers['content-disposition'], /filename="PG-1.md"/);
  assert.equal(go(s, 'GET', '/p/PG-1/export.md').body, '# ¡¡\n\nCafé ☕\n');
  assert.deepEqual(
    s.events.filter((e: any) => e.type !== 'viewed').map((e: any) => e.type),
    ['commented', 'exported', 'exported', 'exported'],
  );
});

test('unknown pages and routes are 404s', () => {
  const s = load();
  for (const [m, p] of [
    ['GET', '/p/NOPE'],
    ['GET', '/p/NOPE/edit'],
    ['POST', '/p/NOPE/edit'],
    ['GET', '/p/NOPE/history'],
    ['POST', '/p/NOPE/comment'],
    ['GET', '/p/NOPE/export.md'],
    ['GET', '/nowhere'],
  ])
    assert.equal(go(s, m, p, form({ title: 'x' })).status, 404, `${m} ${p}`);
  assert.deepEqual(s.events, []);
});
