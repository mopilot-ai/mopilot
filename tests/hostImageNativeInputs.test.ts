// Host images reach real shared adapters and fake native agents, retaining the original client key in full display events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setup, idle } from './support/host/claudeKit.ts';
import { open, base, until, installCodex } from './support/hostCodexKit.ts';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=', 'base64');

test('Claude Host sends image bytes to the actual SDK adapter and retains repeated positions under the original client id', async () => {
  const h = setup();
  try {
    const file = path.join(h.dir, 'picked.png');
    fs.writeFileSync(file, png);
    const key = `claude:${randomUUID()}`;
    const clientId = randomUUID();
    await h.sessions.chatRuntime.send({
      key,
      clientId,
      text: 'look',
      cwd: h.dir,
      human: true,
      attachments: [
        { kind: 'image', path: file },
        { kind: 'image', path: file },
      ],
    });
    await idle(h, key);
    const content = h.fake.queries[0].messages[0].content;
    assert.equal(content.filter((part: any) => part.type === 'image').length, 2);
    assert(content.filter((part: any) => part.type === 'image').every((part: any) => part.source.data === png.toString('base64')));
    const user = h.of('turnStart', key)[0].user;
    assert.equal(user.clientId, clientId);
    assert.equal(user.messageKey, clientId);
    assert.equal(user.content.filter((part: any) => part.type === 'localImage').length, 2);
  } finally {
    await h.close();
  }
});

test('Codex Host passes image paths and original clientUserMessageId to the real app-server adapter and stream', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'images-'));
  const h = await open(dir);
  try {
    const file = path.join(dir, 'picked.png');
    fs.writeFileSync(file, png);
    const key = 'image-native-codex';
    const clientId = randomUUID();
    const events: any[] = [];
    h.sessions.chatRuntime.host.on('event', (e: any) => events.push(e));
    await h.sessions.chatRuntime.prepare({ chatId: key, harness: 'codex', cwd: dir });
    await h.sessions.chatRuntime.send({ key, clientId, text: 'look', cwd: dir, human: true, attachments: [{ kind: 'image', path: file }] });
    const turn = await until(() => h.requests().find((r: any) => r.method === 'turn/start'));
    assert.equal(turn.params.clientUserMessageId, clientId);
    assert(turn.params.input.some((part: any) => part.type === 'localImage' && part.path === file));
    const start = await until(() => events.find((e) => e.kind === 'turnStart'));
    assert.equal(start.user.clientId, clientId);
    assert.equal(start.user.content.filter((part: any) => part.type === 'localImage').length, 1);
    await until(() => h.sessions.state.snapshot(key).turn === 'idle');
  } finally {
    h.close();
  }
});

test('a queued Host image retains its pairing guard through the actual busy controller and SessionStore clone', async () => {
  const h = setup();
  try {
    const key = `claude:${randomUUID()}`;
    const file = path.join(h.dir, 'queued.png');
    fs.writeFileSync(file, png);
    await h.sessions.chatRuntime.send({ key, text: 'SLOW first', cwd: h.dir });
    await until(() => h.text(key) === 'working');
    let valid = true;
    const clientId = randomUUID();
    const receipt = await h.sessions.chatRuntime.send({
      key,
      clientId,
      text: 'retired image',
      attachments: [{ kind: 'image', path: file }],
      check: () => {
        if (!valid) throw Object.assign(new Error('pair retired'), { code: 'unknown_client' });
      },
    });
    assert.equal(receipt.action, 'queued');
    const queued = h.sessions.state.get(key).queue[0];
    assert.equal(queued.id, clientId);
    valid = false;
    await h.sessions.controller.sendNow(key, queued.id, null, true);
    assert.equal(h.fake.queries[0].messages.length, 1, 'revoked queued bytes never enter the native SDK');
  } finally {
    await h.close();
  }
});

