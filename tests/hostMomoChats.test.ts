// MoMo's chats on a Host, H2a (host/src/momoChats.mjs, host/src/sessions.mjs isolate): the main chat is made by the Host in a workspace it pins, tagged where no client can set or clear it, refused on any agent that cannot run isolated (Codex for now), and every chat.* request of it is gated; on Claude Code a real session of it runs with the isolated options.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createMomoHome } from '../host/src/momoHome.mjs';
// @ts-ignore
import { createMomoHidden } from '../host/src/momoWiring.mjs';
import { servedHost } from './support/hostClientsWorld.ts';
// @ts-ignore
import { Answered } from '../host/src/chatVeil.mjs';
import { createMomoChats } from '../host/src/momoChats.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
// @ts-ignore
import { createProtocol } from '../host/src/protocol.mjs';
// @ts-ignore
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore
import { createGuard } from '../host/src/guard.mjs';
// @ts-ignore
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';
import { base, until, idle } from './support/host/claudeKit.ts';
import { waitFor } from './support/waitFor.ts';
import { quiet, PROVIDER_ENV, world } from './support/host/momoChatsWorld.ts';
// @ts-ignore
import { createAcpRuntime } from '../host/src/acp.mjs';
// @ts-ignore
import { createHostSessions } from '../host/src/sessions.mjs';
// @ts-ignore
import { createPaths } from '../host/src/paths.mjs';

test('fail closed: a MoMo chat does not start before the isolation is applied, on Codex, or on an agent that cannot be kept apart', async () => {
  const w = await world({ isolate: false });
  try {
    await assert.rejects(
      w.chats.start({ harness: 'claude' }),
      (e: any) => e.code === 'momo_brain_unavailable' && /keeping this agent's MoMo chats apart/.test(e.message),
    );
    assert.equal(fs.existsSync(path.join(w.home.storage.dir, 'chats.json')), false, 'nothing was registered');
    w.h.sessions.isolate(w.chats.isMomoChat, w.chats.workspace);
    assert.equal(w.h.sessions.isolated('claude'), true);
    assert.equal(w.h.sessions.isolated('acp'), true);
    assert.equal(w.h.sessions.isolated('codex'), false, 'this Host runs no Codex, so none was isolated');
    // a family that was not isolated starts no MoMo chat
    const notAcp = createMomoChats({
      home: w.home,
      sessions: { chats: w.h.sessions.chats, isolated: (f: string) => f === 'claude' },
      epochs: w.epochs,
      env: PROVIDER_ENV,
    });
    await assert.rejects(
      notAcp.start({ harness: 'acp:opencode' }),
      (e: any) => e.code === 'momo_brain_unavailable' && /keeping this agent's MoMo chats apart/.test(e.message),
    );
    await assert.rejects(
      w.chats.start({ harness: 'codex' }),
      (e: any) =>
        e.code === 'momo_brain_unavailable' &&
        /isn't keeping this agent's MoMo chats apart/.test(e.message) &&
        e.details.fix === 'use_another_agent' &&
        e.details.fixLabel === 'Use another agent' &&
        e.details.agent === 'codex',
    );
    await assert.rejects(
      w.chats.start({ harness: 'acp:kimi' }),
      (e: any) => e.code === 'momo_brain_unavailable' && /can't be kept apart/.test(e.message),
    );
    assert.equal(fs.existsSync(path.join(w.home.storage.dir, 'chats.json')), false, 'a refused brain registers nothing');
    // an agent whose isolation is blocked on this machine says why, and nothing is registered
    const blocked = createMomoChats({
      home: w.home,
      sessions: w.h.sessions,
      epochs: w.epochs,
      env: { HOME: '/nonexistent-home', XDG_DATA_HOME: '/nonexistent-data' },
    });
    await assert.rejects(
      blocked.start({ harness: 'acp:opencode' }),
      (e: any) => e.code === 'momo_brain_unavailable' && /provider|model/i.test(e.message),
    );
    assert.equal(fs.existsSync(path.join(w.home.storage.dir, 'chats.json')), false);
  } finally {
    await w.h.close();
  }
});

