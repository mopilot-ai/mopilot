// A chat's project folder read from its harness's native session without blocking, through switches and deletions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';
const require = createRequire(import.meta.url);
const { createChatProjects, PROJECT_READS } = require('../electron/session/chatProject.cjs');

function setup() {
  const segs: Record<string, any> = { a: { kind: 'acp:gemini', nativeId: 'one' } };
  const chats: any = {
    records: new Map([['a', {}]]),
    // a chat with no record yet names its first segment, as ChatsStore.record does
    record: (id: string) => ({ segments: [{ kind: 'codex', nativeId: 'first' }, segs[id] ?? { kind: 'acp:gemini', nativeId: id }] }),
  };
  const reads: { key: string; done: () => void }[] = [];
  const live = new Map<string, string>();
  const projects = createChatProjects({
    chats: () => chats,
    codexCwd: async (id: string) => (id === 'none' ? null : `/codex/${id}`),
    claudeCwd: async (ref: any) => `/claude/${ref.key}/${ref.id}`,
    acpCwd: (key: string) => live.get(key),
    acpHistory: (key: string) =>
      new Promise((resolve) => reads.push({ key, done: () => resolve([{ t: 'title' }, { t: 'session', cwd: `/${key}` }]) })),
  });
  const next = async () => {
    await tick();
    const read = reads.shift();
    assert.ok(read, 'a transcript read is pending');
    return read;
  };
  return { ...projects, segs, chats, reads, live, next };
}

test("each harness family's segment folder: Codex's thread, Claude's session, ACP's running session or transcript", async () => {
  const p = setup();
  assert.equal(await p.peerProject({ kind: 'codex', nativeId: 't' }), '/codex/t');
  assert.equal(await p.peerProject({ kind: 'claude', nativeId: 's' }), '/claude/claude:s/s');
  p.live.set('acp:gemini:run', '/running');
  assert.equal(await p.peerProject({ kind: 'acp:gemini', nativeId: 'run' }), '/running');
  assert.equal(p.reads.length, 0, 'a running ACP session reads no transcript');
  const project = p.peerProject({ kind: 'acp:gemini', nativeId: 'old' });
  (await p.next()).done();
  assert.equal(await project, '/acp:gemini:old');
  assert.equal(await p.peerProject({ kind: 'other', nativeId: 'n' }), null);
});

test("a chat's folder is its current segment's when the read ends: a switch mid-read reads again", async () => {
  const p = setup();
  const project = p.chatProject('a');
  let read = await p.next();
  assert.equal(read.key, 'acp:gemini:one');
  p.segs.a = { kind: 'acp:gemini', nativeId: 'two' };
  read.done();
  read = await p.next();
  assert.equal(read.key, 'acp:gemini:two');
  read.done();
  assert.equal(await project, '/acp:gemini:two');
  // the same native id under another harness is another segment
  const moved = p.chatProject('a');
  read = await p.next();
  p.segs.a = { kind: 'acp:qwen', nativeId: 'two' };
  read.done();
  read = await p.next();
  assert.equal(read.key, 'acp:qwen:two');
  read.done();
  assert.equal(await moved, '/acp:qwen:two');
});

test('a chat that switches on every read reads unknown after a bounded number of reads', async () => {
  const p = setup();
  const project = p.chatProject('a');
  for (let i = 0; i < PROJECT_READS; i++) {
    const read = await p.next();
    p.segs.a = { kind: 'acp:gemini', nativeId: `s${i}` };
    read.done();
  }
  assert.equal(await project, null);
  await tick();
  assert.equal(p.reads.length, 0);
});

test('a chat deleted while its folder is read has none; one with no record yet reads its first segment', async () => {
  const p = setup();
  const project = p.chatProject('a');
  const read = await p.next();
  p.chats.records.delete('a');
  read.done();
  assert.equal(await project, null, 'even though its record now reads as a new chat');
  const fresh = p.chatProject('fresh');
  const first = await p.next();
  assert.equal(first.key, 'acp:gemini:fresh');
  first.done();
  assert.equal(await fresh, '/acp:gemini:fresh');
  // a segment with no folder, or a harness MoPilot doesn't know, has none
  p.segs.n = { kind: 'codex', nativeId: 'none' };
  p.chats.records.set('n', {});
  assert.equal(await p.chatProject('n'), null);
  p.segs.n = { kind: 'other', nativeId: 'x' };
  assert.equal(await p.chatProject('n'), null);
});

test("a chat store that fails reads no folder rather than failing the caller's tool or request", async () => {
  const p = setup();
  p.chats.record = () => {
    throw new Error('broken');
  };
  assert.equal(await p.chatProject('a'), null);
});
