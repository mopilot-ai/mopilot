// A message queued on the Host behind a running turn survives a Host restart (#4278 B): it is kept on disk while it waits, restored into the chat's queue by the next Host on the data folder, held as a queue is after a Stop, and sent once after the chat's next turn. A: order and ids; W: restart mid-turn, restart between dequeue and start; B: explicit removal and deletion leave nothing; I: an unreadable file is reported and kept.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonLineLog } from '../scripts/fixture-json-log.mjs';
// @ts-ignore: plain ESM without declarations
import { createAcpRuntime } from '../host/src/acp.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { createQueueStore } from '../host/src/queueStore.mjs';
import { createHostSessions } from '../host/src/sessions.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const AGENT = path.join(ROOT, 'tests/fixtures/fake-acp-agent.mjs');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-durable-queue-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const until = async (fn: () => any, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A Host's sessions on `dir` over the fake ACP agent: a second call on the same folder is the Host after a restart. */
function host(dir: string, families: any = undefined, quiet = false) {
  const log = path.join(dir, 'agent.jsonl');
  fs.writeFileSync(
    path.join(dir, 'harnesses.json'),
    JSON.stringify({
      fake: { label: 'Fake', bin: process.execPath, args: [AGENT], env: { FAKE_ACP_STATE: path.join(dir, 's'), FAKE_ACP_LOG: log } },
    }),
  );
  const paths = createPaths({ dataDir: dir, env: {} });
  const runtime = createAcpRuntime({ paths, env: {}, hostOptions: { cancelRetryMs: 5, cancelForceMs: 5000 } });
  const reported: string[] = [];
  const sessions = createHostSessions({ paths, env: {}, runtime, families, ...(quiet ? {} : { report: (m: string) => reported.push(m) }) });
  const events: any[] = [];
  sessions.chatRuntime.host.on('event', (e: any) => events.push(e));
  const prompts = () =>
    readJsonLineLog(log)
      .filter((l: any) => l.msg?.method === 'session/prompt')
      .map((l: any) => l.msg.params.prompt.map((b: any) => b.text ?? '').join(''));
  return {
    sessions,
    runtime,
    events,
    prompts,
    reported,
    queue: (key: string) => sessions.state.snapshot(key).queue,
    close: () => (sessions.close(), runtime.close()),
  };
}
const KEY = 'acp:fake:dq';
const files = (dir: string) => (fs.existsSync(path.join(dir, 'queues')) ? fs.readdirSync(path.join(dir, 'queues')) : []);

test('W: two messages queued behind a running turn are on disk; the next Host restores them in order, sends nothing by itself, and sends each once after the chat\u2019s next turn', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'a-'));
  const one = host(dir);
  await one.sessions.chatRuntime.send({ key: KEY, text: 'SLOW first', cwd: dir });
  await until(() => one.sessions.state.snapshot(KEY).turn === 'running');
  assert.equal((await one.sessions.chatRuntime.send({ key: KEY, text: 'second', clientId: 'c-2' })).action, 'queued');
  assert.equal((await one.sessions.chatRuntime.send({ key: KEY, text: 'third', clientId: 'c-3' })).action, 'queued');
  assert.equal(files(dir).length, 1);
  // the Host goes without ending its turn or draining its queue
  one.runtime.close();
  const two = host(dir);
  try {
    assert.deepEqual(
      two.queue(KEY).map((q: any) => [q.id, q.text]),
      [
        ['c-2', 'second'],
        ['c-3', 'third'],
      ],
    );
    // held, as after a Stop: the restart itself sends nothing
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(
      two.prompts().filter((p: string) => !p.includes('SLOW')),
      [],
    );
    assert.equal(files(dir).length, 1);
    // the chat's next message runs, and the restored ones follow it in the order they were sent
    await two.sessions.chatRuntime.send({ key: KEY, text: 'fourth', cwd: dir, clientId: 'c-4' });
    await until(() => two.prompts().filter((p: string) => p.includes('third')).length === 1);
    assert.deepEqual(
      two.prompts().filter((p: string) => !p.includes('SLOW')),
      ['fourth', 'second', 'third'],
    );
    // what the person wrote is told with each turn's start, under the id the app sent
    assert.deepEqual(
      two.events.filter((e) => e.kind === 'turnStart').map((e) => e.user?.clientId),
      ['c-4', 'c-2', 'c-3'],
    );
    await until(() => files(dir).length === 0);
  } finally {
    two.close();
  }
  // nothing is left for a third Host to send again
  const three = host(dir);
  try {
    assert.deepEqual(three.queue(KEY), []);
  } finally {
    three.close();
  }
});

