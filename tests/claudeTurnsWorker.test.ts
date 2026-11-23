// A Claude chat's turns are read on a worker thread (electron/platform/claudeTurnsWorker.cjs, claudeTurnsWorkerMain.cjs) and come
// back exactly as the in-process reader builds them; the messages read are kept while the transcript is as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createTranscriptReader, createReadCache } = require('../electron/platform/claudeTranscriptRead.cjs');
const { historyPage, releaseHistory } = require('../electron/platform/claudeHistory.cjs');
const ignored: string[] = [];
const { readTurnPage, readMessages } = createTranscriptReader({ noteIgnored: (what: string) => ignored.push(what) });
const { serve, boot } = require('../electron/platform/claudeTurnsWorkerMain.cjs');
const { createTurnsWorker, appTurnsWorker, MAX_LOST } = require('../electron/platform/claudeTurnsWorker.cjs');
const { createTranscripts } = require('../electron/harness/claude/transcripts.cjs');
// Resolve by file URL so this boundary is the installed SDK, rather than a mock.
const sdk = await import(new URL('../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs', import.meta.url).href);

/** What a read answer holds, as main would cut it, every turn of it; a read no cache keeps goes. */
async function pageOf(answer: { read: number; kept: boolean }) {
  const { page } = await historyPage(answer.read, {});
  if (!answer.kept) releaseHistory(answer.read);
  return JSON.parse(String(page));
}

const SID = randomUUID();
const at = '2026-10-22T12:00:00Z';
const row = (uuid: string, parentUuid: string | null, type: string, extra: any = {}) => ({
  uuid,
  parentUuid,
  type,
  timestamp: at,
  ...extra,
});
const user = (id: string, parent: string | null, extra: any = {}) =>
  row(id, parent, 'user', { message: { role: 'user', content: id }, ...extra });
const reply = (id: string, parent: string, extra: any = {}) =>
  row(id, parent, 'assistant', {
    message: { id, role: 'assistant', content: [{ type: 'text', text: id }], stop_reason: 'end_turn' },
    ...extra,
  });
const image = (id: string, parent: string) =>
  user(id, parent, {
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'text', text: id },
      ],
    },
  });

/** A compacted chat with a hook notice, an inline image, a typed error and a fork's copies. */
const records = () => [
  user('u1', null),
  reply('a1', 'u1'),
  row('b1', null, 'system', {
    subtype: 'compact_boundary',
    content: 'compacted',
    logicalParentUuid: 'a1',
    compactMetadata: { trigger: 'manual', preTokens: 9 },
  }),
  user('s1', 'b1', { isCompactSummary: true }),
  image('u2', 's1'),
  row('n1', 'u2', 'system', { subtype: 'informational', level: 'warning', content: 'hook said hi' }),
  reply('a2', 'n1', { error: 'rate_limit', forkedFrom: { sessionId: 'src', messageUuid: 'x' } }),
];

