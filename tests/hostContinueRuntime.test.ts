// What a Host's chats answer a continue, over stand-ins for the stores and the switcher (host/src/continueRuntime.mjs): a chat is held by a running turn, a turn that is starting, a card or a waiting message, whichever family runs it (W); one agent is bound once however many messages ask (A); a record the store refuses fails the bind and leaves nothing claimed (B).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentCheck } from '../shared/host/continueFamilies.mjs';
import { createContinueRuntime } from '../host/src/continueRuntime.mjs';
// @ts-ignore: plain ESM without declarations
import { createContinueWiring } from '../host/src/continueWiring.mjs';
import { EventEmitter } from 'node:events';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { helloParams } from '../shared/host/schema.mjs';
import { createLedger } from '../host/src/ledger.mjs';

/** The runtime over fakes; `over` replaces any of them. */
function make(over: Record<string, any> = {}) {
  const records = new Map<string, any>();
  const claimed: string[][] = [];
  const unclaimed: string[] = [];
  const started: string[] = [];
  const announced: string[] = [];
  const closed: string[] = [];
  const acpChats = new Map<string, any>();
  const sessions = new Map<string, any>();
  const refs = new Map<string, { kind: string; key: string }>();
  const gone = new Set<string>();
  const runtime = createContinueRuntime({
    chats: { records, commit: (rec: any) => (records.set(rec.id, rec), true) },
    state: { has: (id: string) => sessions.has(id), get: (id: string) => sessions.get(id) },
    controller: () => ({
      ref: (id: string) => refs.get(id) ?? { kind: 'codex', key: id },
      invalidate: () => undefined,
      sessionGone: async (id: string) => gone.has(id),
      unclaim: (key: string) => void unclaimed.push(key),
    }),
    acpHost: Object.assign(new Map(), {
      chats: acpChats,
      starting: new Set<string>(),
      close: async (key: string) => void closed.push(key),
    }),
    switcher: {
      startNative: async (chatId: string, harness: string, _cwd: string, _model: null, claim: string[]) => {
        started.push(`${chatId}:${harness}`);
        claim.push(`key-${harness}`);
        claimed.push(claim);
        await new Promise((r) => setTimeout(r, 5));
        return { nativeId: `native-${started.length}` };
      },
    },
    provided: { acp: true, claude: true, codex: true },
    labels: { claude: 'Claude Code', codex: 'Codex' },
    starting: () => false,
    discard: () => undefined,
    cancel: async () => undefined,
    announce: (chatId: string, harness: string) => void announced.push(`${chatId}:${harness}`),
    ready: async () => undefined,
    ...over,
  } as any);
  return { runtime, records, sessions, acpChats, refs, gone, started, unclaimed, announced, closed };
}

test('W: a chat is held by a turn starting, running or waiting on a card, or by a waiting message; an idle one, or one the Host never saw, is not', () => {
  const { runtime, sessions, acpChats } = make({ starting: (id: string) => id === 'starting' });
  assert.equal(runtime.continueBusy('starting'), true, 'a message was taken off the queue and its turn has not started');
  assert.equal(runtime.continueBusy('unknown'), false);
  for (const turn of ['running', 'awaitingUser']) {
    sessions.set('c', { turn, queue: [] });
    assert.equal(runtime.continueBusy('c'), true, turn);
  }
  sessions.set('c', { turn: 'idle', queue: [{ id: 'm' }] });
  assert.equal(runtime.continueBusy('c'), true, 'a message waits');
  sessions.set('c', { turn: 'idle', queue: [] });
  assert.equal(runtime.continueBusy('c'), false);
  // an ACP session prompting, or starting, under the chat's own id or under the key its record names
  acpChats.set('c', { prompting: true });
  assert.equal(runtime.continueBusy('c'), true);
  acpChats.set('c', { prompting: false });
  assert.equal(runtime.continueBusy('c'), false);
});

