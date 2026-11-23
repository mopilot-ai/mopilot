// The parts of a Host's chat deletion (host/src/chatRetire.mjs, chatRemoval.mjs, ledger.mjs retire/clients, chatImages.mjs forgetChat): each family's own session goes, a step that fails is said and retried, and what is not the chat's content is all that stays.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createChatRetire } from '../host/src/chatRetire.mjs';
import { createAgentLeftovers } from '../host/src/agentLeftovers.mjs';
import { createChatRemoval } from '../host/src/chatRemoval.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createHostImages } from '../host/src/chatImages.mjs';
import { FILE_MIME } from '../shared/host/files.mjs';

const require = createRequire(import.meta.url);
const { ChatsStore } = require('../electron/platform/chats.cjs');
const { segment, emptyRecord } = require('../electron/platform/chatRecord.cjs');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-retire-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const tmp = () => fs.mkdtempSync(path.join(base, 'd-'));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const quiet = { report: () => {} };

/** A real chat store in a folder of its own, with a record on disk for each id. */
function store(ids: string[]) {
  const dir = tmp();
  const chats = new ChatsStore(dir, { legacyMirror: false });
  for (const id of ids) assert.equal(chats.ensure(id), true);
  const has = (id: string) => fs.existsSync(path.join(dir, `${encodeURIComponent(id)}.v2`));
  return { chats, has };
}
const families = (calls: string[], fail: Record<string, string> = {}) => ({
  acpHost: { remove: (key: string) => calls.push(`acp ${key}`) },
  claude: {
    claude: {
      deleteSession: async (id: string) => {
        calls.push(`claude ${id}`);
        if (fail.claude) throw new Error(fail.claude);
      },
    },
  },
  codex: {
    codex: {
      threadDelete: async (id: string) => {
        calls.push(`codex ${id}`);
        if (fail.codex) throw new Error(fail.codex);
      },
    },
  },
});

for (const [id, call] of [
  ['claude:11111111-1111-4111-8111-111111111111', 'claude 11111111-1111-4111-8111-111111111111'],
  ['22222222-2222-4222-8222-222222222222', 'codex 22222222-2222-4222-8222-222222222222'],
  ['acp:kimi:33333333-3333-4333-8333-333333333333', 'acp acp:kimi:33333333-3333-4333-8333-333333333333'],
])
  test(`${id.split(':')[0]}: the chat's own session is removed through its family, then its record leaves the disk and no event writes it back`, async () => {
    const { chats, has } = store([id, 'acp:kimi:other']);
    const calls: string[] = [];
    const retire = createChatRetire({ chats, ...families(calls), report: () => assert.fail('nothing to report') });
    assert.equal(has(id), true);
    await retire(id);
    assert.deepEqual(calls, [call]);
    assert.equal(has(id), false);
    // a late event for it is refused, and another chat is untouched
    assert.equal(chats.ensure(id), false);
    assert.equal(chats.patchMeta(id, { archived: 1 }), false);
    assert.equal(has(id), false);
    assert.equal(has('acp:kimi:other'), true);
  });

test('a session its agent no longer has is deleted already; any other failure is said, keeps the record, and a retry finishes', async () => {
  const claudeId = 'claude:44444444-4444-4444-8444-444444444444';
  const codexId = '55555555-5555-4555-8555-555555555555';
  const { chats, has } = store([claudeId, codexId]);
  const gone = createChatRetire({
    chats,
    ...families([], { claude: 'Session 44444444 not found', codex: 'no rollout found for thread id 5555' }),
    report: () => {},
  });
  await gone(claudeId);
  await gone(codexId);
  assert.deepEqual([has(claudeId), has(codexId)], [false, false]);

  const again = 'claude:66666666-6666-4666-8666-666666666666';
  const kept = store([again]);
  const failing = createChatRetire({ chats: kept.chats, ...families([], { claude: 'the CLI is busy' }), report: () => {} });
  await assert.rejects(failing(again), /the CLI is busy/);
  assert.equal(kept.has(again), true, 'the record names the session a retry removes');
  const calls: string[] = [];
  await createChatRetire({ chats: kept.chats, ...families(calls), report: () => {} })(again);
  assert.deepEqual(calls, ['claude 66666666-6666-4666-8666-666666666666']);
  assert.equal(kept.has(again), false);
});

