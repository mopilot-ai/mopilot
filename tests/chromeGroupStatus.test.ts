// A chat's tab group in the user's Chrome shows the chat's title and its turn (#1632, parity with Claude in Chrome's
// ⌛ 🔔 ✅ and ChatGPT's session-named groups): the app's session patches (app/chromeRelay.cjs onSessionPatch) reach
// the extension as session.status (chromeExtension.cjs turnStatus), which titles the group (sessions.mjs status,
// groups.mjs retitle and groupTitle). The Playwright relay has no such message.
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { emptyChromeFolder, extensionWorld, fakeChromeApi, memoryPairing } from './support/chrome-extension-kit.ts';
import { until } from './support/chrome-relay-kit.ts';

const require = createRequire(import.meta.url);
const { groupTitle, STATUS_MARK, Groups }: any = await import('../electron/chrome-extension/src/groups.mjs');
const { Sessions }: any = await import('../electron/chrome-extension/src/sessions.mjs');
const { ChromeRelay } = require('../electron/capabilities/browser/chromeRelay.cjs');
const appRelay = require('../electron/app/chromeRelay.cjs');

const stops: (() => void)[] = [];
after(() => {
  for (const s of stops) s();
});

test('groupTitle: the chat title after its turn mark; no mark for no or an unknown status', () => {
  assert.equal(groupTitle({ title: 'Fix login', status: 'running' }), '⌛ Fix login');
  assert.equal(groupTitle({ title: 'Fix login', status: 'waiting' }), '🔔 Fix login');
  assert.equal(groupTitle({ title: 'Fix login', status: 'done' }), '✅ Fix login');
  assert.equal(groupTitle({ title: 'Fix login', status: null }), 'Fix login');
  assert.equal(groupTitle({ title: 'Fix login' }), 'Fix login');
  assert.equal(groupTitle({ title: 'Fix login', status: 'toString' }), 'Fix login');
  assert.equal(STATUS_MARK.running, '⌛');
});

test('extension and app: the chat group follows its title and turn; chats without a session send nothing', async () => {
  const w = await extensionWorld();
  stops.push(w.stop);
  const link = await w.channel.connect('c');
  assert.equal(link.open, true);
  const tab = await w.channel.createTab(w.channel.token('c'), 'https://example.test/');
  const groupId = w.chrome.tabsById.get(tab.id).groupId;
  assert.equal(w.chrome.groups.get(groupId).title, 'MoPilot c');
  w.channel.turnStatus('c', { title: 'Fix login', status: 'running' });
  await until(() => w.chrome.groups.get(groupId).title === '⌛ Fix login');
  w.channel.turnStatus('c', { title: null, status: 'waiting' });
  await until(() => w.chrome.groups.get(groupId).title === '🔔 Fix login');
  w.channel.turnStatus('c', { title: '  ', status: 'done' });
  await until(() => w.chrome.groups.get(groupId).title === '✅ Fix login');
  // an unknown status drops the mark; a long title is cut
  w.channel.turnStatus('c', { title: 'x'.repeat(100), status: 'bogus' });
  await until(() => w.chrome.groups.get(groupId).title === 'x'.repeat(80));
  // a chat with no session in Chrome: nothing goes out, but its session opens with the turn it is in (#1632 VM check:
  // the group had no mark until a status came after its first tab)
  const sent = mock.method(w.channel.peer, 'send');
  w.channel.turnStatus('other', { title: 'Other', status: 'running' });
  assert.equal(sent.mock.callCount(), 0);
  sent.mock.restore();
  await w.channel.connect('other');
  const otherTab = await w.channel.createTab(w.channel.token('other'), 'https://example.test/');
  assert.equal(w.chrome.groups.get(w.chrome.tabsById.get(otherTab.id).groupId).title, '⌛ MoPilot other');
  // a deleted chat forgets it
  w.channel.disconnect('other');
  assert.equal(w.channel.statuses.has('other'), false);
});

