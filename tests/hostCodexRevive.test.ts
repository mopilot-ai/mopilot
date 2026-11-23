// A Codex chat whose thread no message recorded when Codex quit (#5160): the Codex family gives it a new thread before its next message (host/src/codexFamily.mjs revive, started from check), and the adapter keeps what an exit took (CodexAdapter.lostUnrecorded), with the controller and the app-server stood in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexFamily, LANE } from '../host/src/codexFamily.mjs';

/** The family over a stand-in controller and chat store: `committed` are the records it saved, `calls` the controller's claims. */
function setup(o: { kind?: string; recorded?: boolean; source?: 'key' } = {}) {
  const calls: any[] = [];
  const committed: any[] = [];
  let refuseCommit = false;
  const controller: any = {
    chatOf: (id: string) => id,
    ref: () => ({ kind: o.kind ?? 'codex', id: 'th', key: 'th' }),
    claim: (key: string, chat: string) => calls.push(['claim', key, chat]),
    unclaim: (key: string, chat: string) => calls.push(['unclaim', key, chat]),
    invalidate: () => calls.push(['invalidate']),
    onCodexExit: () => [],
  };
  const ctx: any = {
    paths: { dataDir: '/data' },
    state: { has: () => false, get: () => ({ approvals: [], turn: 'idle' }), all: () => [] },
    chats: {
      records: new Map(o.recorded === false ? [] : [['chat', {}]]),
      get: () => null,
      record: (id: string) => ({
        id,
        segments: [
          { kind: 'codex', nativeId: 'old', handoff: null },
          { kind: 'codex', nativeId: 'th', handoff: { mode: 'continue' } },
        ],
      }),
      commit: (r: any) => (refuseCommit ? false : !!committed.push(r)),
    },
    controller: () => controller,
    emit: () => undefined,
  };
  const family = createCodexFamily({
    env: {},
    which: () => '/bin/codex',
    probe: (async () => true) as any,
    now: () => 1000,
    ...(o.source ? { credentials: { sourceOf: () => o.source ?? null } } : {}),
  })(ctx);
  const started: any[] = [];
  const server = family.codex.server;
  server.send = () => undefined;
  server.stop = () => undefined;
  return { family, adapter: family.codex, calls, committed, started, refuse: () => (refuseCommit = true) };
}

test('a chat whose thread Codex lost before its first message gets a new one in the same segment, claimed while it starts', async () => {
  const s = setup();
  s.adapter.startThread = async (params: any, opts: any) => {
    s.started.push(params);
    opts.onThread('th-new');
    return { thread: { id: 'th-new' } };
  };
  // nothing lost: no thread
  await s.family.revive('chat');
  assert.equal(s.started.length, 0);
  // a thread lost with its process, whose folder is known
  s.adapter.lostUnrecorded.set('th', '/work');
  await s.family.revive('chat');
  assert.equal(s.started[0].cwd, '/work');
  assert.equal(s.started[0].ephemeral, false);
  assert.deepEqual(
    s.committed[0].segments.map((x: any) => x.nativeId),
    ['old', 'th-new'],
  );
  assert.deepEqual(s.committed[0].segments[1].handoff, { mode: 'continue' }, 'the handoff stays with the segment');
  assert.equal(s.adapter.lostUnrecorded.has('th'), false);
  assert.deepEqual(s.calls, [['claim', 'th-new', 'chat'], ['invalidate'], ['unclaim', 'th-new', 'chat']]);
  // a lost thread with no known folder starts in the Host's data dir
  s.adapter.lostUnrecorded.set('th', null);
  await s.family.revive('chat');
  assert.equal(s.started[1].cwd, '/data');
});

test('a chat on a credential the main app-server is not running on gets its new thread in that credential’s app-server', async () => {
  const s = setup({ source: 'key' });
  s.adapter.lostUnrecorded.set('th', null);
  let params: any = null;
  s.adapter.startThread = async (p: any) => ((params = p), { thread: { id: 'th-new' } });
  await s.family.revive('chat');
  assert.equal(params[LANE], 'key');
  await s.family.prepare({ chatId: 'new' });
  assert.equal(params[LANE], 'key');
});

test('a new thread that has no id, or a record the store refuses, leaves the loss to be tried again', async () => {
  const s = setup();
  s.adapter.lostUnrecorded.set('th', null);
  s.adapter.startThread = async () => ({});
  await assert.rejects(s.family.revive('chat'), /didn't start a thread/);
  s.adapter.startThread = async () => ({ thread: { id: 'th-x' } });
  const deleted: string[] = [];
  s.adapter.threadDelete = async (id: string) => void deleted.push(id);
  s.refuse();
  await assert.rejects(s.family.revive('chat'), /Couldn't record/);
  assert.deepEqual(deleted, ['th-x']);
  assert.equal(s.adapter.lostUnrecorded.has('th'), true);
});

test('a chat on another family has no Codex thread to lose', async () => {
  const s = setup({ kind: 'claude' });
  s.adapter.lostUnrecorded.set('th', null);
  s.adapter.startThread = async () => assert.fail('no thread for a Claude Code chat');
  await s.family.revive('chat');
  assert.equal(s.committed.length, 0);
});

test('the check revives a chat the Host holds, and none the Host has no record of yet', async () => {
  const known = setup();
  known.adapter.lostUnrecorded.set('th', null);
  known.adapter.startThread = async () => ({ thread: { id: 'th-new' } });
  await known.family.check('chat');
  assert.equal(known.committed.length, 1);
  const fresh = setup({ recorded: false });
  fresh.adapter.lostUnrecorded.set('th', null);
  fresh.adapter.startThread = async () => assert.fail('a chat with no record is prepared, not revived');
  await fresh.family.check('chat');
});

test('the app-server quitting keeps the threads no message recorded as lost, with their folder', () => {
  const s = setup();
  s.adapter.unrecorded.add('th');
  s.adapter.meta.set('th', { cwd: '/work' });
  s.adapter.unrecorded.add('bare');
  s.adapter.onServer({ kind: 'exit' });
  assert.deepEqual(
    [...s.adapter.lostUnrecorded],
    [
      ['th', '/work'],
      ['bare', null],
    ],
  );
  assert.equal(s.adapter.unrecorded.size, 0);
});