test('a record this Host cannot read is said and its files still go; a family this Host does not run has no session to remove', async () => {
  const id = 'acp:kimi:77777777-7777-4777-8777-777777777777';
  const { chats, has } = store([id, 'claude:88888888-8888-4888-8888-888888888888']);
  const said: string[] = [];
  chats.unreadable.add(id);
  await createChatRetire({ chats, ...families([]), report: (m: string) => said.push(m) })(id);
  assert.equal(has(id), false);
  assert.match(said[0], /agent sessions could not be found: Chat metadata is read-only/);
  // no Claude Code and no Codex here: the chat's record goes, nothing else is asked
  await createChatRetire({
    chats,
    acpHost: { remove: () => assert.fail('not an ACP chat') },
    claude: undefined,
    codex: undefined,
    report: () => {},
  })('claude:88888888-8888-4888-8888-888888888888');
  assert.equal(has('claude:88888888-8888-4888-8888-888888888888'), false);
  const codexId = '99999999-9999-4999-8999-999999999999';
  const other = store([codexId]);
  await createChatRetire({ chats: other.chats, acpHost: { remove: () => {} }, claude: undefined, codex: undefined, report: () => {} })(
    codexId,
  );
  assert.equal(other.has(codexId), false);
});

test('the request log keeps only the deletion own entry, says which clients wrote to the chat, and a chat with no entry of that key keeps no file', async () => {
  const dir = tmp();
  const ledger = createLedger(dir, quiet);
  const by = { fingerprint: 'client-a', name: 'Mac', kind: 'desktop' };
  await ledger.once({ chatId: 'c1', key: 'send-key-1', method: 'chat.send', by }, () => ({ turnId: 'SECRET prompt echo' }));
  await ledger.once({ chatId: 'c1', key: 'send-key-2', method: 'chat.send' }, () => ({ turnId: 't2' }));
  assert.deepEqual(ledger.clients('c1'), ['client-a']);
  const file = path.join(dir, `${sha('c1').slice(0, 32)}.jsonl`);
  assert.match(fs.readFileSync(file, 'utf8'), /SECRET prompt echo/);
  await ledger.once({ chatId: 'c1', key: 'delete-key-1', method: 'chat.remove', by }, () => {
    ledger.retire('c1', 'delete-key-1');
    return { removed: true };
  });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.deepEqual(
    lines.map((l) => JSON.parse(l).state),
    ['started', 'completed'],
  );
  assert.equal(fs.readFileSync(file, 'utf8').includes('SECRET'), false);
  // the deletion sent again is answered from its own entry
  assert.deepEqual(await ledger.once({ chatId: 'c1', key: 'delete-key-1', method: 'chat.remove', by }, () => assert.fail('ran twice')), {
    replayed: true,
    result: { removed: true },
  });
  // a restart reads the same
  assert.deepEqual(createLedger(dir, quiet).clients('c1'), ['client-a']);
  // a key this log never saw leaves no file at all
  ledger.retire('c1', 'another-key-1');
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(ledger.clients('c1'), []);
  assert.deepEqual(createGuard({ epochs: {} as any, ledger }).clients('c1'), []);
});

/** The parts a chat's removal is given: each records its call. */
function removalDeps(calls: string[], over: Record<string, unknown> = {}) {
  const turns = new Map([
    ['t1', { key: 'chat' }],
    ['t2', { key: 'elsewhere' }],
  ]);
  return {
    log: { remove: (id: string) => calls.push(`journal ${id}`) },
    runtime: {
      discardQueued: (id: string) => calls.push(`queue ${id}`),
      retire: async (id: string) => void calls.push(`record ${id}`),
      host: { cancel: (id: string) => void calls.push(`cancel ${id}`) },
    },
    ownRuns: { chatCredentials: { forget: (id: string) => calls.push(`credential ${id}`) } },
    approvals: { forget: (id: string) => calls.push(`approvals ${id}`) },
    spend: { forget: (id: string) => calls.push(`spend ${id}`) },
    groups: new Map([['chat', 1]]),
    output: { forget: (id: string) => calls.push(`output ${id}`) },
    turns,
    journal: { end: (id: string) => calls.push(`end ${id}`) },
    tools: { abortChat: (id: string) => calls.push(`tools ${id}`) },
    images: { forgetChat: async (id: string, owners: string[]) => void calls.push(`uploads ${id} ${owners.join(',')}`) },
    handoffs: { done: (id: string) => calls.push(`handoff ${id}`) },
    guard: { clients: () => ['seen'], retire: (id: string, key: string) => calls.push(`ledger ${id} ${key}`) },
    clients: () => ['paired', 'seen'],
    report: (m: string) => calls.push(`report ${m}`),
    ...over,
  } as any;
}