test('W: the chat is served by an ACP session under its id or its record, or by a record of its own; and it is let go by stopping and dropping what waits', async () => {
  const calls: string[] = [];
  const { runtime, records, acpChats, refs, closed } = make({
    discard: (id: string) => void calls.push(`discard ${id}`),
    cancel: async (id: string) => void calls.push(`cancel ${id}`),
  });
  assert.equal(runtime.continueServes('c'), false);
  acpChats.set('c', {});
  assert.equal(runtime.continueServes('c'), true);
  acpChats.clear();
  records.set('c', { id: 'c', segments: [] });
  assert.equal(runtime.continueServes('c'), true);
  // a chat whose record names an ACP session by another key: busy and served by that key, and closed by it
  refs.set('c', { kind: 'acp:fake', key: 'acp:fake:abc' });
  acpChats.set('acp:fake:abc', { prompting: true });
  assert.equal(runtime.continueBusy('c'), true);
  assert.equal(runtime.continueServes('c'), true);
  await runtime.continueRetire('c');
  assert.deepEqual(calls, ['discard c', 'cancel c']);
  assert.deepEqual(closed, ['acp:fake:abc']);
  // a chat with no ACP session closes nothing
  await runtime.continueRetire('other');
  assert.deepEqual(closed, ['acp:fake:abc']);
});

test('A: two messages that ask to bind the same chat start one session; a handoff already bound, or an id that names the agent, starts none', async () => {
  const { runtime, records, started, announced, unclaimed, refs, gone } = make();
  const bind = (chatId: string, over: object = {}) =>
    runtime.bindContinued({ chatId, harness: 'claude', cwd: '/work', text: 'HANDOFF', ...over });
  await Promise.all([bind('c'), bind('c')]);
  assert.deepEqual(started, ['c:claude']);
  assert.deepEqual(announced, ['c:claude']);
  assert.deepEqual(unclaimed, ['key-claude'], 'what the start claimed for the chat is let go once it is recorded');
  assert.equal(records.get('c').segments[0].handoff.text, 'HANDOFF');
  // the same handoff again (a send retried, or the Host restarted): the session stands
  refs.set('c', { kind: 'claude', key: 'claude:native-1' });
  await bind('c');
  assert.deepEqual(started, ['c:claude']);
  // the agent lost that session before the chat's first message (Codex forgets a thread no message recorded, #5160): the handoff starts another
  gone.add('c');
  await bind('c');
  assert.deepEqual(started, ['c:claude', 'c:claude']);
  assert.equal(records.get('c').segments[0].nativeId, 'native-2');
  assert.equal(records.get('c').segments[0].handoff.text, 'HANDOFF');
  gone.clear();
  started.pop();
  // a chat whose id already names the agent gets the continue's own session too
  refs.set('named', { kind: 'acp:fake', key: 'acp:fake:x' });
  await bind('named', { harness: 'acp:fake' });
  assert.deepEqual(started, ['c:claude', 'named:acp:fake']);
  started.pop();
  // a kind that is no agent binds nothing
  await bind('odd', { harness: 'nonsense' });
  assert.deepEqual(started, ['c:claude']);
  // a chat that began here on the same agent comes back with a handoff of its own: a new session replaces the old
  records.set('began', { id: 'began', segments: [{ kind: 'claude', nativeId: 'old', handoff: null }], meta: { kept: true } });
  await bind('began');
  assert.deepEqual(started, ['c:claude', 'began:claude']);
  assert.equal(records.get('began').segments.length, 1);
  assert.equal(records.get('began').segments[0].nativeId, 'native-2');
  assert.deepEqual(records.get('began').meta, { kept: true }, 'what else the chat kept stays');
});

test('B: a record the store refuses fails the bind, and what the start claimed is let go; a failed bind can be asked again', async () => {
  let accept = false;
  const refusing = make({ chats: { records: new Map(), commit: () => accept } });
  await assert.rejects(
    refusing.runtime.bindContinued({ chatId: 'c', harness: 'claude', cwd: '/work', text: 'HANDOFF' }),
    /Couldn't record the chat's new session/,
  );
  assert.deepEqual(refusing.unclaimed, ['key-claude']);
  accept = true;
  await refusing.runtime.bindContinued({ chatId: 'c', harness: 'claude', cwd: '/work', text: 'HANDOFF' });
  assert.deepEqual(refusing.started, ['c:claude', 'c:claude']);
});

