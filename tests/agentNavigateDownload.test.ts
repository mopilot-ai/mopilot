// An agent's navigate to a link answered with a file (#1484 on the agent's side, #1523): Chromium aborts the navigation
// (ERR_ABORTED) and the session's will-download can come just after, so navigate asks the shared rule
// (downloadNavigations.cjs becameDownload) and says a download started instead of "Couldn't open".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { drive, setup, tabOf } from './support/browser-host-kit.ts';

const require = createRequire(import.meta.url);
const { noteDownload, becameDownload, ABORT_WAIT_MS, DOWNLOAD_NOTE } = require('../electron/capabilities/browser/downloadNavigations.cjs');
const { createBrowserTools } = require('../electron/capabilities/browser/hostTools.cjs');
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');

const FILE = 'http://127.0.0.1:8841/report.csv';

test('becameDownload: noted already; an abort waits for its download; anything else fails at once', async () => {
  const wc = {};
  assert.equal(await becameDownload(null, FILE, 'net::ERR_ABORTED'), false, 'no page');
  assert.equal(await becameDownload(wc, FILE, 'net::ERR_NAME_NOT_RESOLVED'), false, 'not a download abort: no wait');
  // the will-download came first
  noteDownload(wc, [FILE]);
  assert.equal(await becameDownload(wc, FILE, 'net::ERR_BLOCKED_BY_CLIENT'), true);
  // a later failure of another kind is a failure, whatever the page downloaded before
  assert.equal(await becameDownload(wc, FILE, 'net::ERR_CONNECTION_REFUSED'), false);
  // a cancelled download's ERR_BLOCKED_BY_CLIENT waits for nothing
  assert.equal(await becameDownload({}, FILE, 'net::ERR_BLOCKED_BY_CLIENT'), false);
  // the same address however it is written
  const bare = {};
  noteDownload(bare, ['http://a.test/']);
  assert.equal(await becameDownload(bare, 'http://a.test', 'net::ERR_ABORTED'), true);
  // the abort first, then its download
  const late = {};
  const asked = becameDownload(late, FILE, 'net::ERR_ABORTED', 1000);
  noteDownload(late, ['http://other.test/x.csv']);
  noteDownload(late, ['http://cdn.test/redirected.csv', FILE]);
  assert.equal(await asked, true);
  // two navigations on one page wait apart: each hears only its own download
  const two = {};
  const a = becameDownload(two, 'http://a.test/a.csv', 'net::ERR_ABORTED', 30);
  const b = becameDownload(two, 'http://a.test/b.csv', 'net::ERR_ABORTED', 30);
  noteDownload(two, ['http://a.test/b.csv']);
  assert.deepEqual(await Promise.all([a, b]), [false, true]);
  // an abort with no download is a failure once the wait is over
  assert.equal(await becameDownload({}, FILE, 'net::ERR_ABORTED', 5), false);
  // addresses that are not URLs compare as written
  const odd = {};
  noteDownload(odd, ['not a url']);
  assert.equal(await becameDownload(odd, 'not a url', 'net::ERR_ABORTED'), true);
  assert.equal(ABORT_WAIT_MS, 2000);
});

test("browser_navigate's navigate: a link that downloads says so; an abort with no download is still a failure", async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  tab.wc.handlers['Page.navigate'] = ({ url }: any) => {
    setTimeout(() => noteDownload(tab.wc, [url]), 30);
    return { errorText: 'net::ERR_ABORTED' };
  };
  const r = await drive(t, h.tabs.navigate(tab, FILE));
  assert.equal(r.note, DOWNLOAD_NOTE);
  assert.equal(r.url, tab.url);
  assert.equal(tab.navigating, false);
  tab.wc.handlers['Page.navigate'] = () => ({ errorText: 'net::ERR_ABORTED' });
  await assert.rejects(drive(t, h.tabs.navigate(tab, 'https://stopped.test/'), { step: 500 }), {
    code: 'failed',
    message:
      "Couldn't open https://stopped.test/: the load was stopped (net::ERR_ABORTED). Try once more; if it fails again, tell the user.",
  });
});

test('browser_navigate to a file: the tab stays on its page, so no site card is raised for the page it was already on', async (t) => {
  const h = setup(t);
  const wc = h.newWC();
  wc.url = 'https://mail.test/inbox';
  tabOf(h, 'tab_aaaaaa', 'c', wc);
  const asked: string[] = [];
  const grants = new OriginGrants({
    anchor: () => 'default',
    ask: async (q: any) => (asked.push(q.origin), { decision: 'allow', scope: 'chat', level: 'write' }),
    confirmAction: async () => true,
  });
  grants.allowInChat('c', 'https://cdn.test', 'write');
  const tools = new Map(createBrowserTools({ tabs: h.tabs, grants }).map((x: any) => [x.name, x]));
  wc.handlers['Page.navigate'] = ({ url }: any) => {
    noteDownload(wc, [url]);
    return { errorText: 'net::ERR_ABORTED' };
  };
  const ctx = { chatId: 'c', segmentId: 's1', signal: new AbortController().signal };
  const out = await drive(t, (tools.get('browser_navigate') as any).handler({ url: 'https://cdn.test/report.csv' }, ctx));
  const text = (out ?? []).map((c: any) => c.text ?? '').join('\n');
  assert.match(text, /The link started a download instead of opening a page/);
  assert.deepEqual(asked, [], 'mail.test, where the tab still is, is not asked for again');
});
