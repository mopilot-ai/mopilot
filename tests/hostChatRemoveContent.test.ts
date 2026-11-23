// Deleting a chat on a Host takes its content off the machine's disk: a real Host (sessions, protocol, journal, ledger, uploads, waiting messages, handoff) over a fake ACP agent, in a temp data folder that is walked for the chat's id and for the words it was sent.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createAcpRuntime } from '../host/src/acp.mjs';
import { createHostImages } from '../host/src/chatImages.mjs';
import { createContinueTarget } from '../host/src/continueTarget.mjs';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { createHostSessions } from '../host/src/sessions.mjs';
import { helloParams } from '../shared/host/schema.mjs';
import { FILE_MIME } from '../shared/host/files.mjs';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { createDeletionOutbox } = require('../electron/host/deletionOutbox.cjs');
const AGENT = path.join(import.meta.dirname, 'fixtures/fake-acp-agent.mjs');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-remove-content-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=', 'base64');
const OTHER_PNG = Buffer.from('another chat picture');
const FILE = Buffer.from('FILE-SECRET-bytes');
const WORDS = ['SECRET-first-prompt', 'SECRET-queued-prompt', 'SECRET-handoff', 'UNSENT-by-b', FILE, PNG];
const CLIENT = { fingerprint: 'client-a', name: 'Mac', kind: 'desktop' };

/** A Host's real parts over a fake ACP agent, in a data folder of its own (the agent's own state is kept outside it). */
function host(o: { dir?: string; failUploads?: { left: number } } = {}) {
  const dir = o.dir ?? fs.mkdtempSync(path.join(base, 'data-'));
  const agentDir = fs.mkdtempSync(path.join(base, 'agent-'));
  fs.writeFileSync(
    path.join(dir, 'harnesses.json'),
    JSON.stringify({
      fake: {
        label: 'Fake',
        bin: process.execPath,
        args: [AGENT],
        env: {
          FAKE_ACP_STATE: path.join(agentDir, 's'),
          FAKE_ACP_LOG: path.join(agentDir, 'log'),
          FAKE_ACP_PROFILE: JSON.stringify({ image: true }),
        },
      },
    }),
  );
  const paths = createPaths({ dataDir: dir, env: {} });
  const runtime = createAcpRuntime({ paths, env: {}, hostOptions: { cancelRetryMs: 5, cancelForceMs: 5000 } });
  const sessions = createHostSessions({ paths, env: {}, runtime });
  const epochs = createEpochStore(path.join(dir, 'epochs.json'), { report: () => {} });
  const handoffs = createContinueTarget({
    dir: path.join(dir, 'continue'),
    hostFs: { existingDirectory: async (p: string) => p } as any,
    harnesses: () => ['fake'],
  });
  const reports: string[] = [];
  const images = createHostImages({ dir: path.join(dir, 'images') });
  // a disk that fails the uploads step a number of times
  const forgetChat = images.forgetChat;
  images.forgetChat = (chatId: string, owners: string[]) =>
    o.failUploads?.left ? (o.failUploads.left--, Promise.reject(new Error('EACCES'))) : forgetChat(chatId, owners);
  const protocol = createProtocol({
    dataDir: dir,
    runtime: sessions.chatRuntime,
    epochs,
    guard: createGuard({ epochs, ledger: createLedger(path.join(dir, 'ledger'), { report: () => {} }) }),
    images,
    handoffs,
    knownClients: () => ['client-b'],
    status: () => ({ running: true }),
    report: (m: string) => reports.push(m),
  } as any);
  const connect = async (identity: string) => {
    const conn = protocol.connection(
      () => {},
      () => identity,
      { principal: () => ({ ...CLIENT, fingerprint: identity }) } as any,
    );
    await conn.call('host.hello', helloParams());
    return conn;
  };
  return { dir, sessions, handoffs, reports, connect, close: () => (sessions.close(), runtime.close()) };
}

/** Everything under `dir` whose path or bytes mention one of `needles`, relative to `dir`. */
function mentions(dir: string, needles: (string | Buffer)[]) {
  const found: string[] = [];
  const named = (at: string) => needles.some((n) => typeof n === 'string' && at.slice(dir.length).includes(n));
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const file = path.join(at, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (named(file) || needles.some((n) => fs.readFileSync(file).includes(n))) found.push(path.relative(dir, file));
    }
    if (at !== dir && named(at)) found.push(`${path.relative(dir, at)}/`);
  };
  walk(dir);
  return found.sort();
}

/** The chat's ids as the disk spells them: raw, URL-encoded (threads/), and hashed (journal, ledger, queue, uploads, handoff). */
const spellings = (id: string) => [id, encodeURIComponent(id), sha(id), sha(id).slice(0, 32)];
const upload = (conn: any, chatId: string, bytes: Buffer, mime: string) =>
  conn.call('chat.attach', {
    chatId,
    epoch: 1,
    key: randomUUID(),
    imageId: sha(bytes),
    offset: 0,
    size: bytes.length,
    mime,
    data: bytes.toString('base64'),
  });