test('I: a Host wired without families answers a continue as it did, from its ACP host alone, and does not say it takes every family', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-acp-only-'));
  const quiet = { report: () => undefined };
  const closed: string[] = [];
  const host = {
    ids: ['fake'],
    chats: new Map<string, any>(),
    starting: new Set<string>(),
    close: async (id: string) => void closed.push(id),
  };
  const wiring = createContinueWiring({
    dataDir: dir,
    runtime: { host } as any,
    hostFs: { existingDirectory: async (p: any) => p } as any,
    epochs: createEpochStore(path.join(dir, 'e.json'), quiet),
    ledger: createLedger(path.join(dir, 'l'), quiet),
    report: () => undefined,
  });
  try {
    assert.equal((wiring.continueHost as any).takesFamilies, undefined);
    const ask = (chatId: string, key: string, harness = 'acp:fake') =>
      wiring.continueHost.prepare({ chatId, epoch: 1, key, harness, cwd: '/w', handoff: 'history' });
    // a chat its ACP host holds cannot be the target of its own
    // an older Host answers a Claude Code or Codex continue as before
    await assert.rejects(ask('claude:x', 'prep-key-0000', 'claude'), (e: any) => e.code === 'harness_not_configured');
    host.chats.set('acp:fake:a', { prompting: false });
    await assert.rejects(ask('acp:fake:a', 'prep-key-0001'), (e: any) => e.code === 'same_host');
    // a turn it is prompting, or starting, holds the chat; once released the session is closed
    const prepared = await ask('acp:fake:b', 'prep-key-0002');
    const commit = (chatId: string) =>
      wiring.continueHost.commit({ chatId, expectedEpoch: 1, targetHostId: 'other', preparedId: prepared.preparedId });
    host.chats.set('acp:fake:b', { prompting: true });
    await assert.rejects(commit('acp:fake:b'), (e: any) => e.code === 'turn_running' && /chat is busy/.test(e.message));
    host.chats.set('acp:fake:b', { prompting: false });
    host.starting.add('acp:fake:b');
    await assert.rejects(commit('acp:fake:b'), (e: any) => e.code === 'turn_running');
    host.starting.clear();
    const done = await commit('acp:fake:b');
    await wiring.continueHost.release({ chatId: 'acp:fake:b', epoch: done.epoch, preparedId: prepared.preparedId });
    assert.deepEqual(closed, ['acp:fake:b']);
  } finally {
    wiring.close();
  }
});

test('A: the agent a handoff names is bound before the first message is checked and sent, with the folder the message names or else the handoff\u2019s; a runtime that cannot bind still sends', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-bind-order-'));
  const quiet = { report: () => undefined };
  const steps: string[] = [];
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  let n = 0;
  const run = async (bind: boolean, p: object) => {
    steps.length = 0;
    const runtime: any = {
      host,
      send: async (a: any) => (steps.push(`send ${a.cwd}`), { turnId: 't' }),
      permit: () => true,
      familyOf: () => 'acp',
      ...(bind ? { bindContinued: async (a: any) => void steps.push(`bind ${a.chatId} ${a.harness} ${a.cwd} ${a.text}`) } : {}),
    };
    const epochs = createEpochStore(path.join(dir, `e${bind}.json`), quiet);
    const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, `l${bind}`), quiet) });
    const handoffs = { take: () => ({ text: 'EARLIER', cwd: '/there', harness: 'claude' }), done: () => undefined };
    const conn = createProtocol({ runtime, epochs, guard, status: () => ({ running: true }), handoffs }).connection(() => undefined);
    await conn.call('host.hello', helloParams());
    await conn.call('chat.send', { chatId: 'c', epoch: 1, key: `key-bind-${++n}-${bind}`, text: 'now', ...p });
    return [...steps];
  };
  assert.deepEqual(await run(true, {}), ['bind c claude /there EARLIER', 'send /there']);
  assert.deepEqual(await run(true, { cwd: '/here' }), ['bind c claude /here EARLIER', 'send /here']);
  assert.deepEqual(await run(false, {}), ['send /there']);
});

test('A: the machine\u2019s agents are read once for the checks of one continue, and again after a few seconds; a refused login says so', async () => {
  let reads = 0;
  let clock = 0;
  const row: any = { id: 'claude', detected: true, signedIn: false, reason: 'login-refused' };
  const check = createAgentCheck({
    rows: async () => (reads++, [row]),
    acpIds: () => [],
    now: () => clock,
  });
  const why = async () => (await check('claude').catch((e: any) => e)).details;
  assert.deepEqual(await why(), { agent: 'Claude Code', refused: true });
  assert.deepEqual(await why(), { agent: 'Claude Code', refused: true });
  assert.equal(reads, 1);
  clock = 4000;
  row.signedIn = true;
  await check('claude');
  assert.equal(reads, 2);
});