test('the main chat is made once per agent, tagged in the registry and on its record, and a restart still knows it', async () => {
  const w = await world();
  try {
    const first = await w.chats.start({ harness: 'claude' });
    assert.match(first.chatId, /^claude:[0-9a-f-]{36}$/);
    assert.equal(first.epoch, 0);
    assert.equal(w.chats.isMomoChat(first.chatId), true);
    assert.equal(w.h.sessions.chats.records.get(first.chatId)?.meta?.momo, 'main');
    assert.equal(fs.statSync(w.chats.workspace).mode & 0o777, 0o700);
    assert.doesNotMatch(fs.readFileSync(path.join(w.home.storage.dir, 'chats.json'), 'utf8'), /claude:/, 'the registry is sealed');
    assert.equal((await w.chats.start({ harness: 'claude' })).chatId, first.chatId, 'the same main chat again');
    // a brain change makes a new main chat and the old one is a previous one: both stay MoMo's
    const acp = await w.chats.start({ harness: 'acp:opencode' });
    assert.match(acp.chatId, /^acp:opencode:/);
    const again = await w.chats.start({ harness: 'claude' });
    assert.notEqual(again.chatId, first.chatId);
    for (const id of [first.chatId, acp.chatId, again.chatId]) assert.equal(w.chats.isMomoChat(id), true);
    // the Host restarts: no record meta survives in this fake store, yet the registry knows them all; a chat tagged only by its record is MoMo's too
    const restarted = createMomoChats({
      home: w.home,
      sessions: {
        chats: { records: new Map([['claude:tagged', { meta: { momo: 'previous' } }]]), patchMeta: () => undefined },
        isolated: () => true,
      },
      epochs: w.epochs,
    });
    assert.deepEqual([first.chatId, acp.chatId, 'claude:tagged', 'claude:coding'].map(restarted.isMomoChat), [true, true, true, false]);
  } finally {
    await w.h.close();
  }
});

test('an unreadable registry is reported, and a chat the record tags is still MoMo’s', async () => {
  const w = await world();
  try {
    await w.chats.start({ harness: 'claude' });
    const reports: string[] = [];
    const other = createMomoHome({
      hostId: 'home-aaaa-1111',
      dataDir: w.momoDir,
      safeStorage: createFileSafeStorage(path.join(w.momoDir, 'other-keys')),
    });
    const chats = createMomoChats({
      home: other,
      sessions: {
        chats: { records: new Map([['claude:x', { meta: { momo: 'main' } }]]), patchMeta: () => undefined },
        isolated: () => true,
      },
      epochs: w.epochs,
      report: (m: string) => reports.push(m),
    });
    assert.equal(chats.isMomoChat('claude:x'), true);
    assert.equal(chats.isMomoChat('claude:y'), false);
    assert.match(reports.join(), /chat registry could not be read/);
    // with no report given the problem is not said anywhere, and the chat is still known by its record
    const silent = createMomoChats({
      home: other,
      sessions: { chats: { records: new Map(), patchMeta: () => undefined }, isolated: () => true },
      epochs: w.epochs,
    });
    assert.equal(silent.isMomoChat('claude:z'), false);
  } finally {
    await w.h.close();
  }
});

test('what a caller that may see a MoMo chat may do to it: not change its settings, agent or place; every message runs in the workspace with MoMo’s own model and effort', async () => {
  const w = await world();
  try {
    const { chatId } = await w.chats.start({ harness: 'claude' });
    const r = w.chats.rules;
    assert.deepEqual([r.state(chatId), r.state('claude:coding'), r.any()], ['hidden', 'open', true]);
    assert.deepEqual([r.seen(null), r.seen({ fingerprint: 'f', kind: 'desktop' })], [false, true]);
    for (const method of [
      'chat.start',
      'chat.permit',
      'chat.switch',
      'chat.login',
      'chat.prepareContinue',
      'chat.commitContinue',
      'chat.release',
      'chat.remove',
    ])
      await assert.rejects(
        async () => r.guard(method, { chatId }),
        (e: any) => e.code === 'momo_chat_fixed',
        method,
      );
    assert.deepEqual(
      await r.guard('chat.send', { chatId, key: 'key-00000099', text: 'hi', cwd: '/etc', pick: { model: 'opus', effort: 'max' } }),
      {
        chatId,
        key: 'key-00000099',
        text: 'hi',
        cwd: w.chats.workspace,
        pick: undefined,
      },
    );
    assert.deepEqual(await r.guard('chat.subscribe', { chatId }), { chatId });
    // without a live grant a paired client is as good as unpaired
    const ungranted = createMomoChats({
      home: { ...w.home, granted: () => false, hostOnlyStorage: w.home.hostOnlyStorage },
      sessions: w.h.sessions,
      epochs: w.epochs,
    });
    assert.equal(ungranted.rules.seen({ fingerprint: 'f', kind: 'desktop' }), false);
    assert.equal(
      createMomoChats({ home: w.home, sessions: w.h.sessions, epochs: w.epochs }).rules.any(),
      true,
      'a Host that has a MoMo chat',
    );
  } finally {
    await w.h.close();
  }
});

