// Audio submission journaling and history recovery preserve unknown delivery without a second native request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { encodeWav } from '../src/lib/dictation.ts';
import { deferred } from './support/async-scenarios.ts';
const require = createRequire(import.meta.url);
const { createAudioDispatch } = require('../electron/platform/audioDispatch.cjs');
const { createAudioAssets } = require('../electron/platform/audioAssets.cjs');
const { createAudioOwnership } = require('../electron/platform/audioOwnership.cjs');
const { audioEnd, audioHistory } = require('../electron/harness/acp/audio.cjs');
const { sendPrompt } = require('../electron/harness/acp/prompt.cjs');
const { RpcError } = require('../electron/harness/acp/rpc.cjs');
const { sendReceipt, acceptSendReceipt } = require('../shared/sendReceipt.mjs');
function world(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const journal = createAudioDispatch(() => path.join(dir, 'dispatch'));
  const rows: any[] = [],
    events: any[] = [];
  const response = deferred<any>();
  let sent = 0;
  const chat = {
    key: 'key',
    harness: 'fake',
    sessionId: 'native',
    cwd: dir,
    prompting: null as any,
    agent: {
      caps: { image: true, audio: true },
      request: () => {
        sent++;
        return response.promise;
      },
    },
  };
  const host: any = {
    chats: new Map([['key', chat]]),
    starting: new Map(),
    audioDispatch: journal,
    ensure: async () => chat,
    now: () => 123,
    label: () => 'Fake',
    signedInFn: () => {},
    authFailed: (_id: string, e: any) => e,
    items: {
      append: (_key: string, row: any) => rows.push(row),
      readAsync: async () => [...rows],
      audioRefs: async () => JSON.stringify(rows).match(/[a-f0-9-]{36}\.wav/g) ?? [],
      listAsync: async () => [{ id: 'key' }],
    },
    emitEvent: (e: any) => events.push(e),
    finish: (c: any, reason: string, error: string, run: any) => {
      const why = audioEnd(host, c, run, reason ?? 'error', error);
      rows.push({ t: 'end', turnId: run.turnId, ...why });
      c.prompting = null;
    },
  };
  const payload = {
    blocks: [{ type: 'audio', mimeType: 'audio/wav', data: 'test' }],
    display: [{ type: 'localAudio', path: '/saved.wav' }],
  };
  return { dir, journal, rows, host, chat, payload, response, sent: () => sent };
}

test('audio dispatch persists before writing, returns dispatched receipt and restores unresolved history after restart', async (t) => {
  const w = world(t);
  const receipt = await sendPrompt(w.host, 'key', w.payload, { uuid: 'intent' });
  assert.equal(receipt.delivery, 'dispatched');
  assert.equal(acceptSendReceipt(sendReceipt({ started: true, delivery: 'dispatched' }, 'id', false)), null);
  assert.equal(w.journal.list()[0].state, 'dispatched');
  assert.equal((await audioHistory(w.host, 'key')).length, 1, 'a live prompt is not falsely ended');
  w.chat.prompting = null;
  w.rows.length = 0;
  const recovered = await audioHistory(w.host, 'key');
  assert.equal(recovered[0].user.content[0].type, 'localAudio');
  assert.equal(recovered[1].delivery, 'unknown');
  await assert.rejects(sendPrompt(w.host, 'key', w.payload, { uuid: 'intent' }), /Delivery could not be confirmed/);
  assert.equal(w.sent(), 1);
  w.response.reject(new Error('connection lost'));
  await new Promise(setImmediate);
  assert.match(w.rows[0].error, /connection lost/);
  assert.equal(w.rows[0].delivery, 'unknown');
});

test('an explicit native refusal keeps its actionable reason and is distinct from transport ambiguity', async (t) => {
  const w = world(t);
  await sendPrompt(w.host, 'key', w.payload, { uuid: 'refused' });
  w.response.reject(new RpcError(-32000, 'Sign in to this provider', null));
  await new Promise(setImmediate);
  assert.equal(w.rows.at(-1).error, 'Sign in to this provider');
  assert.equal(w.rows.at(-1).delivery, 'confirmed');
  assert.equal(w.journal.list('key')[0].state, 'confirmed');
  assert.equal((await audioHistory(w.host, 'key')).length, 2);
  w.chat.agent.caps.audio = false;
  await assert.rejects(sendPrompt(w.host, 'key', w.payload, { uuid: 'other' }), /declared support/);
  assert.equal(w.sent(), 1);
});

