// Browser storage per chat (IAB-08): the partition a chat's tabs use (shared/browserStorage.mjs), main's
// partitions (electron/capabilities/browser/storage.cjs: checked, set up once, cleared when the chat
// ends), and CDP target checks that accept a chat's own partition (cdp.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { SHARED_PARTITION, browserPartition, isChatPartition, storageMode } from '../shared/browserStorage.mjs';

const require = createRequire(import.meta.url);
const { BrowserStorage, clearSession } = require('../electron/capabilities/browser/storage.cjs');
const { assertCdpTarget } = require('../electron/capabilities/browser/cdp.cjs');

test('storageMode: only "session" is a chat\'s own storage; anything else shares', () => {
  assert.equal(storageMode('session'), 'session');
  for (const v of ['shared', undefined, null, 'none', 1]) assert.equal(storageMode(v), 'shared');
});

test('browserPartition: shared is one persistent profile; session is an in-memory partition per chat', () => {
  assert.equal(SHARED_PARTITION, 'persist:browser');
  assert.equal(browserPartition('shared', 'chat-1'), SHARED_PARTITION);
  assert.equal(browserPartition(undefined, 'chat-1'), SHARED_PARTITION);
  // a tab of no chat always shares
  for (const id of [null, undefined, '', 42]) assert.equal(browserPartition('session', id as any), SHARED_PARTITION);
  const a = browserPartition('session', 'chat-1');
  assert.match(a, /^mopilot-chat-chat-1-[0-9a-f]{8}$/);
  assert.ok(!a.startsWith('persist:'), 'in memory: gone when the app quits');
  assert.equal(browserPartition('session', 'chat-1'), a, 'stable for a chat');
  // ids that sanitize alike still differ; long ids are cut but stay valid
  assert.notEqual(browserPartition('session', 'a/b'), browserPartition('session', 'a:b'));
  const long = browserPartition('session', 'x'.repeat(300));
  assert.ok(isChatPartition(long) && long.length < 110);
  assert.ok(isChatPartition(a));
  for (const bad of [
    SHARED_PARTITION,
    'persist:mopilot-chat-x-00000000',
    'mopilot-chat-',
    'mopilot-chat-x',
    'mopilot-chat-x-0000000g',
    'other',
    null,
    7,
  ])
    assert.equal(isChatPartition(bad), false, String(bad));
});

class FakeSession extends EventEmitter {
  name: string;
  log: string[];
  fail = false;
  constructor(name: string, log: string[], history = true) {
    super();
    this.name = name;
    this.log = log;
    if (!history) (this as any).clearHistory = undefined;
  }
  async clearStorageData() {
    if (this.fail) throw new Error('busy');
    this.log.push(`storage ${this.name}`);
  }
  async clearCache() {
    this.log.push(`cache ${this.name}`);
  }
  async clearHistory() {
    this.log.push(`history ${this.name}`);
  }
}

function storage(o: any = {}) {
  const log: string[] = [];
  const sessions = new Map<string, FakeSession>();
  const configured: string[] = [];
  const s = new BrowserStorage({
    fromPartition: (p: string) => {
      if (!sessions.has(p)) sessions.set(p, new FakeSession(p, log));
      return sessions.get(p);
    },
    ...(o.noConfigure
      ? {}
      : {
          configure: (ses: FakeSession) => {
            configured.push(ses.name);
            if (o.configureThrows) throw new Error('auth');
          },
        }),
  });
  return { s, log, sessions, configured };
}

test("BrowserStorage.partition: a chat's own partition is accepted and set up once; anything else is the shared profile", () => {
  const { s, configured } = storage();
  const mine = browserPartition('session', 'chat-1');
  for (const asked of [undefined, '', SHARED_PARTITION, 'persist:other', 'evil', 'persist:mopilot-chat-x-00000000'])
    assert.equal(s.partition(asked), SHARED_PARTITION);
  assert.deepEqual(
    s.sessions().map((x: FakeSession) => x.name),
    [SHARED_PARTITION],
  );
  assert.equal(s.partition(mine), mine);
  assert.equal(s.partition(mine), mine);
  assert.deepEqual(configured, [mine], 'downloads and sign-in are set up once per session');
  assert.deepEqual(
    s.sessions().map((x: FakeSession) => x.name),
    [SHARED_PARTITION, mine],
  );
  // a failing set-up doesn't stop the tab; no configure at all is fine
  const bad = storage({ configureThrows: true });
  assert.equal(bad.s.partition(mine), mine);
  const none = storage({ noConfigure: true });
  assert.equal(none.s.partition(mine), mine);
});