function transcript(rows: object[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turns-worker-'));
  const file = path.join(dir, `${SID}.jsonl`);
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { dir, file };
}
const realSdk = (rows: object[]) => ({
  getSessionMessages: (id: string, opts: any) =>
    sdk.getSessionMessages(id, { ...opts, sessionStore: { load: async () => rows }, dir: '/repo' }),
});
const page = { liveTail: false, closedTail: false, open: false, limit: 0, before: null };
const request = (file: string, sessionId: string = SID, extra: object = {}) => ({
  sessionId,
  file,
  chatId: `claude:${sessionId}`,
  cwd: '/repo',
  page,
  ...extra,
});

/** A worker port that runs `serve` in this thread and answers like the thread's message channel. */
function loopback(loadSdk: () => Promise<any>) {
  const toWorker = new EventEmitter();
  const fromWorker = new EventEmitter();
  serve({ on: (e: string, f: any) => toWorker.on(e, f), postMessage: (m: any) => fromWorker.emit('message', structuredClone(m)) }, loadSdk);
  const worker: any = fromWorker;
  worker.postMessage = (m: any) => toWorker.emit('message', structuredClone(m));
  worker.unref = () => {};
  worker.terminate = () => {};
  return worker;
}

test('the worker answers with the page the in-process reader builds, compacted history, notices, images and forks included', async () => {
  const rows = records();
  const { dir, file } = transcript(rows);
  try {
    const inline = await pageOf(await readTurnPage({ sdk: realSdk(rows) }, request(file)));
    const client = createTurnsWorker({ makeWorker: () => loopback(async () => realSdk(rows)) });
    const viaWorker = await pageOf(await client.read(request(file)));
    assert.deepEqual(viaWorker, inline);
    const text = JSON.stringify(inline);
    // the folded conversation, the hook notice, the image and the typed error all reached the page
    for (const needle of ['u1', 'hook said hi', 'image/png']) assert.ok(text.includes(needle), needle);
    // what the SDK strips is put back on the messages the page is built from
    const messages = await readMessages(realSdk(rows), file, SID, undefined);
    assert.equal(messages.find((m: any) => m.uuid === 'a2').error, 'rate_limit');
    assert.equal(messages.find((m: any) => m.uuid === 'a2').forkedFrom, true);
    client.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a transcript read again unchanged parses nothing; an appended one, another edit cut or another file is read again', async () => {
  const rows = records();
  const { dir, file } = transcript(rows);
  let reads = 0;
  const counting = { getSessionMessages: (id: string, opts: any) => (reads++, realSdk(rows).getSessionMessages(id, opts)) };
  try {
    const deps = { sdk: counting, cache: createReadCache() };
    const first = await readTurnPage(deps, request(file));
    assert.equal(first.kept, true);
    assert.deepEqual(await readTurnPage(deps, request(file)), first);
    assert.equal(reads, 1);
    // a read holds its chat's id in what it says: another chat reading the session reads again
    const other = await readTurnPage(deps, request(file, SID, { chatId: 'claude:other' }));
    assert.notEqual(other.read, first.read);
    assert.equal(reads, 2);
    await readTurnPage(deps, request(file));
    reads = 1;
    // an edit cut the conversation: not the same read
    await readTurnPage(deps, request(file, SID, { resumeAt: 'a1' }));
    assert.equal(reads, 2);
    // the file grew
    fs.appendFileSync(file, JSON.stringify(user('u3', 'a2')) + '\n');
    await readTurnPage(deps, request(file, SID, { resumeAt: 'a1' }));
    assert.equal(reads, 3);
    // no transcript file: nothing to key on, so nothing is kept
    assert.equal((await readTurnPage(deps, { ...request(file), file: null })).kept, false);
    await readTurnPage(deps, { ...request(file), file: null });
    assert.equal(reads, 5);
    // a transcript that is gone is the hook records' failure, as before the worker
    await assert.rejects(readTurnPage(deps, request(path.join(dir, 'missing.jsonl'))), /ENOENT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the worker reads one session at a time, lets other sessions pass, and reports a read that failed', async () => {
  let release!: () => void;
  const order: string[] = [];
  const port = loopback(async () => ({
    getSessionMessages: async (id: string) => {
      order.push(`start ${id}`);
      if (id === 'slow') await new Promise<void>((r) => (release = r));
      if (id === 'bad') throw Object.assign(new Error('no such session'), { code: 'ENOENT' });
      order.push(`end ${id}`);
      return [];
    },
  }));
  const answers: any[] = [];
  port.on('message', (m: any) => answers.push(m));
  const send = (id: number, sessionId: string) => port.postMessage({ id, req: request('', sessionId, { file: null }) });
  send(1, 'slow');
  send(2, 'slow');
  send(3, 'bad');
  await new Promise((r) => setTimeout(r, 20));
  // the second read of the slow session waits for the first; another session does not
  assert.deepEqual(order, ['start slow', 'start bad']);
  release();
  await new Promise((r) => setTimeout(r, 20));
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, ['start slow', 'start bad', 'end slow', 'start slow', 'end slow']);
  assert.deepEqual(answers.map((a) => [a.id, a.ok, a.error?.message, a.code]).sort(), [
    [1, true, undefined, undefined],
    [2, true, undefined, undefined],
    [3, false, 'no such session', 'ENOENT'],
  ]);
  // an error without a message is reported by its text
  const odd = loopback(async () => ({ getSessionMessages: async () => Promise.reject('plain') }));
  const seen: any[] = [];
  odd.on('message', (m: any) => seen.push(m));
  odd.postMessage({ id: 9, req: request('', 'x', { file: null }) });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(seen[0].error.message, 'plain');
});

test('the client starts one worker, shares it, fails a read the worker failed, and reads around a worker that is gone', async () => {
  const made: any[] = [];
  const client = createTurnsWorker({
    makeWorker: (file: string, options: any) => {
      const w: any = new EventEmitter();
      w.file = file;
      w.options = options;
      w.sent = [];
      w.postMessage = (m: any) => w.sent.push(m);
      w.unref = () => {};
      w.terminate = () => w.emit('exit');
      made.push(w);
      return w;
    },
  });
  const a = client.read({ n: 1 });
  const b = client.read({ n: 2 });
  assert.equal(made.length, 1);
  assert.ok(made[0].file.endsWith('claudeTurnsWorkerMain.cjs'));
  assert.ok(made[0].options.env, 'the live environment is shared');
  made[0].emit('message', { id: 99, ok: true, page: 'stray' });
  made[0].emit('message', { id: 1, ok: true, page: 'one' });
  made[0].emit('message', { id: 2, ok: false, error: new Error('boom') });
  assert.equal(await a, 'one');
  await assert.rejects(b, (e: any) => e.message === 'boom' && !e.workerDown);
  // a worker that dies fails what it held with workerDown; the next read starts another
  const c = client.read({ n: 3 });
  made[0].emit('error', new Error('crashed'));
  made[0].emit('error', 'twice');
  await assert.rejects(c, (e: any) => e.workerDown === true && /crashed/.test(e.message));
  // events from the dead worker are ignored
  made[0].emit('message', { id: 3, ok: true, page: 'late' });
  made[0].emit('exit');
  const d = client.read({ n: 4 });
  assert.equal(made.length, 2);
  made[1].emit('message', { id: 4, ok: true, page: 'again' });
  assert.equal(await d, 'again');
  // closing fails what is waiting and ends the thread
  const e = client.read({ n: 5 });
  client.close();
  await assert.rejects(e, (x: any) => x.workerDown === true);
  client.close();
});

test('a worker that cannot start, or keeps dying, is given up on', async () => {
  const failing = createTurnsWorker({
    makeWorker: () => {
      throw new Error('no thread');
    },
  });
  await assert.rejects(failing.read({}), (e: any) => e.workerDown === true && /did not start: no thread/.test(e.message));
  await assert.rejects(
    createTurnsWorker({
      makeWorker: () => {
        throw 'plain';
      },
    }).read({}),
    /did not start: plain/,
  );
  for (let i = 1; i < MAX_LOST; i++) await assert.rejects(failing.read({}), (e: any) => e.workerDown === true);
  await assert.rejects(failing.read({}), (e: any) => /not available/.test(e.message));
  let starts = 0;
  const dying = createTurnsWorker({
    makeWorker: () => {
      starts++;
      const w: any = new EventEmitter();
      w.unref = () => {};
      w.postMessage = () => queueMicrotask(() => w.emit('exit'));
      return w;
    },
  });
  for (let i = 0; i < MAX_LOST; i++) await assert.rejects(dying.read({}), (e: any) => e.workerDown === true);
  await assert.rejects(dying.read({}), (e: any) => /not available/.test(e.message));
  assert.equal(starts, MAX_LOST);
});

test('only the app starts a worker', () => {
  assert.equal(appTurnsWorker({}), null);
  const w = appTurnsWorker({ electron: '1' });
  assert.equal(typeof w.read, 'function');
});

test("the transcripts reader asks its worker, reads in-process when the worker is gone, and passes on the SDK's own failure", async () => {
  const rows = records();
  const { dir, file } = transcript(rows);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'turns-root-'));
  const proj = path.join(root, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  fs.copyFileSync(file, path.join(proj, `${SID}.jsonl`));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    const state: any = { sdk: async () => realSdk(rows), resumeAt: new Map([[`claude:${SID}`, 'a1']]) };
    const seen: any[] = [];
    const worker = { read: async (req: any) => (seen.push(req), readTurnPage({ sdk: realSdk(rows) }, { ...req, resumeAt: req.resumeAt })) };
    const text = (read: { page: Buffer }) => String(read.page);
    const viaWorker = await createTranscripts(state, worker).turns(SID, { cwd: '/repo', limit: 3 });
    assert.equal(seen[0].file, path.join(proj, `${SID}.jsonl`));
    assert.equal(seen[0].resumeAt, 'a1');
    assert.deepEqual([seen[0].chatId, seen[0].cwd], [`claude:${SID}`, '/repo']);
    assert.ok(JSON.parse(text(viaWorker)).turns.length <= 3);
    assert.deepEqual(
      viaWorker.ids,
      JSON.parse(text(viaWorker)).turns.map((turn: any) => turn.id),
    );
    const gone = { read: async () => Promise.reject(Object.assign(new Error('gone'), { workerDown: true })) };
    const inline = text(await createTranscripts(state, null).turns(SID, { cwd: '/repo' }));
    assert.equal(text(await createTranscripts(state, gone).turns(SID, { cwd: '/repo' })), inline);
    const failed = { read: async () => Promise.reject(new Error('the SDK failed')) };
    await assert.rejects(createTranscripts(state, failed).turns(SID, { cwd: '/repo' }), /the SDK failed/);
    // messages() is the same read
    assert.deepEqual(
      (await createTranscripts(state, null).messages(SID)).map((m: any) => m.uuid),
      (await readMessages(realSdk(rows), file, SID, 'a1')).map((m: any) => m.uuid),
    );
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('watching a transcript looks it up without blocking, and a second call while it is looked for follows it once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'turns-watch-'));
  const proj = path.join(root, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'w1.jsonl'), '{}\n');
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  const watched: string[] = [];
  const state: any = { resumeAt: new Map(), watchHooks: { onWatch: (k: string) => watched.push(k), onUnwatch: () => {} }, emit: () => {} };
  const t = createTranscripts(state, null);
  try {
    assert.equal(await t.watch('missing'), false);
    const both = await Promise.all([t.watch('w1'), t.watch('w1')]);
    assert.deepEqual(both, [true, true]);
    assert.deepEqual(watched, ['claude:w1']);
    assert.equal(await t.watch('w1'), true);
  } finally {
    t.unwatchAll();
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a rewind that moves the cutoff while the worker reads has the page read again at the new one, and gives up after three', async () => {
  const state: any = { sdk: async () => realSdk(records()), resumeAt: new Map() };
  const key = `claude:${SID}`;
  const asked: any[] = [];
  let moves = 1;
  const worker = {
    read: async (req: any) => {
      asked.push(req.resumeAt);
      if (moves-- > 0) state.resumeAt.set(key, 'a1');
      return readTurnPage({ sdk: realSdk(records()) }, { ...req, file: null });
    },
  };
  const cut = await createTranscripts(state, worker).turns(SID, {});
  assert.ok(cut.ids.length > 0);
  assert.deepEqual(asked, [undefined, 'a1']);
  // a cutoff that never settles is read in this thread, which takes it after the reads
  asked.length = 0;
  let n = 0;
  const restless = {
    read: async (req: any) => (asked.push(req.resumeAt), state.resumeAt.set(key, `c${n++}`), { read: 0, kept: true }),
  };
  const inline = await createTranscripts(state, restless).turns(SID, {});
  assert.equal(asked.length, 3);
  assert.ok(inline.ids.length > 0, 'nothing of what the stale reads said is cut');
});

test('the worker entry serves only on a worker port, and loads the installed SDK by default', async () => {
  boot(null);
  const rows = records();
  const { dir, file } = transcript(rows);
  const toWorker = new EventEmitter();
  const answers: any[] = [];
  // the default loader reads the SDK's own store, so this only checks that it loads and answers
  boot({ on: (e: string, f: any) => toWorker.on(e, f), postMessage: (m: any) => answers.push(m) });
  toWorker.emit('message', { id: 1, req: request(file) });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(answers[0].id, 1);
  assert.equal(typeof answers[0].ok, 'boolean');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a real worker thread reads a transcript from the config folder and answers as the in-process reader does', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'turns-thread-'));
  const proj = path.join(root, 'projects', '-repo');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, `${SID}.jsonl`);
  fs.writeFileSync(
    file,
    records()
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  const client = createTurnsWorker();
  try {
    const viaThread = await pageOf(await client.read(request(file)));
    const inline = await pageOf(await readTurnPage({ sdk }, request(file)));
    assert.deepEqual(viaThread, inline);
    assert.ok(viaThread.turns.length > 0);
  } finally {
    client.close();
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an error keeps its code across the thread, and a request the thread cannot take fails alone', async () => {
  const w: any = new EventEmitter();
  w.unref = () => {};
  w.terminate = () => {};
  w.postMessage = (m: any) => {
    if (m.req.bad) throw new Error('not cloneable');
    if (m.req.raw) throw 'raw';
  };
  const client = createTurnsWorker({ makeWorker: () => w });
  const coded = client.read({ n: 1 });
  w.emit('message', { id: 1, ok: false, error: new Error('x'), code: 'EACCES' });
  await assert.rejects(coded, (e: any) => e.code === 'EACCES');
  await assert.rejects(client.read({ bad: true }), (e: any) => e.workerDown === true && /could not take/.test(e.message));
  await assert.rejects(client.read({ raw: true }), /could not take a request: raw/);
  // plain errors without a code stay as they are
  const plain = client.read({ n: 2 });
  w.emit('message', { id: 4, ok: false, error: new Error('y') });
  await assert.rejects(plain, (e: any) => e.code === undefined);
});

test('a chat let go while its transcript is looked up is not followed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'turns-unwatch-'));
  fs.mkdirSync(path.join(root, 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'p', 'late.jsonl'), '{}\n');
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  const watched: string[] = [];
  const state: any = { resumeAt: new Map(), watchHooks: { onWatch: (k: string) => watched.push(k), onUnwatch: () => {} }, emit: () => {} };
  const t = createTranscripts(state, null);
  try {
    const following = t.watch('late');
    t.unwatch('late');
    assert.equal(await following, false);
    assert.deepEqual(watched, []);
  } finally {
    t.unwatchAll();
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("what the worker's reader ignores goes to the worker's console, and a handle that will not close is recorded", async (t) => {
  const debug = t.mock.method(console, 'debug', () => {});
  const port = loopback(async () => realSdk([]));
  const answers: any[] = [];
  port.on('message', (m: any) => answers.push(m));
  port.postMessage({ id: 1, req: request(path.join(os.tmpdir(), 'no-such-dir', 'x.jsonl')) });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(answers[0].ok, false);
  assert.match(String(debug.mock.calls[0].arguments[0]), /stat a Claude Code transcript/);
  ignored.length = 0;
  const { closeQuietly } = createTranscriptReader({ noteIgnored: (what: string) => ignored.push(what) });
  await closeQuietly({
    close: async () => {
      throw new Error('busy');
    },
  });
  assert.deepEqual(ignored, ['close a Claude Code transcript']);
});

test("the reader times its two merge steps through the caller's labeler", async () => {
  const rows = records();
  const { dir, file } = transcript(rows);
  try {
    const names: string[] = [];
    const reader = createTranscriptReader({ noteIgnored: () => {}, labeled: (name: string, fn: () => any) => (names.push(name), fn()) });
    await reader.readMessages(realSdk(rows), file, SID, undefined);
    assert.deepEqual(names, ['claude.messages.merge', 'claude.messages.endTurns']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('letting go of every followed transcript also closes the turns worker', () => {
  let closed = 0;
  const t = createTranscripts({ resumeAt: new Map(), watchHooks: {}, emit: () => {} } as any, {
    read: async () => null,
    close: () => closed++,
  });
  t.unwatchAll();
  assert.equal(closed, 1);
});