test('B: a queued message that is removed, or whose chat is retired, leaves no file, and the next Host restores nothing', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'b-'));
  const one = host(dir);
  await one.sessions.chatRuntime.send({ key: KEY, text: 'SLOW first', cwd: dir });
  await until(() => one.sessions.state.snapshot(KEY).turn === 'running');
  // a message with no id of the app's own waits too
  await one.sessions.chatRuntime.send({ key: KEY, text: 'second' });
  assert.equal(files(dir).length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'queues', files(dir)[0]), 'utf8')).users, {});
  one.sessions.chatRuntime.discardQueued(KEY);
  assert.deepEqual(files(dir), []);
  one.runtime.close();
  const two = host(dir);
  try {
    assert.deepEqual(two.queue(KEY), []);
  } finally {
    two.close();
  }
});

test('W: a message taken off the queue whose turn had not started is still on disk, first in line; once its turn starts or ends it is not', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'c-'));
  const one = host(dir);
  const state = one.sessions.state;
  state.patch(KEY, {
    queue: [
      { id: 'q-1', text: 'one', attachments: [], opts: {} },
      { id: 'q-2', text: 'two', attachments: [], opts: {} },
    ],
  });
  const taken = state.takeNext(KEY, () => false);
  assert.equal(taken.id, 'q-1');
  assert.equal(
    state.takeNext('acp:fake:none', () => false),
    null,
  );
  const kept = () => JSON.parse(fs.readFileSync(path.join(dir, 'queues', files(dir)[0]), 'utf8')).items.map((i: any) => i.id);
  assert.deepEqual(kept(), ['q-1', 'q-2']);
  // put back by the controller while it is still counted as starting: once, not twice
  state.patch(KEY, { queue: [taken, ...state.get(KEY).queue] });
  assert.deepEqual(kept(), ['q-1', 'q-2']);
  one.runtime.close();
  const two = host(dir);
  try {
    assert.deepEqual(
      two.queue(KEY).map((q: any) => q.id),
      ['q-1', 'q-2'],
    );
  } finally {
    two.close();
  }
});

/** Stand-in Claude Code and Codex families: what each was asked, and the Host's own emit for a turn's events. */
function fakes() {
  const seen: any[] = [];
  const ctxOf: any = {};
  const families = {
    claude: (ctx: any) => {
      ctxOf.claude = ctx;
      return {
        claudeTurns: {
          startTurn: async (chatId: string, _ref: any, item: any) => (
            seen.push(['claude.start', chatId, item.id]), { started: true, turnId: item.id }
          ),
          stop: async () => undefined,
        },
        claude: {},
        prepare: async (key: string, cwd?: string) => void seen.push(['claude.prepare', key, cwd]),
        noteUser: (id: string, text: string, user: any) => void seen.push(['claude.note', id, text, user?.clientId ?? null]),
      };
    },
    codex: () => ({
      codex: {
        startTurn: async (chatId: string, _ref: any, item: any) => (
          seen.push(['codex.start', chatId, item.id]), { started: true, turnId: 'native' }
        ),
      },
      check: async () => {
        seen.push(['codex.check']);
        if (seen.some((x) => x[0] === 'codex.fail')) throw new Error('Codex is signed out here.');
      },
    }),
  };
  return { seen, ctxOf, families };
}
const item = (id: string, text = id) => ({ id, text, attachments: [], opts: {} });
const stored = (dir: string) => files(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, 'queues', f), 'utf8')));