test('on a real Claude Code session of the Host a MoMo chat runs with the isolated options and in the workspace; a coding chat does not', async () => {
  const w = await world();
  try {
    const { chatId } = await w.chats.start({ harness: 'claude' });
    await w.h.sessions.chatRuntime.send({ key: chatId, text: 'remember this', cwd: w.chats.workspace });
    await idle(w.h, chatId);
    const [momo] = w.h.fake.queries;
    assert.deepEqual(momo.options.tools, [], 'none of Claude Code’s own tools: no shell, no file tools');
    assert.equal(momo.options.strictMcpConfig, true, 'no MCP servers of the user’s or a project’s');
    assert.equal(momo.options.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1', 'no CLAUDE.md, the user-level one included');
    assert.equal(momo.options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1', 'no harness memory');
    assert.equal(momo.options.cwd, w.chats.workspace);
    const key = `claude:${crypto.randomUUID()}`;
    await w.h.sessions.chatRuntime.send({ key, text: 'a coding chat', cwd: w.h.dir });
    await idle(w.h, key);
    const coding = w.h.fake.queries.at(-1)!;
    assert.notDeepEqual(coding.options.tools, []);
    assert.equal(coding.options.strictMcpConfig, undefined);
    assert.equal(coding.options.env?.CLAUDE_CODE_DISABLE_CLAUDE_MDS, undefined);
  } finally {
    await w.h.close();
  }
});

test('over the wire a granted client messages a MoMo chat in the workspace and cannot permit or start it; the same calls from a client without a grant never reach it', async () => {
  const w = await world();
  try {
    const { chatId } = await w.chats.start({ harness: 'claude' });
    const dir = fs.mkdtempSync(path.join(base, 'wire-'));
    const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
    const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
    const open = async (principal: unknown, momo: any = w.home) => {
      const conn = createProtocol({ runtime: w.h.sessions.chatRuntime, epochs, guard, status: () => ({}), momo, dataDir: dir }).connection(
        () => undefined,
        () => null,
        { principal: () => principal as any },
      );
      await conn.call('host.hello', helloParams());
      return conn;
    };
    const said = (p: Promise<unknown>) =>
      p.then(
        () => 'answered',
        (e: any) => `${e.code}:${e.message}`,
      );
    const send = { chatId, epoch: 0, key: 'key-00000001', text: 'hello MoMo', cwd: '/etc' };
    const granted = await open({ fingerprint: 'f', kind: 'desktop' });
    assert.match(
      await said(granted.call('chat.permit', { chatId, epoch: 0, key: 'key-00000002', value: 'full-access' })),
      /^momo_chat_fixed:/,
    );
    assert.match(
      await said(granted.call('chat.start', { chatId, epoch: 0, key: 'key-00000003', harness: 'claude', text: 'x', projectId: null })),
      /^momo_chat_fixed:/,
    );
    assert.ok(await granted.call('chat.send', send));
    // the ledger took the message by its key before it ran (the scripted harness may already have ended the turn)
    assert.ok(['accepted', 'completed'].includes((await granted.call('host.momoTurn', { turnId: 'key-00000001' })).state));
    assert.equal((await granted.call('host.momoTurn', { turnId: 'key-99999999' })).state, 'unknown');
    await assert.rejects(granted.call('host.momoTurn', { turnId: 'x' }), /not a turn id/);
    await until(() => w.h.fake.queries.some((q: any) => q.options.cwd === w.chats.workspace));
    // the same send again (a resend after a lost answer) is answered from the ledger and never reaches the runtime a second time (B1)
    const ran = w.h.fake.queries.length;
    const resent = await granted.call('chat.send', send);
    assert.deepEqual(resent.result ?? resent, { ...(resent.result ?? resent), duplicate: true, turnId: 'key-00000001' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(w.h.fake.queries.length, ran, 'no second run');
    // a send with no id never runs (B2)
    await assert.rejects(granted.call('chat.send', { chatId, epoch: 0, text: 'no id' }), /./);
    assert.equal(w.h.fake.queries.length, ran);
    assert.ok(w.h.fake.queries.every((q: any) => q.options.cwd !== '/etc'));
    // a chat that is not MoMo's is answered as it always was, and a Host with no MoMo service gates nothing
    assert.ok(
      await granted.call('chat.send', {
        chatId: `claude:${crypto.randomUUID()}`,
        epoch: 0,
        key: 'key-00000009',
        text: 'plain',
        cwd: w.h.dir,
      }),
    );
    const bare = await open({ fingerprint: 'f', kind: 'desktop' }, undefined);
    assert.ok(
      await bare.call('chat.send', { chatId: `claude:${crypto.randomUUID()}`, epoch: 0, key: 'key-00000010', text: 'plain', cwd: w.h.dir }),
    );
  } finally {
    await w.h.close();
  }
});

test('host.momoChat is veiled like the rest and starts the chat for a granted client', async () => {
  const w = await world();
  try {
    const dir = fs.mkdtempSync(path.join(base, 'wire2-'));
    const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
    const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
    const open = async (principal: unknown) => {
      const conn = createProtocol({ runtime: w.h.sessions.chatRuntime, epochs, guard, status: () => ({}), momo: w.home }).connection(
        () => undefined,
        () => null,
        { principal: () => principal as any },
      );
      await conn.call('host.hello', helloParams());
      return conn;
    };
    await assert.rejects((await open(null)).call('host.momoChat', { harness: 'claude' }), /Unknown request: host.momoChat/);
    const conn = await open({ fingerprint: 'f', kind: 'desktop' });
    const made = await conn.call('host.momoChat', { harness: 'claude' });
    assert.match(made.chatId, /^claude:/);
    await assert.rejects(conn.call('host.momoChat', { harness: 'codex' }), /isn't keeping this agent's MoMo chats apart/);
    await assert.rejects(conn.call('host.momoChat', { harness: 'gpt' }), /not an agent/);
  } finally {
    await w.h.close();
  }
});

test('isolation is recorded per family: a Host with no Claude Code isolates none for it, one with a Codex adapter hands it the rule, ACP is always covered', () => {
  const dir = fs.mkdtempSync(path.join(base, 'fam-'));
  const paths = createPaths({ dataDir: dir, env: {} });
  const runtime = createAcpRuntime({ paths, env: {} });
  const sets: any[] = [];
  const sessions = createHostSessions({
    paths,
    env: {},
    runtime,
    families: { codex: () => ({ codex: { setIsolated: (fn: any) => sets.push(fn) } }) },
  });
  try {
    assert.deepEqual(
      ['claude', 'codex', 'acp'].map((f) => sessions.isolated(f)),
      [false, false, false],
      'before isolate nothing is',
    );
    sessions.isolate((id: string) => id === 'm', path.join(dir, 'ws'));
    assert.deepEqual(
      ['claude', 'codex', 'acp'].map((f) => sessions.isolated(f)),
      [false, true, true],
    );
    assert.equal(sets[0]('m'), true, 'the Codex adapter was given the rule');
    assert.equal(sets[0]('other'), false);
  } finally {
    sessions.close();
    runtime.close();
  }
});

test('MoMo’s chat registry that fails to change refuses the chat, and the failure is reported', async () => {
  const w = await world();
  try {
    await w.chats.start({ harness: 'claude' });
    const real = createFileSafeStorage(path.join(w.momoDir, 'config'));
    let broken = false;
    const safe = {
      isEncryptionAvailable: () => true,
      encryptString: (v: string) => real.encryptString(v),
      decryptString: (b: Buffer) => {
        if (broken) throw new Error('key gone');
        return real.decryptString(b);
      },
    };
    const home: any = createMomoHome({ hostId: 'home-aaaa-1111', dataDir: w.momoDir, safeStorage: safe });
    const reports: string[] = [];
    const chats = createMomoChats({
      home,
      sessions: w.h.sessions,
      epochs: w.epochs,
      env: PROVIDER_ENV,
      report: (m: string) => reports.push(m),
    });
    assert.equal(chats.rules.state('x'), 'open', 'read once and kept');
    broken = true;
    await assert.rejects(chats.start({ harness: 'acp:opencode' }), (e: any) => e.code === 'momo_chat_not_started');
    assert.match(reports.join(), /could not be made/);
  } finally {
    await w.h.close();
  }
});

test('the tag is written before anything names the chat: a chat that cannot be tagged is not made, and a registry that cannot be written leaves a chat that is hidden anyway', async () => {
  const w = await world();
  try {
    const reports: string[] = [];
    // a store that takes the tag but does not keep it
    const forgetful: any = { chats: { records: new Map(), patchMeta: () => undefined }, isolated: () => true };
    const noTag = createMomoChats({
      home: w.home,
      sessions: forgetful,
      epochs: w.epochs,
      env: PROVIDER_ENV,
      report: (m: string) => reports.push(m),
    });
    await assert.rejects(noTag.start({ harness: 'claude' }), (e: any) => e.code === 'momo_chat_not_started');
    assert.match(reports.join(), /could not be tagged/);
    assert.equal(fs.existsSync(path.join(w.home.storage.dir, 'chats.json')), false, 'nothing was registered');
    // a registry that cannot be written: the chat's record carries the tag already
    const records = new Map<string, any>();
    const patchMeta = (id: string, patch: object) => records.set(id, { meta: { ...records.get(id)?.meta, ...patch } });
    const real = createFileSafeStorage(path.join(w.momoDir, 'config'));
    const noWrite = {
      isEncryptionAvailable: () => true,
      encryptString: () => {
        throw new Error('keychain locked');
      },
      decryptString: (b: Buffer) => real.decryptString(b),
    };
    const home: any = createMomoHome({ hostId: 'home-aaaa-1111', dataDir: w.momoDir, safeStorage: noWrite });
    const chats = createMomoChats({
      home,
      sessions: { chats: { records, patchMeta }, isolated: () => true },
      epochs: w.epochs,
      env: PROVIDER_ENV,
    });
    await assert.rejects(chats.start({ harness: 'claude' }), (e: any) => e.code === 'momo_chat_not_started');
    const [orphan] = [...records.keys()];
    assert.ok(orphan, 'a chat was tagged before the registry failed');
    assert.equal(chats.rules.state(orphan), 'hidden');
    assert.match(orphan, /-c0de[0-9a-f]{8}$/, 'and it has the form MoMo’s ids have');
  } finally {
    await w.h.close();
  }
});

test('the legacy line protocol: send to a MoMo chat is refused, any other chat is sent to as before, and an unpaired caller is refused before that', async (t) => {
  const w = await world({ isolate: true });
  const { chatId } = await w.chats.start({ harness: 'claude' });
  const hidden = createMomoHidden();
  hidden.bind(w.chats.isMomoChat);
  const sent: any[] = [];
  const host = await servedHost(t, {}, (runtime: any) => {
    runtime.send = async (p: any) => (sent.push(p), { turnId: 'legacy-1' });
    return hidden.guard(runtime);
  });
  try {
    await assert.rejects(host.line().request('send', { key: chatId, text: 'x' }), (e: any) => e.code === 'unknown_client');
    const { conn } = await host.paired('mac', 'Mac');
    await assert.rejects(conn.request('send', { key: chatId, text: 'x' }), (e: any) => e.code === 'momo_chat_fixed');
    assert.deepEqual(sent, [], 'it never reached the runtime');
    assert.deepEqual(await conn.request('send', { key: 'acp:kimi:plain', text: 'x' }), { turnId: 'legacy-1' });
    assert.equal(sent.length, 1);
    assert.equal(typeof (await conn.request('status')), 'object', 'what is not send is as it was');
  } finally {
    await w.h.close();
  }
});

test('the turn ledger: a message is accepted by its key before it acts, a resend is the same turn, a second while one is open is busy, the turn end settles it, and a home that is not running takes none', async () => {
  const w = await world();
  try {
    const { chatId } = await w.chats.start({ harness: 'claude' });
    const principal = { fingerprint: 'phone-fp', kind: 'phone' };
    /** The turn's state once the Host's own event path has settled it. */
    const settled = async (id: string, state: string) => {
      await waitFor(async () => (await w.home.turn(id)).state === state, `turn ${id} to read ${state}`);
    };
    const send = (key: string) => w.chats.rules.guard('chat.send', { chatId, key, text: 'hi' }, principal);
    await send('key-00000001');
    const first: any = await w.home.turn('key-00000001');
    assert.deepEqual([first.state, first.deviceId, first.leaseEpoch], ['accepted', 'phone-fp', 1]);
    await send('key-00000001'); // the resend after a lost answer is the same turn
    await assert.rejects(send('key-00000002'), (e: any) => e.code === 'turn_busy');
    assert.equal((await w.home.turn('key-00000077')).state, 'unknown', 'never accepted: the device may send it again under the same id');
    assert.equal((await w.home.turn('key-00000077')).state, 'unknown', 'asking changed nothing');
    // a coding chat and a turn end the ledger has no turn for change nothing; a turn end of the MoMo chat settles its turn
    w.home.turnEnded('claude:not-momo', { kind: 'turnEnd' });
    w.home.turnEnded(chatId, { kind: 'turnEnd', stopReason: 'end_turn' });
    await settled('key-00000001', 'completed');
    await send('key-00000002');
    // a resend of a turn the home has: answered from the ledger, never passed on to run again (B1)
    const again = await send('key-00000001');
    assert.ok(again instanceof Answered);
    assert.deepEqual(again.value, { duplicate: true, turnId: 'key-00000001', state: 'completed' });
    // a message with no valid id is refused, never run without a record (B2)
    for (const key of [undefined, 5, '', 'short', 'has space in it', null])
      await assert.rejects(
        w.chats.rules.guard('chat.send', { chatId, key, text: 'x' }),
        (e: any) => e.code === 'turn_id_required',
        String(key),
      );
    // no principal: the ledger keeps no device
    w.home.turnEnded(chatId, { kind: 'turnEnd', error: { message: 'boom' } });
    await settled('key-00000002', 'failed');
    await w.chats.rules.guard('chat.send', { chatId, key: 'key-00000003', text: 'again' });
    assert.equal(((await w.home.turn('key-00000003')) as any).deviceId, null);
    // the home stops running (a move): no message is taken, no status is answered, but a turn end still settles
    await w.home.swap(1, (h: any) => {
      h.state = 'moving';
      return false;
    });
    await assert.rejects(send('key-00000004'), (e: any) => e.code === 'momo_home_away');
    await assert.rejects(w.home.turn('key-00000003'), (e: any) => e.code === 'momo_home_away');
    w.home.turnEnded(chatId, { kind: 'turnEnd', stopReason: 'cancelled' });
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await w.home.close();
  }
});

test('a Host that is not the home refuses a message to a MoMo chat and answers no turn status', async () => {
  const w = await world({ started: false });
  try {
    // a chat that exists from an earlier home, on a Host whose record says none
    const chatId = `claude:${crypto.randomUUID()}`;
    await assert.rejects(
      w.chats.rules.guard('chat.send', { chatId, key: 'key-00000001', text: 'hi' }),
      (e: any) => e.code === 'momo_home_away',
    );
    await assert.rejects(w.home.turn('key-00000001'), (e: any) => e.code === 'momo_home_away');
    w.home.turnEnded(chatId, { kind: 'turnEnd' }); // nothing is open: nothing happens, nothing throws
  } finally {
    await w.home.close();
  }
});
