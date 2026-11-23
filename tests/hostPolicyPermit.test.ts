// The ceiling on the wire (host/src/protocol.mjs, plan U2): chat.start and chat.permit above the owner's ceiling are refused before they run, on every harness; host.policy replaces the owner layer; host.status carries the policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createProtocol } from '../host/src/protocol.mjs';
// @ts-ignore
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore
import { createGuard } from '../host/src/guard.mjs';
// @ts-ignore
import { createPolicy } from '../host/src/policy.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';
// @ts-ignore
import { hostStatus } from '../host/src/status.mjs';

const quiet = { report: () => undefined };
const key = (n: number) => `key-${String(n).padStart(8, '0')}`;
const HARNESSES = [
  { harness: 'claude', chatId: 'claude:c1' },
  { harness: 'codex', chatId: '019e0000-0000-7000-8000-000000000001' },
  { harness: 'acp:fake', chatId: 'acp:fake:c1' },
];

function setup(kind: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-policy-wire-'));
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const modes: any[] = [];
  const sends: any[] = [];
  const runtime: any = {
    host,
    send: async (p: any) => (sends.push(p), { turnId: `t${sends.length}` }),
    prepare: async () => undefined,
    setMode: async (p: any) => void modes.push(p),
  };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const policy = createPolicy({ dataDir: dir });
  const protocol = createProtocol({
    runtime,
    epochs,
    guard,
    policy,
    status: () => hostStatus({ running: true, policy: policy.status() }),
  });
  const conn = protocol.connection(
    () => undefined,
    () => null,
    { principal: (() => ({ kind })) as any },
  );
  return { conn, sends, modes, policy };
}
const hello = (conn: any) => conn.call('host.hello', helloParams());
const doc = (d: object) => ({ version: 1, ...d });

for (const { harness, chatId } of HARNESSES) {
  test(`${harness}: a mode above the ceiling never reaches the chat, from chat.start or chat.permit`, async () => {
    const { conn, sends, modes } = setup('desktop');
    await hello(conn);
    await conn.call('host.policy', { doc: doc({ permissionMax: 'default' }) });
    const start = { chatId, epoch: 1, harness, text: 'hi', permission: 'full-access' };
    await assert.rejects(
      conn.call('chat.start', { ...start, key: key(1) }),
      (e: any) => e.code === 'policy_refused' && e.details.max === 'default',
    );
    await assert.rejects(
      conn.call('chat.permit', { chatId, epoch: 1, key: key(2), value: 'full-access' }),
      (e: any) => e.code === 'policy_refused',
    );
    assert.deepEqual([sends.length, modes.length], [0, 0]);
    await conn.call('chat.permit', { chatId, epoch: 1, key: key(3), value: 'default' });
    assert.deepEqual(
      modes.map((m) => m.value),
      ['default'],
    );
  });
}

test('a ceiling of read-only still lets a chat plan, and nothing lies below read-only to refuse it', async () => {
  const { conn, modes } = setup('desktop');
  await hello(conn);
  await conn.call('host.policy', { doc: doc({ permissionMax: 'read-only' }) });
  await conn.call('chat.permit', { chatId: 'codex-1', epoch: 1, key: key(1), value: 'plan' });
  assert.deepEqual(
    modes.map((m) => m.value),
    ['plan'],
  );
  // anything above the ceiling is still refused, and a mode no ceiling names is refused before it runs
  await assert.rejects(
    conn.call('chat.permit', { chatId: 'codex-1', epoch: 1, key: key(2), value: 'default' }),
    (e: any) => e.code === 'policy_refused' && e.details.max === 'read-only',
  );
  await assert.rejects(conn.call('host.policy', { doc: doc({ permissionMax: 'plan' }) }), /ceiling from the list/);
  assert.deepEqual(modes.length, 1);
});

test('a phone cannot set Full access even when the ceiling allows it, and cannot replace the policy', async () => {
  const { conn, modes } = setup('phone');
  await hello(conn);
  await assert.rejects(
    conn.call('chat.permit', { chatId: 'claude:c1', epoch: 1, key: key(1), value: 'full-access' }),
    (e: any) => e.code === 'policy_refused' && e.details.max === 'auto-review',
  );
  await assert.rejects(conn.call('host.policy', { doc: doc({}) }), (e: any) => e.code === 'policy_refused' && e.details.key === 'caller');
  await conn.call('chat.permit', { chatId: 'claude:c1', epoch: 1, key: key(2), value: 'auto-review' });
  assert.equal(modes.length, 1);
});

test('host.policy answers a generation, an invalid document leaves the previous one, and host.status reports it', async () => {
  const { conn } = setup('cli');
  await hello(conn);
  const { generation } = await conn.call('host.policy', { doc: doc({ permissionMax: 'read-only' }) });
  await assert.rejects(
    conn.call('host.policy', { doc: { version: 1, permissionMax: 'root' } }),
    (e: any) => e.code === 'invalid_request' || /ceiling/.test(e.message),
  );
  const status = await conn.call('host.status', {});
  assert.deepEqual(status.policy, { generation, managed: false, locked: [] });
});