test('A: Claude Code and Codex chats keep their queues the same way; a start or an end of the turn retires the taken message, and retiring the chat removes it at once', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'd-'));
  const one = host(dir, fakes().families);
  one.sessions.state.patch('claude:c1', { queue: [item('k1', 'for claude'), item('k2')] });
  one.sessions.state.patch('codex-thread', { queue: [item('x1'), item('x2')] });
  one.sessions.state.patch('acp:fake:gone', { queue: [item('g1'), item('g2')] });
  one.runtime.close();
  const f = fakes();
  const two = host(dir, f.families);
  try {
    const ids = (chatId: string) =>
      stored(dir)
        .find((r) => r.chatId === chatId)
        ?.items.map((i: any) => i.id);
    assert.deepEqual([two.queue('claude:c1').length, two.queue('codex-thread').length], [2, 2]);
    // taken to start: still first on disk
    assert.equal(two.sessions.state.takeNext('claude:c1', () => false).id, 'k1');
    assert.deepEqual(ids('claude:c1'), ['k1', 'k2']);
    // a start that names no chat, or a chat with nothing taken, changes nothing; its own start leaves only the one behind it
    f.ctxOf.claude.emit({ kind: 'turnStart', turnId: 'k1' });
    f.ctxOf.claude.emit({ kind: 'turnStart', key: 'claude:other', turnId: 'z' });
    assert.deepEqual(ids('claude:c1'), ['k1', 'k2']);
    f.ctxOf.claude.emit({ kind: 'turnStart', key: 'claude:c1', turnId: 'k1' });
    assert.deepEqual(ids('claude:c1'), ['k2']);
    // Codex's taken message is retired when its turn ends without a start being told
    assert.equal(two.sessions.state.takeNext('codex-thread', () => false).id, 'x1');
    two.sessions.state.patch('codex-thread', { turn: 'running' });
    assert.deepEqual(ids('codex-thread'), ['x1', 'x2']);
    two.sessions.state.patch('codex-thread', { turn: 'idle' });
    assert.deepEqual(ids('codex-thread'), ['x2']);
    // a chat retired while its message is being started keeps nothing, whether or not the store still has a queue for it
    assert.equal(two.sessions.state.takeNext('acp:fake:gone', () => false).id, 'g1');
    two.sessions.chatRuntime.discardQueued('acp:fake:gone');
    assert.equal(ids('acp:fake:gone'), undefined);
    two.sessions.chatRuntime.discardQueued('acp:fake:never');
    assert.equal(stored(dir).length, 2);
  } finally {
    two.close();
  }
});

test('I: waiting messages that cannot be saved or read are reported, a damaged file is kept, and the rest are restored', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'f-'));
  const one = host(dir);
  one.sessions.state.patch(KEY, { queue: [item('q-1')] });
  one.sessions.state.patch('acp:fake:other', { queue: [item('o-1')] });
  const [first] = files(dir);
  fs.writeFileSync(path.join(dir, 'queues', first), '{"chatId":"acp:fake:elsewhere","items":[]}');
  fs.writeFileSync(path.join(dir, 'queues', 'notes.txt'), 'not a queue');
  one.runtime.close();
  const two = host(dir);
  try {
    assert.equal(two.reported.length, 1);
    assert.match(two.reported[0], /could not be read and were kept/);
    assert.equal(fs.existsSync(path.join(dir, 'queues', first)), true);
    assert.equal(two.queue(KEY).length + two.queue('acp:fake:other').length, 1);
    // the folder becomes unwritable: the message still waits in memory, and the failure is said
    fs.rmSync(path.join(dir, 'queues'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'queues'), 'a file where the folder belongs');
    two.sessions.state.patch('acp:fake:new', { queue: [item('n-1')] });
    assert.match(two.reported.at(-1)!, /could not be saved/);
    assert.equal(two.queue('acp:fake:new').length, 1);
  } finally {
    two.close();
  }
  // a Host started on that folder still starts, and says it could not read what was waiting
  const three = host(dir);
  try {
    assert.match(three.reported[0], /could not be read: .*ENOTDIR/);
  } finally {
    three.close();
  }
});