test('extension sessions: a status for an unknown chat does nothing; a chat with no group yet is titled when it gets one', async () => {
  const chrome: any = fakeChromeApi();
  const logged: string[] = [];
  const s = new Sessions({ chrome, send: () => undefined, storage: null, log: (what: string) => logged.push(what) });
  assert.equal(await s.handle({ chat: 'nobody', method: 'session.status', params: [] }), undefined);
  await s.open('c', { title: 'MoPilot c' });
  // no params: no mark, the title kept
  await s.handle({ chat: 'c', method: 'session.status' });
  assert.equal(s.chats.get('c').status, null);
  assert.equal(s.chats.get('c').title, 'MoPilot c');
  await s.handle({ chat: 'c', method: 'session.status', params: [{ title: 'Plan trip', status: 'running' }] });
  assert.equal(chrome.log.filter((l: any) => l[0] === 'tabGroups.update').length, 0, 'no group to title yet');
  const created = await s.command('c', 'chrome.tabs.create', [{ url: 'https://a.test/' }], undefined);
  const gid = chrome.tabsById.get(created.id).groupId;
  assert.equal(chrome.groups.get(gid).title, '⌛ Plan trip');
  // Chrome refusing the title is logged, not thrown
  chrome.fail['tabGroups.update'] = new Error('No group');
  await s.handle({ chat: 'c', method: 'session.status', params: [{ status: 'done' }] });
  assert.deepEqual(logged, ['title a tab group']);
  // a session with no group: nothing to title
  const groups = new Groups({ chrome, changed: () => undefined, log: () => undefined });
  assert.equal(await groups.retitle({ title: 't', groupId: null }), undefined);
});

test('the Playwright relay has no group status; the app maps the session store turn to the group status', () => {
  assert.equal(new ChromeRelay({ openPage: () => undefined }).turnStatus('c', { title: null, status: 'running' }), undefined);
  const r = appRelay.setupChromeRelay({
    registry: { register: () => () => undefined },
    grants: {},
    token: () => null,
    profileDir: () => '',
    images: { fromBuffer: (b: Buffer) => b },
    isFlagEnabled: () => true,
    chatTitle: (chatId: string) => (chatId === 'c' ? 'Fix login' : null),
  });
  const seen = mock.method(r.relay, 'turnStatus');
  r.onSessionPatch({ chatId: 'c', patch: { turn: 'running' } });
  r.onSessionPatch({ chatId: 'c', patch: { turn: 'awaitingUser' } });
  r.onSessionPatch({ chatId: 'd', patch: { turn: 'idle' } });
  r.onSessionPatch({ chatId: 'c', patch: { title: 'x' } });
  r.onSessionPatch({ chatId: 'c', patch: { turn: 'weird' } });
  r.onSessionPatch(null);
  assert.deepEqual(
    seen.mock.calls.map((c: any) => c.arguments),
    [
      ['c', { title: 'Fix login', status: 'running' }],
      ['c', { title: 'Fix login', status: 'waiting' }],
      ['d', { title: null, status: 'done' }],
    ],
  );
  r.stop();
});

test('the extension channel names a new chat group for the chat, or plainly for the app while it has no title, never for an id', (ctx) => {
  emptyChromeFolder(ctx);
  const setup = (chatTitle?: (chatId: string) => string | null) =>
    appRelay.setupChromeRelay({
      registry: { register: () => () => undefined },
      grants: {},
      token: () => null,
      profileDir: () => '',
      images: { fromBuffer: (b: Buffer) => b },
      isFlagEnabled: () => false,
      kind: 'extension',
      pairing: memoryPairing(),
      ...(chatTitle ? { chatTitle } : {}),
    });
  const untitled = setup();
  assert.equal(untitled.relay.o.clientName('claude:5abcdefgh-1234'), 'MoPilot');
  untitled.stop();
  const titled = setup((id) => (id === 'c1' ? 'Fix login' : null));
  assert.equal(titled.relay.o.clientName('c1'), 'Fix login');
  assert.equal(titled.relay.o.clientName('c2'), 'MoPilot');
  titled.stop();
});
