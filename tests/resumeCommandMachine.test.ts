// The resume command of a chat on a machine: the agent's own CLI command with the session uuid the chat id carries, valid in a shell on that machine (M53). A basic agent's chat there has only the Host's placeholder session: no command.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resumeCommandFor } = await import('../src/harness/registry.ts');
const { noteAcpSession } = await import('../src/harness/acpSessions.ts');
const { movedOnMachine } = await import('../src/lib/chatMachine.ts');

const UUID = '7a1c0e52-3f0b-4f43-9d54-0d1f7f0e9a11';

test('a Claude Code chat on a machine resumes with claude --resume and its uuid', () => {
  assert.equal(resumeCommandFor(`acp:host-claude:${UUID}`), `claude --resume ${UUID}`);
});

test('a Codex chat on a machine resumes with codex resume and its uuid', () => {
  assert.equal(resumeCommandFor(`acp:host-codex:${UUID}`), `codex resume ${UUID}`);
});

test('a machine chat id without a uuid has no command', () => {
  assert.equal(resumeCommandFor('acp:host-claude:'), null);
});

test("a basic agent's chat on a machine has no command: its session is the Host's placeholder, never an agent session", () => {
  noteAcpSession(`acp:kimi:${UUID}`, 'host:m1');
  assert.equal(resumeCommandFor(`acp:kimi:${UUID}`), null);
});

test('a basic agent on this Mac still resumes by the agent session id it reported, and an unknown agent has none', () => {
  noteAcpSession('acp:nope:s1', 'agent-session-1');
  assert.equal(resumeCommandFor('acp:nope:s1'), null);
  // none reported yet: no command
  assert.equal(resumeCommandFor('acp:kimi:never-seen'), null);
});

test('a machine chat moved to another agent there keeps its first agent id: the move is read from the Host-kept agent', () => {
  const id = `acp:host-claude:${UUID}`;
  assert.equal(movedOnMachine(id, undefined), false);
  assert.equal(movedOnMachine(id, null), false);
  assert.equal(movedOnMachine(id, 'claude'), false);
  assert.equal(movedOnMachine(id, 'codex'), true);
  assert.equal(movedOnMachine(id, 'acp:kimi'), true);
  assert.equal(movedOnMachine(`acp:host-codex:${UUID}`, 'codex'), false);
  assert.equal(movedOnMachine(`acp:kimi:${UUID}`, 'acp:kimi'), false);
  assert.equal(movedOnMachine(`acp:kimi:${UUID}`, 'claude'), true);
  // an id that names no ACP agent (a chat of this Mac) was not moved by a machine
  assert.equal(movedOnMachine('claude:abc', 'claude'), false);
});

test('a chat of this Mac resumes as before: Codex by its thread id, and an id no CLI owns has none', () => {
  assert.equal(resumeCommandFor(UUID), `codex resume ${UUID}`);
  assert.equal(resumeCommandFor(''), null);
});