test('B: a record of an older shape restores and can be removed; a Host given no reporter notes a failed save itself', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'g-'));
  const one = host(dir);
  // a message as an older Host kept it: no attachments, options or user content
  one.sessions.state.patch(KEY, { queue: [{ id: 'q-1', text: 'bare' }] });
  const [file] = files(dir);
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'queues', file), 'utf8'));
  assert.deepEqual(record.items, [{ id: 'q-1', text: 'bare', attachments: [], opts: {} }]);
  delete record.users;
  fs.writeFileSync(path.join(dir, 'queues', file), JSON.stringify(record));
  one.runtime.close();
  const two = host(dir, undefined, true);
  try {
    assert.equal(two.queue(KEY).length, 1);
    two.sessions.chatRuntime.discardQueued(KEY);
    assert.deepEqual(files(dir), []);
    fs.rmSync(path.join(dir, 'queues'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'queues'), 'not a folder');
    two.sessions.state.patch(KEY, { queue: [item('q-2')] });
    assert.equal(two.queue(KEY).length, 1);
  } finally {
    two.close();
  }
});

test('the store alone: nothing kept means no file call, a record replaces the last one whole, and removing the last message removes the file', () => {
  const dir = path.join(fs.mkdtempSync(path.join(base, 'h-')), 'queues');
  const reported: string[] = [];
  const store = createQueueStore({ dir, report: (m: string) => reported.push(m) });
  assert.deepEqual(store.all(), []);
  store.put('a', null);
  assert.equal(fs.existsSync(dir), false);
  store.put('a', { chatId: 'a', items: [{ id: '1', text: 'x' }] });
  store.put('a', { chatId: 'a', items: [{ id: '2', text: 'y' }] });
  // a write the last Host did not finish is cleared, and the record before it stands
  fs.writeFileSync(path.join(dir, 'x.999.tmp'), 'half');
  assert.deepEqual(createQueueStore({ dir, report: () => undefined }).all(), [{ chatId: 'a', items: [{ id: '2', text: 'y' }] }]);
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')),
    [],
  );
  store.put('a', { chatId: 'a', items: [] });
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.deepEqual(reported, []);
});

test('I: a folder sync that fails after the record is in place does not leave a file nothing removes, and a removal that fails is tried again', () => {
  const dir = path.join(fs.mkdtempSync(path.join(base, 'i-')), 'queues');
  let failSync = false;
  let failRemove = false;
  const io: any = {
    ...fs,
    fsyncSync: (fd: number) => {
      if (failSync) throw new Error('sync failed');
      return fs.fsyncSync(fd);
    },
    rmSync: (...a: [string, object]) => {
      if (failRemove) throw new Error('remove failed');
      return fs.rmSync(...a);
    },
  };
  const store = createQueueStore({ dir, io, report: () => undefined });
  const record = { chatId: 'a', items: [{ id: '1', text: 'x' }] };
  store.put('a', record);
  failSync = true;
  assert.throws(() => store.put('b', { chatId: 'b', items: [{ id: '2', text: 'y' }] }), /sync failed/);
  failSync = false;
  failRemove = true;
  assert.throws(() => store.put('a', null), /remove failed/);
  failRemove = false;
  store.put('a', null);
  store.put('b', null);
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.endsWith('.json')),
    [],
  );
});

test('#4278: every family’s failed turn leaves the Host with its code, set once where their events meet; other events pass as they are', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'd-'));
  const f = fakes();
  const one = host(dir, f.families);
  try {
    const end = (error: object | undefined, stopReason = 'error') => {
      f.ctxOf.claude.emit({ kind: 'turnEnd', key: 'claude:c1', turnId: 'k', stopReason, ...(error ? { error } : {}) });
      return one.events.at(-1);
    };
    assert.deepEqual(end({ message: 'Not logged in · Please run /login' }).error, {
      message: 'Not logged in · Please run /login',
      code: 'auth',
    });
    assert.deepEqual(end({ message: 'x', code: 'context' }).error, { message: 'x', code: 'context' });
    assert.deepEqual(end({ message: 'usage limit' }, 'cancelled').error, { message: 'usage limit' });
    const update = { kind: 'update', key: 'claude:c1', turnId: 'k', update: { sessionUpdate: 'plan', entries: [] } };
    f.ctxOf.claude.emit(update);
    assert.equal(one.events.at(-1), update);
  } finally {
    one.runtime.close();
  }
});
