// Computer access (#1364): the tool allowlist, the access log, main's wiring and the request ledger's line for a call a
// paired device made here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scopeOf, allowed, offered, NEVER } = require('../electron/computerAccess/allowlist.cjs');
const { AccessLog, accessLine } = require('../electron/computerAccess/accessLog.cjs');
const {
  createComputerAccess,
  lanAddress,
  remoteNotice,
  notificationTarget,
  openNotified,
  FLAG,
} = require('../electron/app/computerAccess.cjs');
const { RemoteOwners } = require('../electron/computerAccess/owners.cjs');
const { ledgerLine } = require('../electron/ledger/line.cjs');
const { createRequestLedger } = require('../electron/ledger/index.cjs');

test('allowlist: exact families by scope, never the tools that reach this Mac beyond the browser and apps', () => {
  assert.equal(scopeOf('browser_navigate'), 'browser');
  assert.equal(scopeOf('browser_script'), 'browser');
  assert.equal(scopeOf('chrome_computer'), 'chrome');
  assert.equal(scopeOf('desktop_app_click'), 'apps');
  assert.equal(scopeOf('desktop_screenshot'), 'apps');
  for (const name of [
    ...NEVER,
    'browser_preview_logs',
    'computer_click',
    'sage_browser_navigate',
    'start_session',
    'send_message_to_chat',
    'list_scheduled_tasks',
    'plugin_skills',
    'sage_debug_echo',
    42,
  ])
    assert.equal(scopeOf(name), null, String(name));
  assert.equal(allowed('desktop_screenshot', { apps: true }), true);
  assert.equal(allowed('desktop_screenshot', { browser: true }), false);
  assert.equal(allowed('desktop_screenshot', null), false);
  assert.deepEqual(
    offered([{ name: 'browser_navigate' }, { name: 'browser_javascript_exec' }, { name: 'chrome_navigate' }], { browser: true }).map(
      (t: any) => t.name,
    ),
    ['browser_navigate'],
  );
});