test('audio ownership retains drafts, queued/history/journal references, and collects only old unreferenced assets', async (t) => {
  const w = world(t);
  const assets = createAudioAssets(() => path.join(w.dir, 'assets'));
  const make = () => assets.save(encodeWav(new Float32Array(16), 16000));
  const draft = make(),
    history = make(),
    pending = make(),
    queued = make(),
    orphan = make(),
    recent = make();
  for (const a of [draft, history, pending, queued, orphan]) fs.utimesSync(a.path, 0, 0);
  w.rows.push({ content: [{ type: 'localAudio', path: history.path }] });
  w.journal.begin('key', 'pending', [{ path: pending.path }], 1);
  const sessions = { all: () => ['key'], get: () => ({ queue: [{ attachments: [queued] }] }) };
  const own = createAudioOwnership(() => w.dir, assets, w.host, sessions);
  own.set('draft', { text: 'Keep', attachments: [draft] });
  assert.equal(createAudioOwnership(() => w.dir, assets, w.host, sessions).drafts().draft.text, 'Keep');
  await own.collect();
  assert.equal(fs.existsSync(orphan.path), false);
  for (const a of [draft, history, pending, queued, recent]) assert.equal(fs.existsSync(a.path), true);
  own.set('draft', { text: '', attachments: [] });
  own.delete('key', ['key']);
  w.rows.length = 0;
  await own.collect();
  assert.equal(fs.existsSync(draft.path), false);
  assert.equal(fs.existsSync(history.path), false);
  assert.equal(fs.existsSync(pending.path), false);
  assert.equal(fs.existsSync(queued.path), true);
  assert.throws(() => own.set('', {}), /Invalid/);
  fs.writeFileSync(path.join(w.dir, 'audio-drafts.json'), 'corrupt');
  const broken = createAudioOwnership(() => w.dir, assets, w.host, sessions);
  assert.throws(() => broken.drafts());
  assert.throws(() => broken.set('new', { attachments: [] }));
  assert.throws(() => broken.delete('key', []));
  await assert.rejects(broken.collect());
});

test('a recording a transcript names is kept whatever path it was written with', (t) => {
  const w = world(t);
  const root = path.join(w.dir, 'named');
  const assets = createAudioAssets(() => root);
  const named = assets.save(encodeWav(new Float32Array(16), 16000));
  const orphan = assets.save(encodeWav(new Float32Array(16), 16000));
  for (const a of [named, orphan]) fs.utimesSync(a.path, 0, 0);
  assets.collect([], Date.now(), [path.basename(named.path)]);
  assert.equal(fs.existsSync(named.path), true);
  assert.equal(fs.existsSync(orphan.path), false);
});

test('confirmed audio completion survives a missing final transcript end without becoming an error', async (t) => {
  const w = world(t);
  await sendPrompt(w.host, 'key', w.payload, { uuid: 'success' });
  w.response.resolve({ stopReason: 'end_turn' });
  await new Promise(setImmediate);
  w.rows.splice(1);
  const recovered = await audioHistory(w.host, 'key');
  assert.equal(recovered[1].stopReason, 'end_turn');
  assert.equal(recovered[1].error, null);
  assert.equal(recovered[1].delivery, 'confirmed');
});

test('failure to clean pending audio after native dispatch preserves its successful receipt and running task', async () => {
  const { AcpTurns } = require('../electron/harness/acpTurns.cjs');
  const events: any[] = [];
  const adapter = new AcpTurns({
    send: async () => ({ turnId: 'native-turn', delivery: 'dispatched' }),
    rename() {},
    readImage: async () => null,
    readAudio: async () => ({ type: 'audio', mimeType: 'audio/wav', data: 'AA' }),
    emit: (e: any) => events.push(e),
  });
  adapter.audioPending = {
    dispatched() {
      throw new Error('disk full');
    },
  };
  const item = { id: 'stable-intent', text: '', attachments: [{ kind: 'audio', path: '/saved.wav', name: 'Audio' }], opts: {} };
  const receipt = await adapter.startTurn('chat', { key: 'native' }, item);
  assert.equal(receipt.started, true);
  assert.equal(receipt.delivery, 'dispatched');
  assert.equal(events.filter((e) => e.kind === 'turnFailed').length, 0);
  assert.equal(events[0].clientId, 'stable-intent');
});

test('native audio acceptance is not rolled back by pending title/history reads or naming and notification failures', async () => {
  const { AcpTurns } = require('../electron/harness/acpTurns.cjs');
  for (const failure of ['named', 'rename', 'notification', 'pending']) {
    const events: any[] = [];
    let settle!: () => void;
    const named = new Promise<boolean>((resolve) => (settle = () => resolve(true)));
    const adapter = new AcpTurns({
      send: async () => ({ turnId: 'native', delivery: 'dispatched' }),
      readImage: async () => null,
      readAudio: async () => ({ type: 'audio', mimeType: 'audio/wav', data: 'AA' }),
      named:
        failure === 'pending'
          ? () => named
          : async () => {
              if (failure === 'named') throw new Error('history unreadable');
              return false;
            },
      rename: () => {
        if (failure === 'rename') throw new Error('title write failed');
      },
      emit: (event: any) => {
        events.push(event);
        if (failure === 'notification' && event.kind === 'turnStarted') throw new Error('window closed');
      },
    });
    const sending = adapter.startTurn(
      'chat',
      { key: 'chat' },
      { id: 'intent', text: 'Listen', attachments: [{ kind: 'audio', path: '/saved.wav' }], opts: {} },
    );
    const receipt = await Promise.race([
      sending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Naming blocked accepted receipt')), 100)),
    ]);
    settle();
    assert.equal((receipt as any).started, true);
    assert.equal((receipt as any).delivery, 'dispatched');
    await new Promise(setImmediate);
    assert.equal(
      events.some((e) => e.kind === 'turnFailed'),
      false,
    );
  }
});
