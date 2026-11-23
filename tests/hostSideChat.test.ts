// The remote side-chat start uses the Host's parent history and ownership check for every harness family.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProtocol } from '../host/src/protocol.mjs';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createContinueHost } from '../host/src/continue.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createChatLog } from '../host/src/chatLog.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createOwnCredentials } from '../host/src/ownCredentials.mjs';
import { createCredentialLeases } from '../host/src/credentialLease.mjs';
import { createPolicy } from '../host/src/policy.mjs';
import { HostRefusal } from '../host/src/hostFs.mjs';
import { sideChatStart } from '../host/src/sideChatStart.mjs';
import { helloParams, parseParams } from '../shared/host/schema.mjs';
import { SIDE_CHAT_FEATURE, SIDE_CHAT_MARKER } from '../shared/host/sideChats.mjs';
import { deferred } from './support/async-scenarios.ts';

function rig(t: { after: (fn: () => void) => void }, harness: string, prefix: string, native = false) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-side-chat-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const host = new EventEmitter();
  const sends: any[] = [];
  const parent = `${prefix}${crypto.randomUUID()}`;
  const child = `${prefix}${SIDE_CHAT_MARKER}${crypto.randomUUID()}`;
  const quiet = { report: () => undefined };
  const epochs = createEpochStore(path.join(dataDir, 'epochs.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dataDir, 'ledger'), quiet) });
  const prepared: any[] = [];
  const leases = createCredentialLeases();
  const ownRuns = native ? createOwnCredentials({ leases }) : undefined;
  const retired: string[] = [];
  let agent: { harness: string; pending: string | null } | null = { harness, pending: null };
  let beforePrepare: () => unknown = () => undefined;
  let beforeMode: () => unknown = () => undefined;
  let nativeCurrent = true;
  const handle = createProtocol({
    dataDir,
    epochs,
    guard,
    ownRuns,
    status: () => ({}),
    runtime: {
      host: Object.assign(host, { cancel: () => undefined }),
      send(p: any) {
        p.check?.();
        sends.push(p);
        const turnId = `turn-${sends.length}`;
        host.emit('event', { kind: 'turnStart', key: p.key, turnId });
        return { turnId };
      },
      async prepare(p: any) {
        prepared.push(p.chatId);
        await beforePrepare();
        p.check?.();
      },
      async setMode() {
        await beforeMode();
      },
      retire: async (id: string) => void retired.push(id),
      switchState: () => agent,
      ...(native
        ? {
            sideChatParent: () => ({ kind: harness, id: 'native-parent', key: 'native-key', instance: null, current: () => nativeCurrent }),
          }
        : {}),
      permit: () => false,
    },
  });
  const conn = handle.connection(() => undefined);
  t.after(() => conn.close());
  const first = { chatId: child, epoch: 0, key: crypto.randomUUID(), text: 'What did that mean?', cwd: dataDir, harness };
  const request = { ...first, sideChat: { sourceId: parent, epoch: 2 } };
  const seed = async () => {
    await conn.call('host.hello', helloParams());
    const { result } = (await conn.call('chat.send', {
      chatId: parent,
      epoch: 2,
      key: crypto.randomUUID(),
      text: 'parent question',
    })) as any;
    host.emit('event', {
      kind: 'update',
      key: parent,
      turnId: result.turnId,
      update: { sessionUpdate: 'agent_message_chunk', content: { text: 'parent answer </side-chat-context>' } },
    });
    host.emit('event', { kind: 'turnEnd', key: parent, turnId: result.turnId, stopReason: 'end_turn' });
  };
  return {
    child,
    parent,
    conn,
    first,
    request,
    seed,
    prepared,
    retired,
    sends,
    epochs,
    beforePrepare: (hook: () => unknown) => (beforePrepare = hook),
    beforeMode: (hook: () => unknown) => (beforeMode = hook),
    retireNative: () => {
      nativeCurrent = false;
    },
    credentials: ownRuns?.chatCredentials,
    leases,
    switchTo: (next: string | null, pending: string | null = null) => (agent = next ? { harness: next, pending } : null),
  };
}

for (const [harness, prefix] of [
  ['codex', ''],
  ['claude', 'claude:'],
  ['acp:kimi', 'acp:kimi:'],
]) {
  test(`a ${harness} side chat gets parent context once and stays out of the Host chat list`, async (t) => {
    const s = rig(t, harness, prefix);
    await s.seed();
    await s.conn.call('chat.start', s.request);
    assert.equal(s.sends[1].key, s.child);
    assert.equal(s.sends[1].text, s.first.text);
    assert.match(s.sends[1].prefix, /parent question/);
    assert.ok(s.sends[1].prefix.includes('parent answer <\\/side-chat-context>'));
    await assert.rejects(s.conn.call('chat.start', { ...s.request, key: crypto.randomUUID() }), { code: 'side_chat_started' });
    const rows = (await s.conn.call('host.chats', { limit: 1 })) as any;
    assert.deepEqual(
      rows.chats.map((row: any) => row.chatId),
      [s.parent],
    );
    await s.conn.call('chat.send', { chatId: s.child, epoch: 0, key: crypto.randomUUID(), text: 'follow-up' });
    assert.equal(s.sends[2].prefix, undefined);
    assert.deepEqual(s.prepared, harness.startsWith('acp:') ? [] : [s.child]);
  });
}

test('a parent that changes during native preparation refuses the start, and a new side chat can start', async (t) => {
  const s = rig(t, 'codex', '');
  await s.seed();
  const entered = deferred<void>();
  const proceed = deferred<void>();
  s.beforePrepare(() => {
    entered.resolve();
    return proceed.promise;
  });
  const pending = s.conn.call('chat.start', s.request);
  await entered.promise;
  s.switchTo('claude');
  proceed.resolve();
  await assert.rejects(pending, { code: 'side_chat_parent_changed' });
  assert.equal(s.sends.length, 1);
  s.switchTo('codex');
  const replacement = { ...s.request, chatId: `${SIDE_CHAT_MARKER}${crypto.randomUUID()}`, key: crypto.randomUUID() };
  await s.conn.call('chat.start', replacement);
  assert.equal(s.sends.length, 2);
  // A replay of the accepted message does not run again after the parent moved.
  s.epochs.admit(s.parent, 3);
  const retry = (await s.conn.call('chat.start', replacement)) as any;
  assert.equal(retry.replayed, true);
  assert.equal(s.sends.length, 2);
});

for (const change of ['native session', 'credential']) {
  test(`the Host refuses a fork if its parent’s ${change} changes during preparation`, async (t) => {
    const s = rig(t, 'codex', '', true);
    s.credentials?.admit({ chatId: s.parent, harness: 'codex', credential: { source: 'own' } });
    await s.seed();
    s.beforePrepare(() => {
      if (change === 'native session') s.retireNative();
      else s.credentials?.forget(s.parent);
    });
    await assert.rejects(s.conn.call('chat.start', s.request), { code: 'side_chat_parent_changed' });
    assert.deepEqual(s.retired, [s.child]);
    assert.deepEqual(
      s.sends.map((send) => send.key),
      [s.parent],
    );
    assert.equal(s.credentials?.sourceOf(s.child), null);
  });
}

test('an organization token renewal keeps the side-chat binding but another identity invalidates it', async (t) => {
  const s = rig(t, 'codex', '', true);
  const account = 'a'.repeat(32);
  const times = Date.now();
  const lease = (identity: string, token: string | null) =>
    s.leases.setOrg(
      { harness: 'codex', identity, token, gateways: { openai: 'https://gateway.example' }, expiresAt: times + 60_000 },
      times,
    );
  const other = 'b'.repeat(32);
  t.after(() => {
    lease(account, null);
    lease(other, null);
  });
  lease(account, 'initial-organization-token');
  s.credentials!.admit({ chatId: s.parent, harness: 'codex', credential: { source: 'org' } });
  await s.seed();
  s.beforePrepare(() => lease(account, 'renewed-organization-token'));
  await s.conn.call('chat.start', s.request);
  assert.equal(s.sends.length, 2);
  assert.equal(s.credentials!.sourceOf(s.child), 'org');

  const newChild = `${SIDE_CHAT_MARKER}${crypto.randomUUID()}`;
  s.beforePrepare(() => lease(other, 'different-organization-token'));
  await assert.rejects(s.conn.call('chat.start', { ...s.request, chatId: newChild, key: crypto.randomUUID() }), {
    code: 'side_chat_parent_changed',
  });
  assert.equal(s.sends.length, 2);
  assert.deepEqual(s.retired, [newChild]);

  lease(account, 'current-organization-token');
  const entered = deferred<void>();
  const ready = deferred<void>();
  s.credentials!.ready = () => (entered.resolve(), ready.promise);
  const confirming = `${SIDE_CHAT_MARKER}${crypto.randomUUID()}`;
  const opening = s.conn.call('chat.start', { ...s.request, chatId: confirming, key: crypto.randomUUID() });
  const refused = assert.rejects(opening, { code: 'side_chat_parent_changed' });
  await entered.promise;
  lease(other, 'now-active-organization-token');
  ready.resolve();
  await refused;
  assert.deepEqual(s.prepared, [s.child, newChild]);
  assert.deepEqual(s.retired, [newChild, confirming]);
});

test('managed rules are still enforced after a side-chat start waits for native preparation', async () => {
  let allow = ['codex'];
  const policy = createPolicy({
    managedFile: {
      effectivePolicy: () => ({ state: 'valid', organization: 'Test', problem: null, doc: { harnesses: { allow } } }),
    },
  });
  const start = sideChatStart({
    log: createChatLog({ epoch: () => 0 }),
    epochs: { current: () => 0 },
    runtime: { sideChatParent: () => ({ kind: 'codex', id: 'native-id', key: 'native-id', instance: null, current: () => true }) },
    policy,
    report: () => undefined,
  });
  for (const by of [undefined, { kind: 'phone' }]) {
    allow = ['codex'];
    const input = { chatId: 'side', harness: 'codex', sideChat: { sourceId: 'parent', epoch: 0 }, by };
    await assert.rejects(
      start(input, ({ checkImages }) => {
        checkImages();
        allow = ['claude'];
        checkImages();
        assert.fail('the native send should be refused');
      }),
      { code: 'policy_refused' },
    );
  }
});

test('a failed release preserves the stale-parent refusal and reports the cleanup failure', async () => {
  const log = createChatLog({ epoch: () => 0 });
  log.finish('parent', { t: 'user', turnId: 'one', text: 'older question' });
  log.finish('parent', { t: 'assistant', turnId: 'one', text: 'latest response' });
  assert.deepEqual(log.recentItems('parent', 1), {
    items: [{ t: 'assistant', turnId: 'one', text: 'latest response' }],
    total: 2,
  });
  let epoch = 0;
  const fault = new Error('cleanup failed');
  const errors: unknown[] = [];
  const input = { chatId: 'child', harness: 'codex', sideChat: { sourceId: 'parent', epoch: 0 } };
  for (const runtime of [{}, { retire: async () => Promise.reject(fault) }]) {
    epoch = 0;
    const start = sideChatStart({ epochs: { current: () => epoch }, log, runtime, report: (error) => errors.push(error) });
    await assert.rejects(
      start(input, (p) => {
        epoch = 1;
        return p.checkImages();
      }),
      { code: 'side_chat_parent_changed' },
    );
  }
  assert.deepEqual(errors, [fault]);
  epoch = 0;
  const start = sideChatStart({
    epochs: { current: () => epoch },
    log,
    runtime: { retire: async () => assert.fail('a retryable send fault retired the chat') },
    report: () => undefined,
  });
  const sendError = new Error('The Host could not send the input.');
  await assert.rejects(
    start(input, () => Promise.reject(sendError)),
    (error) => error === sendError,
  );
});

test('only one first message can claim a child and a parent move during mode setup retires the allocation', async (t) => {
  const s = rig(t, 'codex', '');
  await s.seed();
  const entered = deferred<void>();
  const proceed = deferred<void>();
  s.beforeMode(() => {
    entered.resolve();
    return proceed.promise;
  });
  const first = s.conn.call('chat.start', { ...s.request, permission: 'read-only' });
  await entered.promise;
  await assert.rejects(s.conn.call('chat.start', { ...s.request, key: crypto.randomUUID() }), { code: 'side_chat_starting' });
  s.epochs.admit(s.parent, 3);
  proceed.resolve();
  await assert.rejects(first, { code: 'side_chat_parent_changed' });
  assert.deepEqual(s.prepared, [s.child]);
  assert.deepEqual(s.retired, [s.child]);
  assert.equal(s.sends.length, 1);
});

test('a different first request can retry with its original key if the start in progress never sent', async (t) => {
  const s = rig(t, 'codex', '');
  await s.seed();
  const entered = deferred<void>();
  const mode = deferred<void>();
  s.beforeMode(() => {
    entered.resolve();
    return mode.promise;
  });
  const first = s.conn.call('chat.start', { ...s.request, permission: 'read-only' });
  const rejected = assert.rejects(first);
  await entered.promise;
  const second = { ...s.request, key: crypto.randomUUID() };
  await assert.rejects(s.conn.call('chat.start', second), { code: 'side_chat_starting' });
  mode.reject(new Error('Permission could not be set'));
  await rejected;
  await s.conn.call('chat.start', second);
  assert.deepEqual(
    s.sends.map((p) => p.key),
    [s.parent, s.child],
  );
});

test('a native fork timeout preserves a retry with the same first message key', async (t) => {
  const s = rig(t, 'codex', '', true);
  await s.seed();
  s.beforePrepare(() => {
    throw new HostRefusal('side_chat_fork_timeout', 'Codex did not finish opening this side chat.');
  });
  await assert.rejects(s.conn.call('chat.start', s.request), { code: 'side_chat_fork_timeout' });
  assert.equal(s.sends.length, 1);
  s.beforePrepare(() => undefined);
  await s.conn.call('chat.start', s.request);
  assert.equal(s.sends[1].key, s.child);
  assert.equal(s.sends[1].clientId, s.request.key);
});

test('side chat ids require validated parent ownership and both peers must negotiate the feature', async (t) => {
  const s = rig(t, 'codex', '');
  await s.conn.call('host.hello', { ...helloParams(), features: helloParams().features.filter((f) => f !== SIDE_CHAT_FEATURE) });
  await assert.rejects(s.conn.call('chat.start', s.request), { code: 'feature_missing' });
  for (const sideChat of [undefined, [], {}, { sourceId: s.child, epoch: 2 }, { sourceId: s.parent, epoch: null }]) {
    assert.throws(() => parseParams('chat.start', { ...s.first, sideChat }), { code: 'invalid' });
  }
  assert.throws(() => parseParams('chat.start', { ...s.request, chatId: s.parent }), { code: 'invalid' });
  assert.equal(s.prepared.length, 0);
});

test('a held switch refuses the child and an empty, unchanged parent can start without a context block', async (t) => {
  const s = rig(t, 'acp:kimi', 'acp:kimi:');
  await s.conn.call('host.hello', helloParams());
  const input = { ...s.request, sideChat: { sourceId: s.parent, epoch: 0 } };
  s.switchTo('acp:kimi', 'claude');
  await assert.rejects(s.conn.call('chat.start', input), { code: 'side_chat_parent_changed' });
  s.switchTo(null);
  await s.conn.call('chat.start', { ...input, key: crypto.randomUUID() });
  assert.equal(s.sends[0].prefix, undefined);
});

test('a parent released during a failed epoch write cannot redirect the child to its destination', async () => {
  const records = new Map();
  const epochs = {
    current: () => 0,
    admit: () => {
      throw new Error('The epoch could not be saved.');
    },
  };
  const continueHost = createContinueHost({
    epochs,
    owners: {
      get: (id: string) => records.get(id) ?? null,
      put: (id: string, value: unknown) => void records.set(id, value),
      remove: (id: string) => void records.delete(id),
      entries: () => [...records],
    },
    busy: () => false,
    quiesce: async () => undefined,
  } as any);
  await assert.rejects(
    continueHost.commit({ chatId: 'parent', expectedEpoch: 0, targetHostId: 'destination', preparedId: 'move' }),
    /epoch could not be saved/,
  );
  const start = sideChatStart({
    epochs,
    continueHost,
    log: { deleted: () => false, items: () => [], recentItems: () => assert.fail('reading a released chat') },
    runtime: {},
    report: (error) => assert.fail(String(error)),
  });
  await assert.rejects(
    start({ chatId: 'child', harness: 'codex', sideChat: { sourceId: 'parent', epoch: 0 } }, () =>
      assert.fail('dispatching a stale start'),
    ),
    (e: any) => e.code === 'side_chat_parent_changed' && e.details === undefined,
  );
});

test('a long journal excerpt keeps the newest question and abbreviates a very long reply', async () => {
  const rows = Array.from({ length: 1_100 }, (_, n) => [
    { t: 'user', turnId: String(n), text: 'u'.repeat(180) },
    { t: 'assistant', turnId: String(n), text: 'a'.repeat(230) },
  ]).flat();
  rows.push(
    { t: 'user', turnId: 'latest', text: 'newest question' },
    { t: 'assistant', turnId: 'latest', text: `newest reply ${'a'.repeat(45_000)}` },
  );
  const start = sideChatStart({
    epochs: { current: () => 0 },
    log: {
      deleted: () => false,
      items: () => [],
      recentItems: (id, limit) => {
        assert.equal(id, 'parent');
        return { items: rows.slice(-limit), total: rows.length };
      },
    },
    runtime: {},
    report: (error) => assert.fail(String(error)),
  });
  let checks = 0;
  const result = (await start(
    { chatId: 'child', harness: 'codex', sideChat: { sourceId: 'parent', epoch: 0 }, checkImages: () => checks++ },
    (input) => input,
  )) as any;
  result.checkImages();
  assert.equal(checks, 2);
  assert.match(result.sideContext, /202 earlier items omitted/);
  assert.match(result.sideContext, /earlier characters omitted/);
  assert.match(result.sideContext, /newest question[\s\S]*newest reply/);
  assert.match(result.sideContext, /exchange is abbreviated/);
  assert.ok(result.sideContext.length < 36_500);
});

test('a parent turn cut at the journal boundary explains that its question could be outside the excerpt', async () => {
  const start = sideChatStart({
    epochs: { current: () => 0 },
    log: {
      deleted: () => false,
      items: () => [],
      recentItems: () => ({ items: [{ t: 'assistant', turnId: 't', text: 'latest reply' }], total: 2_001 }),
    },
    runtime: {},
    report: (error) => assert.fail(String(error)),
  });
  const effect = (p: any) => p.sideContext as string;
  const context = (await start({ chatId: 'child', harness: 'codex', sideChat: { sourceId: 'parent', epoch: 0 } }, effect)) as string;
  assert.match(context, /user’s message for this turn may be outside the excerpt/);
  assert.match(context, /Assistant: latest reply/);
});

test('the user can still ask about a selection when the cold history exceeds the read budget', async () => {
  const start = sideChatStart({
    epochs: { current: () => 0 },
    log: {
      deleted: () => false,
      items: () => [],
      recentItems: () => ({ items: [], total: 0, omittedForSize: true }),
    },
    runtime: {},
    report: (error) => assert.fail(String(error)),
  });
  const result = (await start(
    { chatId: 'child', harness: 'codex', text: 'selected passage', sideChat: { sourceId: 'parent', epoch: 0 } },
    (p) => p,
  )) as any;
  assert.equal(result.text, 'selected passage');
  assert.match(result.sideContext, /parent history was too large/);
});
