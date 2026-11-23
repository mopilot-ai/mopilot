// A machine chat's credential choice follows the agent the chat runs on, not the spelling of its id (D13, #4278, S2b): after a Host restart a chat that moved to Claude Code is put back on its own sign-in, and one that moved away from it is not. A: the choice and the agent it was made for are kept together; W: a switch that settles moves it; B: an old file without the agent reads as it always did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatCredentials } from '../host/src/chatCredentials.mjs';
import { createOwnRuns } from '../host/src/ownCredentials.mjs';

const leases = { has: () => false, hasKey: () => false, hasOrg: () => false };
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'host-cred-harness-'));
/** A Host's credential store on `dir`: a second call on the same folder is the Host after a restart. */
const host = (dir: string) => {
  const ownRuns = createOwnRuns();
  const credentials = createChatCredentials({ leases, ownRuns, dataDir: dir });
  credentials.restore();
  return { ownRuns, credentials };
};

test('A: a chat whose id does not say Claude Code but whose choice was made for it is put back on its own sign-in after a restart', () => {
  const dir = temp();
  const first = host(dir);
  first.credentials.admit({ chatId: 'chat-moved-to-claude', harness: 'claude', credential: { source: 'own' } });
  assert.equal(first.ownRuns.has('chat-moved-to-claude'), true);
  assert.equal(host(dir).ownRuns.has('chat-moved-to-claude'), true);
});

test('A: a chat whose id says Claude Code but whose choice was made for another agent is not an own-run Claude chat after a restart', () => {
  const dir = temp();
  host(dir).credentials.admit({ chatId: 'claude:9f0e2d1c-0000-4000-8000-000000000001', harness: 'codex', credential: { source: 'own' } });
  assert.equal(host(dir).ownRuns.has('claude:9f0e2d1c-0000-4000-8000-000000000001'), false);
});

test('W: a settled switch moves the choice with the chat: to Claude Code it runs on its own sign-in at once and after a restart, away from it it is let go', () => {
  const dir = temp();
  const first = host(dir);
  first.credentials.admit({ chatId: 'chat-x', harness: 'codex', credential: { source: 'own' } });
  assert.equal(first.ownRuns.has('chat-x'), false);
  first.credentials.moved('chat-x', 'claude');
  assert.equal(first.ownRuns.has('chat-x'), true);
  assert.equal(host(dir).ownRuns.has('chat-x'), true);
  first.credentials.moved('chat-x', 'acp:gemini');
  assert.equal(first.ownRuns.has('chat-x'), false);
  assert.equal(host(dir).ownRuns.has('chat-x'), false);
  // a chat with no choice has nothing to move, and moving to where it already is changes nothing
  first.credentials.moved('chat-none', 'claude');
  assert.equal(first.credentials.choiceOf('chat-none'), null);
  const written = fs.readFileSync(path.join(dir, 'chat-credentials.json'), 'utf8');
  first.credentials.moved('chat-x', 'acp:gemini');
  assert.equal(fs.readFileSync(path.join(dir, 'chat-credentials.json'), 'utf8'), written);
});

test('B: a file an older Host wrote, with no agent beside the choice, is read as before: by the agent the chat id names', () => {
  const dir = temp();
  fs.writeFileSync(
    path.join(dir, 'chat-credentials.json'),
    JSON.stringify({
      'claude:old': { source: 'own' },
      'old-codex-thread': { source: 'own' },
      'acp:gemini:old': { source: 'own', login: 'default' },
    }),
  );
  const { ownRuns, credentials } = host(dir);
  assert.equal(ownRuns.has('claude:old'), true);
  assert.equal(ownRuns.has('old-codex-thread'), false);
  assert.equal(ownRuns.has('acp:gemini:old'), false);
  // what a reader of the choice sees is the choice, not the file's bookkeeping
  assert.deepEqual(credentials.choiceOf('acp:gemini:old'), { source: 'own', login: 'default' });
  credentials.admit({ chatId: 'chat-new', harness: 'claude', credential: { source: 'own', login: 'default' } });
  assert.deepEqual(credentials.choiceOf('chat-new'), { source: 'own', login: 'default' });
  assert.equal(credentials.stateOf('claude', true).using, 'own');
});

test('B: forgetting a chat lets go of its own sign-in whichever agent it was on', () => {
  const dir = temp();
  const { ownRuns, credentials } = host(dir);
  credentials.admit({ chatId: 'chat-gone', harness: 'claude', credential: { source: 'own' } });
  credentials.forget('chat-gone');
  assert.equal(ownRuns.has('chat-gone'), false);
  assert.equal(host(dir).ownRuns.has('chat-gone'), false);
});

test('B: a store with no own-run set (an embedder that has none) keeps and moves choices all the same', () => {
  const dir = temp();
  const credentials = createChatCredentials({ leases, dataDir: dir });
  credentials.admit({ chatId: 'chat-a', harness: 'claude', credential: { source: 'own' } });
  credentials.moved('chat-a', 'codex');
  credentials.restore();
  assert.deepEqual(credentials.choiceOf('chat-a'), { source: 'own' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'chat-credentials.json'), 'utf8'))['chat-a'].harness, 'codex');
});
