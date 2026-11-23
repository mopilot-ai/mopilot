// A Claude Code chat's name outlasts its transcript's size (electron/harness/claude/rename.cjs, #1932): the SDK reads a title
// line only from a transcript's first and last 64 KB, so each rename also writes Claude Code's custom-title.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-rename-'));
process.env.CLAUDE_CONFIG_DIR = root;
const require = createRequire(import.meta.url);
const { createRename } = require('../electron/harness/claude/rename.cjs');
const { findTranscript } = require('../electron/harness/claude/transcripts.cjs');
const sdk = () => import('@anthropic-ai/claude-agent-sdk');
// no CLI runs the session
const idle = () => null;

const proj = path.join(root, 'projects', '-tmp-x');
fs.mkdirSync(proj, { recursive: true });
let n = 0;
const PAD = 'x'.repeat(1000);

/** A new session's transcript: its first prompt, then `kb` KB of turns. */
function session(kb = 0) {
  const id = `11111111-2222-4333-8444-${String(++n).padStart(12, '0')}`;
  const file = path.join(proj, `${id}.jsonl`);
  const rec = (i: number, text: string) =>
    `${JSON.stringify({ type: i ? 'assistant' : 'user', sessionId: id, cwd: '/tmp/x', uuid: `u${i}`, timestamp: '2026-10-21T00:00:00Z', message: { role: i ? 'assistant' : 'user', content: text } })}\n`;
  fs.writeFileSync(file, rec(0, 'first prompt'));
  const grow = (k: number) => {
    for (let i = 1; i <= k; i++) fs.appendFileSync(file, rec(i, PAD));
  };
  grow(kb);
  return { id, file, grow, sidecar: path.join(proj, id, 'custom-title.json') };
}

const titleOf = async (id: string) => (await (await sdk()).getSessionInfo(id))?.customTitle;
const listedTitle = async (id: string) => (await (await sdk()).listSessions({})).find((s: any) => s.sessionId === id)?.customTitle;

test("a name written early stays the chat's name once the transcript grows past the SDK's 64 KB tail", async () => {
  const rename = createRename(sdk, findTranscript, idle);
  // the bug: the SDK's own rename alone is lost once the line leaves the tail
  const plain = session(80);
  await (await sdk()).renameSession(plain.id, 'Generated title');
  plain.grow(220);
  assert.equal(await titleOf(plain.id), undefined);

  const s = session(80);
  await rename(s.id, '  Stats module with unittest tests ');
  s.grow(220);
  assert.ok(fs.statSync(s.file).size > 300_000);
  assert.equal(await titleOf(s.id), 'Stats module with unittest tests');
  assert.equal(await listedTitle(s.id), 'Stats module with unittest tests');
  assert.deepEqual(JSON.parse(fs.readFileSync(s.sidecar, 'utf8')), { customTitle: 'Stats module with unittest tests' });
  assert.equal(fs.statSync(s.sidecar).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(s.sidecar)), ['custom-title.json']);
});

test('a later rename replaces the earlier one in the tail and after it leaves the tail', async () => {
  const rename = createRename(sdk, findTranscript, idle);
  const s = session(10);
  await rename(s.id, 'Generated title');
  s.grow(100);
  await rename(s.id, 'My name');
  assert.equal(await titleOf(s.id), 'My name');
  s.grow(200);
  assert.equal(await titleOf(s.id), 'My name');
});

test("a session's renames run in call order, a failed one neither blocking nor hiding the next", async () => {
  const calls: string[] = [];
  const gates: Array<() => void> = [];
  const fake = {
    renameSession: async (id: string, name: string) => {
      calls.push(`start ${name}`);
      await new Promise<void>((resolve) => gates.push(resolve));
      if (name === 'bad') throw new Error('Session not found');
      calls.push(`end ${name}`);
    },
  };
  const s = session();
  const rename = createRename(async () => fake, findTranscript, idle);
  const first = rename(s.id, 'Generated title');
  const bad = rename(s.id, 'bad');
  const mine = rename(s.id, 'My name');
  await new Promise((r) => setImmediate(r));
  // the second waits for the first, however slow
  assert.deepEqual(calls, ['start Generated title']);
  gates.shift()!();
  await first;
  await new Promise((r) => setImmediate(r));
  gates.shift()!();
  await assert.rejects(bad, /Session not found/);
  await new Promise((r) => setImmediate(r));
  gates.shift()!();
  await mine;
  assert.deepEqual(calls, ['start Generated title', 'end Generated title', 'start bad', 'start My name', 'end My name']);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.sidecar, 'utf8')), { customTitle: 'My name' });
  // done: a new rename starts at once
  const again = rename(s.id, 'Again');
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.at(-1), 'start Again');
  gates.shift()!();
  await again;
});

test('a rename whose transcript is gone, or whose sidecar cannot be written, says so and leaves no stray file', async () => {
  const fake = { renameSession: async () => {} };
  const gone = createRename(
    async () => fake,
    async () => null,
    idle,
  );
  await gone('11111111-2222-4333-8444-999999999999', 'Name');
  assert.equal(fs.existsSync(path.join(proj, '11111111-2222-4333-8444-999999999999')), false);

  const s = session();
  // a folder where the file goes: the move fails
  fs.mkdirSync(path.join(s.sidecar, 'x'), { recursive: true });
  const rename = createRename(async () => fake, findTranscript, idle);
  await assert.rejects(rename(s.id, 'Name'));
  assert.deepEqual(fs.readdirSync(path.dirname(s.sidecar)), ['custom-title.json']);
});

test('a running CLI is named through its control channel, so the title it keeps and appends again is the new one', async () => {
  const s = session(10);
  const sent: unknown[][] = [];
  const q = { renameSession: async (...a: unknown[]) => void sent.push(a) };
  const fileRenames: string[] = [];
  const rename = createRename(
    async () => ({ renameSession: async (_id: string, name: string) => void fileRenames.push(name) }),
    findTranscript,
    (id: string) => (id === s.id ? q : null),
  );
  await rename(s.id, 'My name');
  assert.deepEqual(sent, [['My name', s.id]]);
  // the CLI writes the line and the sidecar itself
  assert.deepEqual(fileRenames, []);
  assert.equal(fs.existsSync(s.sidecar), false);
});

test('a running CLI that refuses the rename (exited, or on another session) leaves it to the transcript and sidecar', async () => {
  const s = session(80);
  const q = { renameSession: async () => Promise.reject(new Error('Query closed')) };
  const rename = createRename(sdk, findTranscript, () => q);
  await rename(s.id, 'My name');
  s.grow(220);
  assert.equal(await titleOf(s.id), 'My name');
});
