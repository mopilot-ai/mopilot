// What a message picks and the mode a chat runs in (host/src/protocol.mjs, sessions.mjs), and the models `host.status` lists (host/src/cli.mjs). A: model and effort reach the runtime; W: the mode set at start and by chat.permit; B: a runtime that cannot set a mode refuses; I: the status of a real `serve` lists the models of a Codex that is installed and signed in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../host/src/cli.mjs';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { askHost } from '../host/src/server.mjs';
import { helloParams } from '../shared/host/schema.mjs';
import { base, installCodex, until } from './support/hostCodexKit.ts';

const quiet = { report: () => undefined };

function setup({ setMode = true, handoffs = undefined as any } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-pick-'));
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const calls: any[] = [];
  const runtime: any = {
    host,
    send: async (p: any) => (calls.push(['send', p]), { turnId: 't' }),
    prepare: async (p: any) => void calls.push(['prepare', p.chatId]),
    permit: () => true,
    familyOf: () => 'codex',
    ...(setMode ? { setMode: async (p: any) => void calls.push(['mode', p.value]) } : {}),
  };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const conn = createProtocol({ runtime, epochs, guard, status: () => ({ running: true }), handoffs }).connection(() => undefined);
  let n = 0;
  const call = (method: string, chatId: string, p: any = {}) => conn.call(method, { chatId, epoch: 1, key: `key-pick-${++n}-00`, ...p });
  return { conn, call, calls };
}

test('A: the model and effort a message names go to the runtime, and a message that names none sends no pick', async () => {
  const s = await setup();
  await s.conn.call('host.hello', helloParams());
  await s.call('chat.send', 'chat-a', { text: 'one', model: 'gpt-fake', effort: 'high' });
  await s.call('chat.send', 'chat-a', { text: 'two', effort: 'low' });
  await s.call('chat.send', 'chat-a', { text: 'three' });
  assert.deepEqual(
    s.calls.map(([, p]) => p.pick),
    [{ model: 'gpt-fake', effort: 'high' }, { effort: 'low' }, undefined],
  );
});

test('A: the first message of a continued chat carries the handoff in front and still carries its pick', async () => {
  const done: string[] = [];
  const s = await setup({ handoffs: { take: () => ({ text: 'EARLIER', cwd: '/there' }), done: (c: string) => done.push(c) } });
  await s.conn.call('host.hello', helloParams());
  const key = 'key-continued-0001';
  const input = { text: 'now', model: 'gpt-fake', key };
  await s.call('chat.send', 'chat-h', input);
  assert.deepEqual(s.calls[0][1], {
    key: 'chat-h',
    clientId: key,
    text: 'now',
    prefix: 'EARLIER',
    cwd: '/there',
    pick: { model: 'gpt-fake' },
  });
  assert.equal((await s.call('chat.send', 'chat-h', input)).replayed, true);
  assert.equal(s.calls.length, 1, 'the continued input reaches its native adapter once under the original identity');
  assert.deepEqual(done, ['chat-h']);
});

test('W: the mode a chat starts in is set before its first message, and chat.permit sets it for the turns after', async () => {
  const s = await setup();
  await s.conn.call('host.hello', helloParams());
  await s.call('chat.start', 'chat-w', { harness: 'codex', text: 'hi', permission: 'read-only' });
  await s.call('chat.start', 'chat-w2', { harness: 'codex', text: 'hi' });
  assert.deepEqual(
    s.calls.map((c) => c[0] + (c[0] === 'mode' ? `:${c[1]}` : '')),
    ['prepare', 'mode:read-only', 'send', 'prepare', 'send'],
  );
  const set: any = await s.call('chat.permit', 'chat-w', { value: 'full-access' });
  assert.deepEqual(set, { replayed: false, result: { permission: 'full-access', plan: false } });
  assert.deepEqual(s.calls.at(-1), ['mode', 'full-access']);
});

test('B: a runtime that cannot set a mode refuses chat.permit, and a start that names one still starts', async () => {
  const s = await setup({ setMode: false });
  await s.conn.call('host.hello', helloParams());
  await assert.rejects(s.call('chat.permit', 'chat-b', { value: 'read-only' }), (e: any) => e.code === 'unsupported');
  await s.call('chat.start', 'chat-b', { harness: 'codex', text: 'hi', permission: 'read-only' });
  assert.deepEqual(
    s.calls.map((c) => c[0]),
    ['prepare', 'send'],
  );
});

test('I: the status of a serving Host lists the models of a Codex that is installed and signed in, and none otherwise', async () => {
  const run = async (installed: boolean) => {
    const dir = fs.mkdtempSync(path.join(base, 'status-'));
    const env: Record<string, string> = installed ? installCodex(dir).env : { PATH: path.join(dir, 'none') };
    const signals = new EventEmitter();
    const lines: string[] = [];
    const done = main(['serve', '--data-dir', dir], {
      out: (l: string) => lines.push(l),
      err: () => undefined,
      env,
      signals: signals as any,
    });
    await until(() => lines.some((l) => l.startsWith('Host serving')));
    const status: any = await askHost(createPaths({ dataDir: dir, env: {} }).socketPath, 'status');
    signals.emit('SIGTERM');
    await done;
    return status.harnesses.find((h: any) => h.id === 'codex');
  };
  const codex = await run(true);
  assert.deepEqual(codex.models, [
    { id: 'gpt-fake', name: 'GPT Fake', resolvedModel: 'GPT Fake', default: true, efforts: ['low', 'high'] },
    { id: 'gpt-other', name: 'GPT Other', resolvedModel: 'GPT Other', default: false, efforts: [] },
  ]);
  const missing = await run(false);
  assert.deepEqual([missing.detected, missing.models], [false, undefined]);
});