test('access log: known events only, values never kept, this run in memory, the last week read back from disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-access-log-'));
  try {
    let now = new Date('2026-10-18T10:00:00').getTime();
    const written: [string, string][] = [];
    const log = new AccessLog({
      dir: () => dir,
      now: () => now,
      max: 3,
      writer: { append: (f: string, lines: string[]) => written.push([f, lines[0]]) },
    });
    let changes = 0;
    const stop = log.onChange(() => changes++);
    assert.equal(log.add({ event: 'exec' }), null);
    assert.equal(log.add(null), null);
    const line = log.add({
      event: 'call',
      device: 'd',
      tool: 'browser_navigate',
      argKeys: ['url', 5, 'text'],
      outcome: 'ok',
      ms: 12.6,
      deviceName: 'x'.repeat(300),
      extra: 'secret',
    });
    assert.deepEqual(line.argKeys, ['url', 'text']);
    assert.equal(line.ms, 13);
    assert.equal(line.deviceName.length, 200);
    assert.equal('extra' in line, false);
    assert.equal(path.basename(written[0][0]), '2026-10-18.jsonl');
    for (const e of ['connected', 'refused', 'disconnected']) log.add({ event: e, ms: -1 });
    assert.equal(log.recent().length, 3);
    assert.equal(log.recent(1)[0].event, 'disconnected');
    assert.equal(changes, 4);
    stop();
    // the disk has yesterday's and today's lines; one of today's is still queued
    fs.writeFileSync(
      path.join(dir, '2026-10-17.jsonl'),
      `${JSON.stringify({ t: '2026-10-17T09:00:00.000Z', event: 'paired' })}\n{broken\n`,
    );
    fs.writeFileSync(path.join(dir, '2026-10-18.jsonl'), `${JSON.stringify(log.recent()[2])}\n`);
    const read = await log.read(10);
    assert.deepEqual(
      read.map((l: any) => l.event),
      ['disconnected', 'refused', 'connected', 'paired'],
    );
    assert.equal((await log.read(1)).length, 1);
    // a day that can't be read is noted and skipped
    const failing = new AccessLog({
      dir,
      now: () => now,
      fsp: { readFile: async () => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })) },
    });
    assert.deepEqual(await failing.read(), []);
    assert.equal(accessLine({ event: 'off' }, now).event, 'off');
    now += 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main: computer access opens once main is up, listens only as the switches say, and passes session changes on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-access-main-'));
  const broadcasts: string[] = [];
  const stoppedChats: string[] = [];
  const flags: Record<string, boolean> = { [FLAG]: true };
  const live: any = {
    sessions: {
      get: (id: string) =>
        id === 'busy' ? { activeTurn: { id: 7, human: true }, scheduled: { unattended: true }, permission: 'full-access' } : {},
      has: () => false,
      patch: () => true,
    },
    capabilities: { list: () => [], register: () => () => {} },
    computerUse: { broker: { answer: () => true } },
    controller: { ref: () => ({ kind: 'claude' }), stopChat: (id: string) => stoppedChats.push(id) },
    chats: { record: () => ({ segments: [{ model: 'claude-sonnet-5-5' }] }) },
  };
  const ca = createComputerAccess({
    live,
    app: { getPath: () => dir },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(s),
      decryptString: (b: Buffer) => b.toString(),
    },
    isFlagEnabled: (k: string) => flags[k] === true,
    prefs: () => ({ permission: 'read-only' }),
    broadcastAll: (ch: string) => broadcasts.push(ch),
  });
  try {
    assert.equal(ca.host, null);
    assert.equal(ca.onSessionPatch({ chatId: 'x', patch: {} }), undefined);
    const host = ca.open();
    assert.equal(ca.open(), host);
    // the client side: what a call says about the chat making it, and who stops it
    const client = ca.client;
    assert.deepEqual(client.o.facts('busy'), {
      turn: '7',
      human: true,
      unattended: true,
      harness: 'claude',
      model: 'claude-sonnet-5-5',
      anchor: 'full',
    });
    assert.deepEqual(client.o.facts('idle'), {
      turn: 'no-turn',
      human: false,
      unattended: false,
      harness: 'claude',
      model: 'claude-sonnet-5-5',
      anchor: 'readOnly',
    });
    client.o.stopChat('busy');
    assert.deepEqual(stoppedChats, ['busy']);
    assert.ok(client.o.broker());
    assert.equal(typeof client.o.deviceName(), 'string');
    client.emit('change');
    // a chat's turn ending here reaches the client too
    ca.onSessionPatch({ chatId: 'busy', patch: { turn: 'idle' } });
    assert.equal(host.o.hostAnchor(), 'read-only');
    assert.equal(host.o.flagOn(), true);
    assert.equal(host.o.answer('a', null), true);
    assert.deepEqual(host.o.registry().list(), []);
    assert.equal(typeof host.o.hostName(), 'string');
    assert.equal(host.o.sessions().has('x'), false);
    // the ledger main opened, once it is open (none before)
    assert.equal(host.o.ledger(), null);
    const ledger = createRequestLedger({
      userData: () => dir,
      prefs: () => ({}),
      chatOf: (x: string) => x,
      codexAccount: () => null,
      claudeAccount: () => null,
    });
    live.ledger = ledger;
    assert.equal(host.o.ledger(), ledger.store);
    host.o.lanAddress();
    // off by default: nothing listens
    await host.starting;
    assert.equal(host.listening, null);
    ca.sync();
    ca.onSessionPatch({ chatId: 'x', patch: { approvals: [] } });
    host.emit('change');
    assert.ok(broadcasts.length > 0 && broadcasts.every((b) => b === 'computerAccess:changed'));
    // without the app's services it does nothing
    assert.equal(createComputerAccess({ live: {} }).open(), null);
    const noAnswer = createComputerAccess({
      live: {},
      app: { getPath: () => dir },
      safeStorage: {},
      isFlagEnabled: () => false,
      prefs: () => null,
    });
    const h2 = noAnswer.open();
    assert.equal(h2.o.answer('a', null), false);
    assert.equal(noAnswer.client.o.broker(), null);
    assert.equal(h2.o.hostAnchor(), null);
    await host.stop('test');
    await h2.stop('test');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lanAddress: the first IPv4 address that is not loopback', () => {
  assert.equal(
    lanAddress({
      lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      en0: [
        { family: 'IPv6', internal: false, address: 'fe80::1' },
        { family: 'IPv4', internal: false, address: '192.168.1.20' },
      ],
    } as any),
    '192.168.1.20',
  );
  assert.equal(lanAddress({ lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }], x: undefined } as any), null);
  assert.equal(typeof lanAddress(), typeof lanAddress());
});

