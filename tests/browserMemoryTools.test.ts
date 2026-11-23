// browser_history_search and browser_bookmarks_search (electron/capabilities/browser/hostTools.cjs): read-only searches of what the
// built-in browser remembers, safe for the model: blocked addresses vanish, high-risk sites show their host only, credential-like query values are hidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { browserToolSpecs } from './support/tool-specs.ts';

const require = createRequire(import.meta.url);
const { createBrowserTools } = require('../electron/capabilities/browser/hostTools.cjs');
const { ToolError } = require('../electron/capabilities/contract/registry.cjs');

const T0 = Date.UTC(2026, 9, 1);

function tools(memory: any) {
  const list = createBrowserTools({ tabs: { state: () => 'STATE' }, grants: {}, memory });
  const call = (name: string, args: any = {}) => list.find((t: any) => t.name === name).handler(args, { chatId: 'c1', segmentId: 's1' });
  return { call, list };
}

test('the search tools are read-only specs, and a store-less browser refuses them', async () => {
  for (const name of ['browser_history_search', 'browser_bookmarks_search']) {
    const spec = browserToolSpecs().find((s: any) => s.name === name);
    assert.equal(spec.policy, 'observe');
  }
  const { call } = tools(null);
  await assert.rejects(
    () => call('browser_history_search'),
    (e: any) => e instanceof ToolError && e.code === 'disabled',
  );
  await assert.rejects(
    () => call('browser_bookmarks_search'),
    (e: any) => e instanceof ToolError && e.code === 'disabled',
  );
});

test('browser_history_search: passes the query, date and limit through and keeps the model away from secrets', async () => {
  const seen: any[] = [];
  const rows = [
    { url: 'https://docs.test/a?token=abc&page=2', title: 'Docs\nPage', lastVisit: T0, visitCount: 3 },
    { url: 'http://169.254.169.254/latest/meta-data/', title: 'Metadata', lastVisit: T0, visitCount: 1 },
    { url: 'https://www.chase.com/personal/reset?code=1', title: 'Chase — account', lastVisit: T0 - 86400000, visitCount: 2 },
  ];
  const { call } = tools({
    history: () => ({ search: (o: any) => (seen.push(o), rows) }),
    bookmarks: () => ({ search: () => [] }),
  });
  const out = await call('browser_history_search', { query: 'docs', since: '2026-09-01', limit: 5 });
  assert.deepEqual(seen[0], { query: 'docs', since: Date.parse('2026-09-01'), limit: 5 });
  assert.deepEqual(JSON.parse(out[0].text), [
    { url: 'https://docs.test/a?token=REDACTED&page=2', title: 'Docs Page', lastVisit: '2026-10-01T00:00:00.000Z', visitCount: 3 },
    { url: 'https://www.chase.com/', risk: 'high', title: '', lastVisit: '2026-09-30T00:00:00.000Z', visitCount: 2 },
  ]);
  assert.equal(out[out.length - 1].text, 'STATE');
  // defaults: no query, no date, 20 results
  await call('browser_history_search');
  assert.deepEqual(seen[1], { query: '', since: 0, limit: 20 });
  await call('browser_history_search', { since: '' });
  assert.equal(seen[2].since, 0);
});

test('browser_history_search: a bad date is a bad argument, and no match says so', async () => {
  const { call } = tools({ history: () => ({ search: () => [] }), bookmarks: () => ({ search: () => [] }) });
  await assert.rejects(
    () => call('browser_history_search', { since: 'last week' }),
    (e: any) => e instanceof ToolError && e.code === 'bad_args' && /ISO date/.test(e.message),
  );
  const out = await call('browser_history_search', { query: 'nothing' });
  assert.equal(out[0].text, 'No visited pages match.');
});

test('browser_bookmarks_search: passes the query, folder and limit through and applies the same protections', async () => {
  const seen: any[] = [];
  const rows = [
    { url: 'https://docs.test/a?key=1', title: 'Docs', folderPath: ['Imported from Chrome', 'Work'] },
    { url: 'https://www.chase.com/personal/accounts', title: 'Bank', folderPath: [] },
    { url: 'http://169.254.169.254/', title: 'Metadata', folderPath: [] },
  ];
  const { call } = tools({
    history: () => ({ search: () => [] }),
    bookmarks: () => ({ search: (o: any) => (seen.push(o), rows) }),
  });
  const out = await call('browser_bookmarks_search', { query: 'docs', folder: 'Work', limit: 9 });
  assert.deepEqual(seen[0], { query: 'docs', folder: 'Work', limit: 9 });
  assert.deepEqual(JSON.parse(out[0].text), [
    { url: 'https://docs.test/a?key=REDACTED', title: 'Docs', folderPath: ['Imported from Chrome', 'Work'] },
    { url: 'https://www.chase.com/', risk: 'high', title: '', folderPath: [] },
  ]);
  await call('browser_bookmarks_search');
  assert.deepEqual(seen[1], { query: '', folder: '', limit: 50 });
  const none = tools({ history: () => ({ search: () => [] }), bookmarks: () => ({ search: () => [] }) });
  assert.equal((await none.call('browser_bookmarks_search'))[0].text, 'No bookmarks match.');
});