test('Claude actual SDK input UUID survives saved transcript translation and both whole/recent phone read entrypoints', async () => {
  const { createFakeClaudeSdk } = await import('./support/fakeClaudeSdk.mjs');
  const { configDir } = await import('./support/host/claudeKit.ts');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { openHistory, allTurns, releaseHistory } = require('../electron/platform/claudeHistory.cjs');
  const { createPeerNativeReader } = require('../electron/session/peerNativeHistory.cjs');
  const { rowsOf } = require('../electron/capabilities/browser/chromePanelLive.cjs');
  const { row } = await import('../mobile/src/presentation/thread');
  const { withSent, settled } = await import('../mobile/src/presentation/sentMessages');
  const h = setup(undefined, createFakeClaudeSdk({ configDir, recordInputs: true }));
  try {
    const file = path.join(h.dir, 'cold.png');
    fs.writeFileSync(file, png);
    const native = randomUUID();
    const key = `claude:${native}`;
    const clientId = randomUUID();
    await h.sessions.chatRuntime.send({ key, clientId, text: '', cwd: h.dir, human: true, attachments: [{ kind: 'image', path: file }] });
    await idle(h, key);
    const saved = fs
      .readFileSync(path.join(configDir, 'projects', 'fake-project', `${native}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const user = saved.find((entry) => entry.type === 'user');
    assert.equal(user.uuid, clientId, 'identity came from the actual native SDK input');
    assert.equal(user.message.content.find((part: any) => part.type === 'image').source.data, png.toString('base64'));
    const read = await openHistory(saved, native, h.dir, { key });
    let turns;
    try {
      turns = await allTurns(read);
    } finally {
      releaseHistory(read);
    }
    const reader = createPeerNativeReader({ claudeTurns: async () => turns });
    const segment = { kind: 'claude', nativeId: native };
    for (const result of [await reader(segment), await reader.recent(segment, undefined, { enough: () => true })]) {
      const shown = rowsOf(result.turns).rows.map((item: any) => row(item, 'rows'));
      const record = shown.find((item: any) => item.role === 'user');
      assert.equal(record.clientId, clientId);
      assert.equal(record.images, 1);
      assert.equal(settled(withSent([], [], '', 'send', [], ['file:///cold.png'], clientId), shown).length, 0);
    }
  } finally {
    await h.close();
  }
});

test('Codex actual app-server replay preserves the client identity and image positions for strict phone reconciliation', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'cold-images-'));
  const h = await open(dir, { ...installCodex(dir).env, FAKE_CODEX_KEEP_INPUTS: '1' });
  try {
    const file = path.join(dir, 'cold.png');
    fs.writeFileSync(file, png);
    const clientId = randomUUID();
    const key = 'cold-image-codex';
    await h.sessions.chatRuntime.prepare({ chatId: key, harness: 'codex', cwd: dir });
    await h.sessions.chatRuntime.send({ key, clientId, text: '', cwd: dir, human: true, attachments: [{ kind: 'image', path: file }] });
    const turn = await until(() => h.requests().find((r: any) => r.method === 'turn/start'));
    await until(() => h.sessions.state.snapshot(key).turn === 'idle');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { createPeerNativeReader } = require('../electron/session/peerNativeHistory.cjs');
    const { rowsOf } = require('../electron/capabilities/browser/chromePanelLive.cjs');
    const { row } = await import('../mobile/src/presentation/thread');
    const { withSent, settled } = await import('../mobile/src/presentation/sentMessages');
    const reader = createPeerNativeReader({
      codexTurns: (threadId: string, options: any) => h.family.codex.request('thread/turns/list', { threadId, ...options }),
    });
    const replay = await reader({ kind: 'codex', nativeId: turn.params.threadId });
    const shown = rowsOf(replay.turns).rows.map((item: any) => row(item, 'rows'));
    assert.equal(shown[0].clientId, clientId);
    assert.equal(shown[0].images, 1);
    assert.equal(settled(withSent([], [], '', 'send', [], ['file:///cold.png'], clientId), shown).length, 0);
  } finally {
    h.close();
  }
});