test('a removal stops the chat, then removes what is on disk in order: record, uploads of every client that could have stored any, handoff, and last the request log', async () => {
  const calls: string[] = [];
  const turns = removalDeps(calls).turns;
  assert.deepEqual(await createChatRemoval(removalDeps(calls, { turns }))({ chatId: 'chat', key: 'delete-key-1' }), { removed: true });
  assert.deepEqual(calls, [
    'journal chat',
    'credential chat',
    'approvals chat',
    'spend chat',
    'queue chat',
    'output chat',
    'end t1',
    'tools chat',
    'cancel chat',
    'record chat',
    'uploads chat local-cli,paired,seen',
    'handoff chat',
    'ledger chat delete-key-1',
  ]);
  assert.deepEqual([...turns.keys()], ['t2']);
});

test('a removal with only what a small Host has still removes, and a stale run marker or an agent that will not stop is said, not fatal', async () => {
  const calls: string[] = [];
  const bare = {
    log: { remove: () => {} },
    runtime: { host: { cancel: () => Promise.reject(new Error('gone')) } },
    images: { forgetChat: async (id: string, owners: string[]) => void calls.push(`uploads ${id} ${owners.join(',')}`) },
    approvals: { forget: () => {} },
    groups: new Map(),
    output: { forget: () => {} },
    turns: new Map([['t1', { key: 'chat' }]]),
    journal: {
      end: () => {
        throw new Error('disk');
      },
    },
    guard: {},
    report: (m: string) => calls.push(m),
  } as any;
  assert.deepEqual(await createChatRemoval(bare)({ chatId: 'chat', key: 'delete-key-1' }), { removed: true });
  assert.deepEqual(calls, [
    'A deleted chat kept a stale run marker; restart recovery will clear it without replay.',
    'A deleted chat could not stop its agent; late output is fenced.',
    // no client table and no request log to name one: the CLI on the machine is the one client left to look for
    'uploads chat local-cli',
  ]);
});