test('deleting a chat removes everything of its content from the Host: transcript, record, journal, uploads, waiting message, handoff, request log', async () => {
  const h = host();
  try {
    const chatId = `acp:fake:${randomUUID()}`;
    const otherId = `acp:fake:${randomUUID()}`;
    const conn = await h.connect('client-a');
    const paired = await h.connect('client-b');
    // an upload this chat's client never sent in a message is the paired client's alone: only the Host's client table knows it
    await upload(paired, chatId, Buffer.from('UNSENT-by-b'), FILE_MIME);
    await upload(conn, chatId, PNG, 'image/png');
    await upload(conn, chatId, FILE, FILE_MIME);
    const first = conn.call('chat.send', {
      chatId,
      epoch: 1,
      key: 'send-key-1',
      text: 'SLOW SECRET-first-prompt',
      cwd: h.dir,
      images: [sha(PNG)],
      files: [{ id: sha(FILE), name: 'notes.txt', rel: '' }],
    });
    await waitFor(() => h.sessions.state.snapshot(chatId).turn === 'running', 'the first turn running');
    // a message sent while the turn runs waits on disk
    await conn.call('chat.send', { chatId, epoch: 1, key: 'send-key-2', text: 'SECRET-queued-prompt', cwd: h.dir });
    await waitFor(
      () => fs.existsSync(path.join(h.dir, 'queues')) && fs.readdirSync(path.join(h.dir, 'queues')).length > 0,
      'the waiting message on disk',
    );
    // a continued chat's handoff waits for its first message
    const { nativeId } = await h.handoffs.open({ chatId, harness: 'fake', cwd: h.dir, handoff: 'SECRET-handoff' });
    h.handoffs.serve({ chatId, nativeId });
    await first;
    // another chat on the same Host, which stays
    await upload(conn, otherId, OTHER_PNG, 'image/png');
    await conn.call('chat.send', { chatId: otherId, epoch: 1, key: 'other-key-1', text: 'SECRET-other-chat', cwd: h.dir });
    await waitFor(
      () => h.sessions.state.snapshot(otherId).turn === 'idle' && mentions(h.dir, spellings(otherId)).some((f) => f.startsWith('threads')),
      'the other chat saved',
    );

    // before the delete the chat's content is all over the disk
    const before: string[] = mentions(h.dir, [...spellings(chatId), ...WORDS]);
    for (const part of ['threads/', 'sessions/', 'ledger/', 'queues/', 'images/', 'chat-files/', 'continue/bound/'])
      assert.ok(
        before.some((f) => f.startsWith(part)),
        `${part} holds the chat before the delete: ${before.join(' ')}`,
      );

    assert.deepEqual((await conn.call('chat.remove', { chatId, epoch: 1, key: 'delete-key-1' })).result, { removed: true });

    // after it only what is not content stays: the epoch number, the delete's own request-log entry and its tombstone (docs/host.md)
    const left = mentions(h.dir, [...spellings(chatId), ...WORDS]);
    assert.deepEqual(
      left,
      ['epochs.json', 'epochs.json.bak', `ledger/${sha(chatId).slice(0, 32)}.jsonl`, `sessions/${sha(chatId)}.deleted`].sort(),
    );
    const entries = fs
      .readFileSync(path.join(h.dir, 'ledger', `${sha(chatId).slice(0, 32)}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      entries.map((e) => [e.key, e.method, e.state, e.by?.fingerprint]),
      [
        ['delete-key-1', 'chat.remove', 'started', 'client-a'],
        ['delete-key-1', 'chat.remove', 'completed', 'client-a'],
      ],
    );
    // a request for the deleted chat is refused, and the deletion sent again is answered, not run again
    await assert.rejects(conn.call('chat.send', { chatId, epoch: 1, key: 'late-key-1', text: 'late' }), {
      code: 'session_journal_deleted',
    });
    assert.deepEqual((await conn.call('chat.remove', { chatId, epoch: 1, key: 'delete-key-1' })).result, { removed: true });
    // the other chat is whole
    assert.ok(mentions(h.dir, spellings(otherId)).some((f) => f.startsWith('threads')));
    assert.ok(mentions(h.dir, [OTHER_PNG]).some((f) => f.startsWith('images/')));
    assert.deepEqual(h.reports, []);
  } finally {
    h.close();
  }
});

test('a deletion that reaches the Host later (the machine was away) removes the content then, and a deletion the Host refuses stays queued', async () => {
  const h = host();
  try {
    const chatId = `acp:fake:${randomUUID()}`;
    const conn = await h.connect('client-a');
    await conn.call('chat.send', { chatId, epoch: 1, key: 'send-key-1', text: 'SECRET-first-prompt', cwd: h.dir });
    await waitFor(
      () =>
        h.sessions.state.snapshot(chatId).turn === 'idle' &&
        mentions(h.dir, [...spellings(chatId), 'SECRET-first-prompt']).some((f) => f.startsWith('threads')),
      'the chat saved',
    );
    let status = 'offline';
    let refuse = true;
    const outbox = createDeletionOutbox({
      dir: path.join(h.dir, '..', `outbox-${path.basename(h.dir)}`),
      identity: () => 'mac-identity',
      hostFor: () => ({
        speaks: () => true,
        removeChat: async (id: string, o: { epoch: number; key: string }) => {
          if (refuse) throw new Error('refused');
          return (await conn.call('chat.remove', { chatId: id, ...o })).result;
        },
      }),
      rowOf: () => ({ status }),
    });
    const job = outbox.enqueue({ hostId: 'box', chatId, epoch: 1 });
    // away: nothing reaches the Host, the job waits on disk, and the Host still holds the chat
    await outbox.flush();
    assert.equal(outbox.has(job), true);
    assert.ok(mentions(h.dir, ['SECRET-first-prompt']).length > 0);
    // back, but it refuses: the job stays
    status = 'online';
    await outbox.flush();
    assert.equal(outbox.has(job), true);
    // back and answering: the job's own key deletes the chat there and the job is done
    refuse = false;
    await outbox.flush();
    assert.equal(outbox.has(job), false);
    assert.deepEqual(mentions(h.dir, ['SECRET-first-prompt']), []);
    fs.rmSync(path.join(h.dir, '..', `outbox-${path.basename(h.dir)}`), { recursive: true, force: true });
  } finally {
    h.close();
  }
});

test('a Host that died under a deletion finishes it when the same key is sent again', async () => {
  // A: the Host dies after the tombstone, during the record's removal
  const a = host();
  const chatId = `acp:fake:${randomUUID()}`;
  const conn = await a.connect('client-a');
  await conn.call('chat.send', { chatId, epoch: 1, key: 'send-key-1', text: 'SECRET-first-prompt', cwd: a.dir });
  await waitFor(
    () =>
      a.sessions.state.snapshot(chatId).turn === 'idle' && mentions(a.dir, ['SECRET-first-prompt']).some((f) => f.startsWith('threads')),
    'the chat saved',
  );
  (a.sessions.chatRuntime as any).retire = () => new Promise(() => undefined);
  void conn.call('chat.remove', { chatId, epoch: 1, key: 'delete-key-1' });
  await waitFor(() => fs.existsSync(path.join(a.dir, 'sessions', `${sha(chatId)}.deleted`)), 'the tombstone written');
  assert.ok(mentions(a.dir, ['SECRET-first-prompt']).length > 0, 'the content is still there when the Host dies');
  a.close();
  // B: the next Host on the same folder is sent the same key: the request log has `started` and nothing else
  const b = host({ dir: a.dir });
  try {
    const again = await b.connect('client-a');
    assert.deepEqual((await again.call('chat.remove', { chatId, epoch: 1, key: 'delete-key-1' })).result, { removed: true });
    assert.deepEqual(mentions(a.dir, ['SECRET-first-prompt']), []);
    assert.deepEqual(b.reports, []);
  } finally {
    b.close();
  }
});

test('a deletion that failed in one step does not forget the clients whose uploads it still has to remove: the retry finds them', async () => {
  const failing = { left: 1 };
  const h = host({ failUploads: failing });
  try {
    const chatId = `acp:fake:${randomUUID()}`;
    // client Z sent a message with a picture and is not paired now (the client table does not name it)
    const z = await h.connect('client-z');
    await upload(z, chatId, PNG, 'image/png');
    await z.call('chat.send', { chatId, epoch: 1, key: 'send-key-1', text: 'SECRET-first-prompt', cwd: h.dir, images: [sha(PNG)] });
    await waitFor(() => h.sessions.state.snapshot(chatId).turn === 'idle', 'the turn ended');
    assert.ok(mentions(h.dir, [PNG]).some((f) => f.startsWith('images/')));
    // another client (the Mac) sends the deletion, so the request log names Z only by what Z itself sent
    const mac = await h.connect('client-a');
    await assert.rejects(mac.call('chat.remove', { chatId, epoch: 1, key: 'delete-key-1' }), { code: 'session_journal_delete_failed' });
    assert.ok(
      mentions(h.dir, [PNG]).some((f) => f.startsWith('images/')),
      'nothing of the uploads is gone behind a failed step',
    );
    assert.deepEqual((await mac.call('chat.remove', { chatId, epoch: 1, key: 'delete-key-1' })).result, { removed: true });
    assert.deepEqual(mentions(h.dir, [PNG, 'SECRET-first-prompt']), []);
    assert.equal(failing.left, 0);
  } finally {
    h.close();
  }
});