test("BrowserStorage.endChat: the chat's own partition is cleared and leaves the panel sessions; reused, it is not set up twice", async () => {
  const { s, log, configured } = storage();
  const mine = browserPartition('session', 'chat-1');
  s.partition(mine);
  s.partition(browserPartition('session', 'chat-2'));
  assert.equal(await s.endChat('chat-1'), true);
  assert.deepEqual(log, [`storage ${mine}`, `cache ${mine}`, `history ${mine}`]);
  assert.equal(s.sessions().length, 2);
  assert.ok(!s.sessions().some((x: FakeSession) => x.name === mine));
  // a chat with no partition of its own (shared, or already ended): nothing to do
  assert.equal(await s.endChat('chat-1'), false);
  assert.equal(await s.endChat('never'), false);
  // the chat comes back (unarchived): its partition is a panel session again, set up only once
  s.partition(mine);
  assert.equal(configured.filter((n) => n === mine).length, 1);
});

test('BrowserStorage.clearAll and clearSession: every session is cleared; failures and a missing clearHistory are tolerated', async () => {
  const { s, log, sessions } = storage();
  const mine = browserPartition('session', 'chat-1');
  s.partition(mine);
  await s.clearAll();
  assert.deepEqual(
    log.sort(),
    [
      `cache ${SHARED_PARTITION}`,
      `cache ${mine}`,
      `history ${SHARED_PARTITION}`,
      `history ${mine}`,
      `storage ${SHARED_PARTITION}`,
      `storage ${mine}`,
    ].sort(),
  );
  sessions.get(mine)!.fail = true;
  log.length = 0;
  await clearSession(sessions.get(mine));
  assert.deepEqual(log, []);
  const noHistory = new FakeSession('x', log, false);
  await clearSession(noHistory);
  assert.deepEqual(log, ['storage x', 'cache x']);
});

test("assertCdpTarget: a tab in a chat's own partition is a panel tab when the list of panel sessions has it", () => {
  const shared = { name: 'shared' };
  const mine = { name: 'mine' };
  const owner = { id: 1 };
  const wc = (session: any) => ({
    id: 9,
    isDestroyed: () => false,
    getType: () => 'webview',
    session,
    hostWebContents: owner,
    getLastWebPreferences: () => ({}),
  });
  assert.doesNotThrow(() => assertCdpTarget(wc(mine), { appContents: [owner], panelSession: [shared, mine] }));
  assert.doesNotThrow(() => assertCdpTarget(wc(shared), { appContents: [owner], panelSession: shared }));
  assert.throws(() => assertCdpTarget(wc(mine), { appContents: [owner], panelSession: [shared] }), /not in the browser panel's partition/);
  assert.throws(
    () => assertCdpTarget(wc(undefined), { appContents: [owner], panelSession: undefined }),
    /not in the browser panel's partition/,
  );
  assert.throws(() => assertCdpTarget(wc(undefined), { appContents: [owner], panelSession: [] }), /not in the browser panel's partition/);
});

test('Clear browsing data clears navigation history for every browser partition and rejects failed explicit requests', async () => {
  const { s, sessions } = storage();
  const mine = browserPartition('session', 'history-chat');
  s.partition(mine);
  s.sessions(); // Materialize the shared partition before constructing its page fixture.
  const history: string[] = [];
  const page = (name: string, ses: unknown, destroyed = false) => ({
    session: ses,
    isDestroyed: () => destroyed,
    navigationHistory: { clear: () => history.push(name) },
  });
  const pages = [
    page('shared', sessions.get(SHARED_PARTITION)),
    page('chat', sessions.get(mine)),
    page('app', {}),
    page('closed', sessions.get(mine), true),
  ];
  await s.clearAll(pages);
  assert.deepEqual(history.sort(), ['chat', 'shared']);
  sessions.get(mine)!.fail = true;
  await assert.rejects(s.clearAll(pages), /busy/);
});