test('without a policy resolver the Host says it cannot keep one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-policy-none-'));
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const protocol = createProtocol({ runtime: { host, send: async () => ({ turnId: 't' }) } as any, epochs, guard, status: () => ({}) });
  const conn = protocol.connection(() => undefined);
  await hello(conn);
  await assert.rejects(conn.call('host.policy', { doc: doc({}) }), /cannot keep a policy/);
});

test('a connection whose principal is missing or has no kind is a desktop’s', async () => {
  for (const principal of [() => null, () => ({})]) {
    const { conn, policy } = setup('desktop');
    void policy;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-policy-kind-'));
    const host: any = new EventEmitter();
    host.cancel = () => undefined;
    const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
    const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
    const protocol = createProtocol({
      runtime: { host, send: async () => ({ turnId: 't' }), setMode: async () => undefined } as any,
      epochs,
      guard,
      policy: createPolicy({ dataDir: dir }),
      status: () => ({}),
    });
    const c = protocol.connection(
      () => undefined,
      () => null,
      { principal: principal as any },
    );
    void conn;
    await hello(c);
    assert.deepEqual(await c.call('host.policy', { doc: doc({}) }).then((r: any) => Object.keys(r)), ['generation']);
  }
});

test('Plan from the first message runs on the mode the person picked: that mode is entered first, then Plan; a pick above the ceiling is refused with the rest, and a base with no Plan enters nothing', async () => {
  const { conn, modes } = setup('desktop');
  await hello(conn);
  const start = { chatId: '019e0000-0000-7000-8000-000000000002', epoch: 1, harness: 'codex', text: 'hi' };
  await conn.call('chat.start', { ...start, key: key(1), permission: 'plan', planBase: 'auto-review' });
  assert.deepEqual(
    modes.map((m) => m.value),
    ['auto-review', 'plan'],
  );
  modes.length = 0;
  await conn.call('chat.start', {
    ...start,
    chatId: '019e0000-0000-7000-8000-000000000003',
    key: key(2),
    permission: 'default',
    planBase: 'auto-review',
  });
  assert.deepEqual(
    modes.map((m) => m.value),
    ['default'],
  );
  modes.length = 0;
  await conn.call('host.policy', { doc: doc({ permissionMax: 'default' }) });
  await assert.rejects(
    conn.call('chat.start', {
      ...start,
      chatId: '019e0000-0000-7000-8000-000000000004',
      key: key(3),
      permission: 'plan',
      planBase: 'full-access',
    }),
    (e: any) => e.code === 'policy_refused' && e.details.max === 'default',
  );
  assert.equal(modes.length, 0);
  // a base with no Plan is not entered, so it is not held to the ceiling either
  await conn.call('chat.start', {
    ...start,
    chatId: '019e0000-0000-7000-8000-000000000005',
    key: key(4),
    permission: 'default',
    planBase: 'full-access',
  });
  assert.deepEqual(
    modes.map((m) => m.value),
    ['default'],
  );
});

test('a message to an ACP chat whose mode was set above a ceiling that dropped since is refused before it runs, until a mode within the ceiling is set; Claude Code and Codex chats are clamped by their families instead and still run', async () => {
  for (const { harness, chatId } of HARNESSES) {
    const { conn, sends } = setup('desktop');
    await hello(conn);
    await conn.call('chat.permit', { chatId, epoch: 1, key: key(1), value: 'full-access' });
    await conn.call('chat.send', { chatId, epoch: 1, key: key(2), text: 'still allowed' });
    assert.equal(sends.length, 1, `${harness}: before the ceiling drops the message runs`);
    await conn.call('host.policy', { doc: doc({ permissionMax: 'default' }) });
    if (!chatId.startsWith('acp:')) {
      await conn.call('chat.send', { chatId, epoch: 1, key: key(3), text: 'run under the ceiling' });
      assert.equal(sends.length, 2, `${harness}: its family holds the turn to the ceiling`);
      continue;
    }
    await assert.rejects(
      conn.call('chat.send', { chatId, epoch: 1, key: key(3), text: 'now over the ceiling' }),
      (e: any) => e.code === 'policy_refused' && e.details.max === 'default',
      harness,
    );
    assert.equal(sends.length, 1, `${harness}: nothing ran`);
    await conn.call('chat.permit', { chatId, epoch: 1, key: key(4), value: 'default' });
    await conn.call('chat.send', { chatId, epoch: 1, key: key(5), text: 'within it again' });
    assert.equal(sends.length, 2, `${harness}: the mode is within the ceiling again`);
  }
});

test('a message with followUp steer reaches the runtime as such, and one without it does not (#4916)', async () => {
  const { conn, sends } = setup('desktop');
  await hello(conn);
  const chatId = '019e0000-0000-7000-8000-000000000009';
  await conn.call('chat.send', { chatId, epoch: 1, key: key(1), text: 'into the turn', followUp: 'steer' });
  await conn.call('chat.send', { chatId, epoch: 1, key: key(2), text: 'plain' });
  assert.deepEqual(
    sends.map((s) => s.followUp),
    ['steer', undefined],
  );
});
