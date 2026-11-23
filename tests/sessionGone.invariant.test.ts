// #2502: a chat that remembers a session its harness no longer holds must be told apart from one that has it, on every
// harness family, so no chat resumes a session that does not exist. Each turn adapter answers `sessionGone(ref)`
// (ChatController.sessionGone asks it); a family added without it fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChatController } = require('../electron/session/controller.cjs');
const { CodexAdapter } = require('../electron/harness/codex.cjs');
const { ClaudeAdapter } = require('../electron/harness/claude/adapter.cjs');
const { AcpTurns } = require('../electron/harness/acpTurns.cjs');

test('every harness family’s turn adapter answers sessionGone', () => {
  for (const adapter of [CodexAdapter, ClaudeAdapter, AcpTurns])
    assert.equal(typeof adapter.prototype.sessionGone, 'function', adapter.name);
});

test('Claude Code: gone only when nothing started it this run, no CLI holds it and no transcript is on disk', async () => {
  const claude = Object.create(ClaudeAdapter.prototype);
  claude.sessions = new Map();
  let live = false;
  let transcript = false;
  claude.api = { isLive: () => live, hasTranscript: async () => transcript };
  const ref = { key: 'claude:s1', id: 's1' };
  assert.equal(await claude.sessionGone(ref), true);
  transcript = true;
  assert.equal(await claude.sessionGone(ref), false);
  transcript = false;
  live = true;
  assert.equal(await claude.sessionGone(ref), false);
  live = false;
  // registered by a start in this run: its first message creates the session
  claude.registerSession('claude:s1', { cwd: '/w' });
  assert.equal(await claude.sessionGone(ref), false);
});

test('Codex: gone when the thread is unrecorded and the app-server says so; held, recorded or other failures are not', async () => {
  const codex = Object.create(CodexAdapter.prototype);
  codex.unrecorded = new Set();
  codex.leases = new Map();
  let outcome: any = null;
  codex.ensureResumed = async () => {
    if (outcome) throw outcome;
  };
  const ref = { id: 'th1' };
  assert.equal(await codex.sessionGone(ref), false);
  outcome = new Error('no rollout found for thread id th1');
  assert.equal(await codex.sessionGone(ref), true);
  // another failure is the send's to show
  outcome = new Error('connection closed');
  assert.equal(await codex.sessionGone(ref), false);
  // started in this run, or held now: nothing to ask
  outcome = new Error('no rollout found for thread id th1');
  codex.unrecorded.add('th1');
  assert.equal(await codex.sessionGone(ref), false);
  codex.unrecorded.clear();
  codex.leases.set('th1', {});
  assert.equal(await codex.sessionGone(ref), false);
});

test('ACP is never gone; the controller asks the chat’s current adapter, and one without the check is not gone', async () => {
  assert.equal(AcpTurns.prototype.sessionGone(), false);
  let kind = 'claude';
  const controller = Object.create(ChatController.prototype);
  controller.ref = () => ({ kind, id: 'n1' });
  controller.claudeTurns = { sessionGone: async (ref: any) => ref.id === 'n1' };
  controller.codex = {};
  assert.equal(await controller.sessionGone('chat'), true);
  kind = 'codex';
  assert.equal(await controller.sessionGone('chat'), false);
});