test('a step that fails is said and the rest still run; the deletion is refused as a storage fault so the same key can be sent again', async () => {
  const calls: string[] = [];
  const failing = removalDeps(calls, {
    images: {
      forgetChat: async () => {
        throw new Error('EACCES');
      },
    },
    runtime: { discardQueued: () => {}, retire: () => Promise.reject(new Error('busy')), host: { cancel: () => {} } },
  });
  await assert.rejects(createChatRemoval(failing)({ chatId: 'chat', key: 'delete-key-1' }), (e: any) => {
    assert.equal(e.code, 'session_journal_delete_failed');
    assert.match(e.message, /could not delete the chat's record and agent session, uploads\. Retry, or check its disk space/);
    return true;
  });
  assert.ok(calls.includes("report A deleted chat's uploads could not be removed: EACCES"));
  assert.ok(calls.includes("report A deleted chat's record and agent session could not be removed: busy"));
  // the request log is rewritten only once every step is done: it names the clients whose uploads a retry must still find
  assert.ok(calls.includes('handoff chat'), 'the steps after a failed one still ran');
  assert.equal(
    calls.some((c) => c.startsWith('ledger ')),
    false,
  );
});

test('uploads of a deleted chat go for every client given, half sent ones too, and free the room they held', async () => {
  const dir = tmp();
  const images = createHostImages({ dir: path.join(dir, 'images'), quota: 1000, entries: 3 });
  const bytes = Buffer.alloc(40, 7);
  const send = (owner: string, chatId: string, data: Buffer, mime = 'image/png', size = data.length) =>
    images.upload({ owner, chatId, imageId: sha(data), offset: 0, size, mime, data: data.toString('base64') });
  await send('a', 'chat', bytes);
  await send('b', 'chat', Buffer.alloc(20, 9), FILE_MIME);
  // half sent: 8 of 20 bytes
  await send('b', 'chat', Buffer.alloc(8, 3), 'image/png', 20);
  await assert.rejects(send('a', 'other', Buffer.alloc(30, 1)), /store is full/);
  const names = () => fs.readdirSync(path.join(dir, 'images'));
  assert.ok(names().length >= 3);
  await images.forgetChat('chat', ['a', 'b', 'never-stored']);
  assert.deepEqual(names(), []);
  // the room is free again (the quota and the entry count were given back)
  await send('a', 'other', Buffer.alloc(30, 1));
  await send('a', 'other', Buffer.alloc(30, 2));
  assert.equal(names().length, 4);
  // another chat's uploads stay
  await images.forgetChat('chat', ['a']);
  assert.equal(names().length, 4);
});

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';

test("a chat's sessions are the ones its record names, not the ones its id spells: Codex names its own threads, and a chat that moved agents has one for each", async () => {
  const dir = tmp();
  const chats = new ChatsStore(dir, { legacyMirror: false });
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  // the client's id and Codex's thread differ; the chat began on Claude Code, moved to Codex, and was recorded twice for the same thread
  assert.equal(
    chats.commit(
      emptyRecord(
        id,
        [
          segment({ kind: 'claude', nativeId: U1 }),
          segment({ kind: 'codex', nativeId: 'th-1' }),
          segment({ kind: 'codex', nativeId: 'th-1' }),
        ],
        1,
      ),
    ),
    true,
  );
  const calls: string[] = [];
  await createChatRetire({ chats, ...families(calls), report: () => assert.fail('nothing to report') })(id);
  assert.deepEqual(calls, [`claude ${U1}`, 'codex th-1']);
  assert.equal(fs.existsSync(path.join(dir, `${encodeURIComponent(id)}.v2`)), false);
});

test("a session another chat's record names is that chat's: deleting this chat leaves it", async () => {
  const chats = new ChatsStore(tmp(), { legacyMirror: false });
  assert.equal(chats.commit(emptyRecord('chat-one', [segment({ kind: 'codex', nativeId: U1 })], 1)), true);
  assert.equal(
    chats.commit(emptyRecord('chat-two', [segment({ kind: 'codex', nativeId: U1 }), segment({ kind: 'codex', nativeId: U2 })], 1)),
    true,
  );
  const calls: string[] = [];
  await createChatRetire({ chats, ...families(calls), report: () => {} })('chat-two');
  assert.deepEqual(calls, [`codex ${U2}`]);
});

test("a session two chats name goes with the second of them: the first one's record, still on disk, no longer holds it", async () => {
  const chats = new ChatsStore(tmp(), { legacyMirror: false });
  assert.equal(chats.commit(emptyRecord('chat-one', [segment({ kind: 'codex', nativeId: U1 })], 1)), true);
  assert.equal(chats.commit(emptyRecord('chat-two', [segment({ kind: 'codex', nativeId: U1 })], 1)), true);
  const calls: string[] = [];
  const retire = createChatRetire({ chats, ...families(calls), report: () => {} });
  await retire('chat-one');
  assert.deepEqual(calls, [], 'the other chat still names it');
  await retire('chat-two');
  assert.deepEqual(calls, [`codex ${U1}`]);
});

test('a chat with no record has no agent session to find, whatever its id spells; an ACP chat still has its transcript, named by its id', async () => {
  const { chats } = store([]);
  const calls: string[] = [];
  const retire = createChatRetire({ chats, ...families(calls), report: () => {} });
  for (const id of ['a', '0', '9', 'memory', 'claude:memory', U1, `claude:${U1}`]) await retire(id);
  assert.deepEqual(calls, []);
  await retire('acp:kimi:no-record');
  assert.deepEqual(calls, ['acp acp:kimi:no-record']);
});

/** Files an agent keeps, in a home of their own. */
function agentHome() {
  const home = tmp();
  const write = (file: string, text = 'x') => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const rollout = (thread: string, where = '.codex/sessions/2026/11/18', prefix = '') =>
    write(path.join(home, where, `rollout-2026-11-18T00-00-00-${prefix}${thread}.jsonl`));
  return { home, write, rollout, claude: path.join(home, '.claude') };
}

test("a Codex rollout is removed by its thread's UUID with the delimiter before it, in sessions and archived_sessions; another thread's and a longer name's stay", async () => {
  const a = agentHome();
  const mine = [
    a.rollout(U1),
    a.rollout(U1, '.codex/archived_sessions'),
    a.write(path.join(a.home, `.codex/sessions/2026/11/19/rollout-x-${U1}.jsonl.zst`)),
  ];
  const stay = [
    a.rollout(U2),
    a.rollout(U1, '.codex/sessions/2026/11/18', 'x'),
    a.write(path.join(a.home, `.codex/sessions/2026/11/18/${U1}.jsonl`)),
  ];
  const leftovers = createAgentLeftovers({ env: {}, home: a.home });
  assert.equal((await leftovers.codex(U1)).length, 3);
  assert.deepEqual(await leftovers.codex(U1), []);
  assert.equal(mine.some(fs.existsSync), false);
  assert.equal(stay.every(fs.existsSync), true);
  // an id that is no UUID names no file: 'a', '0' and '9' match the end of many rollouts and nothing is searched for
  for (const id of ['a', '0', '9', 'memory', '../x', 'th-1']) assert.deepEqual(await leftovers.codex(id), []);
  assert.equal(stay.every(fs.existsSync), true);
  // a store with no sessions folder has nothing; one that cannot be read is a failure
  assert.deepEqual(await createAgentLeftovers({ env: { CODEX_HOME: path.join(a.home, 'none') }, home: a.home }).codex(U1), []);
  fs.writeFileSync(path.join(a.home, 'file'), 'x');
  await assert.rejects(createAgentLeftovers({ env: { CODEX_HOME: path.join(a.home, 'file') }, home: a.home }).codex(U1), {
    code: 'ENOTDIR',
  });
});

test("a Claude session's own files are removed by its UUID, in every project folder and beside them; Claude's memory folder and other sessions stay", async () => {
  const a = agentHome();
  const projects = path.join(a.claude, 'projects');
  fs.mkdirSync(path.join(projects, '-work-a', U1), { recursive: true });
  const mine = [
    a.write(path.join(projects, '-work-a', `${U1}.jsonl`)),
    path.join(projects, '-work-a', U1),
    a.write(path.join(projects, '-work-b', `${U1}.jsonl`)),
    a.write(path.join(a.claude, 'file-history', U1, 'v1')),
    a.write(path.join(a.claude, 'session-env', U1, 'env')),
    a.write(path.join(a.claude, 'debug', `${U1}.txt`)),
    a.write(path.join(a.claude, 'todos', `${U1}-agent-${U1}.json`)),
  ];
  const stay = [
    a.write(path.join(projects, '-work-a', `${U2}.jsonl`)),
    a.write(path.join(projects, '-work-a', 'memory', 'MEMORY.md')),
    a.write(path.join(a.claude, 'todos', `${U2}-agent-${U2}.json`)),
    a.write(path.join(a.claude, 'file-history', U2, 'v1')),
  ];
  const leftovers = createAgentLeftovers({ env: {}, home: a.home });
  assert.deepEqual((await leftovers.claude(U1)).sort(), [
    `debug/${U1}.txt`,
    `file-history/${U1}`,
    `projects/${U1}`,
    `projects/${U1}.jsonl`,
    `projects/${U1}.jsonl`,
    `session-env/${U1}`,
    `todos/${U1}-agent-${U1}.json`,
  ]);
  assert.equal(mine.some(fs.existsSync), false);
  assert.equal(stay.every(fs.existsSync), true);
  for (const id of ['a', '0', '9', 'memory', 'a/b']) assert.deepEqual(await leftovers.claude(id), []);
  assert.equal(stay.every(fs.existsSync), true);
  // a machine Claude Code never ran on has nothing; a store that cannot be read is a failure
  assert.deepEqual(await createAgentLeftovers({ env: { CLAUDE_CONFIG_DIR: path.join(a.home, 'none') }, home: a.home }).claude(U1), []);
  fs.writeFileSync(path.join(a.home, 'file'), 'x');
  await assert.rejects(createAgentLeftovers({ env: { CLAUDE_CONFIG_DIR: path.join(a.home, 'file') }, home: a.home }).claude(U1), {
    code: 'ENOTDIR',
  });
});

test('a session left in its agent store is removed after the agent says it is gone, and a store that cannot be cleaned fails the deletion', async () => {
  const a = agentHome();
  const file = a.rollout(U3);
  const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const { chats } = store([]);
  chats.commit(emptyRecord(id, [segment({ kind: 'codex', nativeId: U3 })], 1));
  const logs: string[] = [];
  await createChatRetire({
    chats,
    ...families([], { codex: `no rollout found for thread id ${U3}` }),
    env: { CODEX_HOME: path.join(a.home, '.codex') },
    report: () => {},
    log: (l: string) => logs.push(l),
  })(id);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(logs, [
    `[codex-delete] chat=${id} session=${U3} gone; left in its store and removed: rollout-2026-11-18T00-00-00-${U3}.jsonl`,
  ]);
  // a Claude chat whose store cannot be read
  fs.writeFileSync(path.join(a.home, 'blocked'), 'x');
  const claudeId = `claude:${U1}`;
  const second = store([claudeId]);
  const said: string[] = [];
  await assert.rejects(
    createChatRetire({
      chats: second.chats,
      ...families([]),
      env: { CLAUDE_CONFIG_DIR: path.join(a.home, 'blocked') },
      report: () => {},
      log: (l: string) => said.push(l),
    })(claudeId),
    /ENOTDIR/,
  );
  assert.match(said[0], new RegExp(`session=${U1} deleted; its store could not be cleaned: ENOTDIR`));
  assert.equal(second.has(claudeId), true);
});

test('a deletion is run again after a Host died under it or a step failed, whatever the failure was; a send is not: it is indeterminate, or its failure is its answer', async () => {
  const dir = tmp();
  const file = path.join(dir, `${sha('c1').slice(0, 32)}.jsonl`);
  const line = (key: string, method: string) => `${JSON.stringify({ key, method, state: 'started', at: 1 })}\n`;
  // the last Host died with both requests started and settled neither
  fs.writeFileSync(file, line('delete-key-1', 'chat.remove') + line('send-key-1', 'chat.send'));
  const guard = createGuard({ epochs: { admit: () => 1 } as any, ledger: createLedger(dir, quiet) });
  const asked = (key: string, method: string, act: () => unknown) => guard({ chatId: 'c1', epoch: 1, key, method }, act as any);
  assert.deepEqual((await asked('send-key-1', 'chat.send', () => assert.fail('a send is never run twice'))).result, {
    state: 'indeterminate',
  });
  assert.deepEqual(await asked('delete-key-1', 'chat.remove', () => ({ removed: true })), { replayed: false, result: { removed: true } });
  // a failure of any kind is not a deletion's answer (a full queue, a busy trust file, a disk): the same key runs it again
  const failing = () => {
    throw Object.assign(new Error('trust busy'), { code: 'trust_busy' });
  };
  await assert.rejects(asked('delete-key-2', 'chat.remove', failing), { code: 'trust_busy' });
  assert.deepEqual((await asked('delete-key-2', 'chat.remove', () => ({ removed: true }))).result, { removed: true });
  // a send that failed that way keeps its failure as its answer, as before
  await assert.rejects(asked('send-key-2', 'chat.send', failing), { code: 'trust_busy' });
  await assert.rejects(
    asked('send-key-2', 'chat.send', () => assert.fail('the failure is the answer')),
    { code: 'trust_busy' },
  );
  // a deletion that an older Host stored as failed is run again too
  fs.appendFileSync(
    file,
    `${JSON.stringify({ key: 'delete-key-3', method: 'chat.remove', state: 'failed', error: { code: 'x', message: 'old' } })}\n`,
  );
  const next = createGuard({ epochs: { admit: () => 1 } as any, ledger: createLedger(dir, quiet) });
  assert.deepEqual((await next({ chatId: 'c1', epoch: 1, key: 'delete-key-3', method: 'chat.remove' }, () => ({ removed: true }))).result, {
    removed: true,
  });
});