test('request ledger: a remote call keeps its kind, device and tool, which no other line gets', () => {
  const now = Date.parse('2026-10-18T10:00:00Z');
  const remote = JSON.parse(
    ledgerLine({ kind: 'computerAccess', harness: 'claude', chat: 'c', device: 'd1', tool: 'browser_navigate', outcome: 'ok' }, now),
  );
  assert.deepEqual([remote.kind, remote.device, remote.tool], ['computerAccess', 'd1', 'browser_navigate']);
  const other = JSON.parse(ledgerLine({ kind: 'other', harness: 'codex', device: 'd1', tool: 'x', outcome: 'ok' } as any, now));
  assert.equal('kind' in other || 'device' in other || 'tool' in other, false);
});

test('this Mac says when a paired device starts using it, names it in card notifications, and a click opens Computer access', () => {
  const shown: any[] = [];
  const ca = createComputerAccess({ live: { notifier: { notify: (...a: any[]) => shown.push(a) } } });
  const owner = ca.owners.enter({ deviceId: 'd1', deviceName: 'Laptop', clientChat: 'c1', harness: 'claude', hostAnchor: 'ask' });
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0].slice(0, 2), ['computer', owner.id]);
  assert.equal(shown[0][2].title, 'Laptop is using this Mac');
  assert.match(shown[0][2].body, /A claude chat on Laptop\. Stop it in Settings → Computer access/);
  // the same owner again says nothing new
  ca.owners.enter({ deviceId: 'd1', deviceName: 'Laptop', clientChat: 'c1', hostAnchor: 'ask' });
  assert.equal(shown.length, 1);
  // without a notifier (main not up) nothing breaks
  createComputerAccess({ live: {} }).owners.enter({ deviceId: 'd', deviceName: 'x', clientChat: 'c', hostAnchor: 'ask' });
  // a card notification for the owner names the device and where to answer; a chat's is unchanged
  const opts = { title: 'Codex needs your approval', body: '' };
  const n = remoteNotice(ca.owners, owner.id, opts);
  assert.equal(n.title, 'Laptop needs your OK on this Mac');
  assert.match(n.body, /Answer in Settings → Computer access, or on Laptop/);
  assert.equal(n.chatTitle, 'Laptop');
  assert.equal(remoteNotice(ca.owners, 'local', opts), opts);
  // only a card notification is about the person's OK; another kind about an owner goes as it was
  assert.equal(remoteNotice(ca.owners, owner.id, opts, 'turn'), opts);
  // a device whose actions only this Mac approves is not offered as a place to answer
  const hostOnly = ca.owners.enter({ deviceId: 'd2', deviceName: 'Pad', clientChat: 'c2', hostAnchor: 'ask', hostOnlyApprovals: true });
  assert.match(remoteNotice(ca.owners, hostOnly.id, opts, 'approval').body, /Answer in Settings → Computer access\.$/);
  assert.equal(remoteNotice(null, owner.id, opts), opts);
  assert.deepEqual(notificationTarget(ca.owners, owner.id), ['settings', 'computer-access']);
  assert.deepEqual(notificationTarget(ca.owners, 'local'), ['open-chat', 'local']);
  assert.deepEqual(notificationTarget(undefined, 'local'), ['open-chat', 'local']);
  // the overlay's words while that owner holds this Mac
  assert.equal(ca.owners.indicatorLabel(owner.id), 'Laptop is using your computer · Esc to stop');
  assert.equal(ca.owners.indicatorLabel('local'), null);
  assert.ok(RemoteOwners);
  // the click itself: a command for the main window; one it can't take is only noted
  const sent: any[] = [];
  openNotified(ca.owners, async (...a: any[]) => sent.push(a), owner.id);
  openNotified(ca.owners, () => Promise.reject(new Error('no window')), 'local');
  assert.deepEqual(sent, [['settings', 'computer-access']]);
});
