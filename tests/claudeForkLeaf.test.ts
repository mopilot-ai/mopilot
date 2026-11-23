// A fork's last copied message carries the time of the fork (the SDK's forkSession) and the SDK's reader drops
// `forkedFrom`: main marks that copy again from the raw transcript, so the fork's last turn keeps its own time
// (electron/harness/claude/transcripts.cjs forkLeafOf, #1941).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakes, load, home } from './support/electron-claude.ts';
import { readPage } from './support/claude-translate.ts';

const projects = path.join(home, '.claude', 'projects', 'fork-proj');
const at = (s: number) => new Date(Date.UTC(2026, 9, 21, 9, 0, s)).toISOString();
const from = { forkedFrom: { sessionId: 'src', messageUuid: 'x' } };
const user = (uuid: string, s: number) => ({ type: 'user', uuid, timestamp: at(s), message: { role: 'user', content: uuid } });
const said = (uuid: string, s: number) => ({
  type: 'assistant',
  uuid,
  timestamp: at(s),
  message: { id: uuid, content: [{ type: 'text', text: 'ok' }] },
});
const write = (sid: string, rows: (object | string)[]) => {
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, `${sid}.jsonl`), rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
};

test("a fork's last copy, stamped with the fork's time, does not stretch its turn; read once per session", async () => {
  const t = load();
  const msgs = [user('u1', 0), said('a0', 15), said('a1', 3600)];
  // the raw transcript: every line copied, the last one restamped; a title line the fork wrote after it
  write('forked', [
    { ...msgs[0], ...from },
    { ...msgs[1], ...from },
    { ...msgs[2], ...from },
    { type: 'custom-title', customTitle: 'chat (fork)', sessionId: 'forked' },
    'not json {"forkedFrom"',
  ]);
  fakes.sdk.getSessionMessages = async () => msgs;
  const page = readPage(await t.call('claude:turns', 'forked', { chatId: 'claude:forked' }));
  assert.equal(page.turns[0].durationMs, 15_000);
  // the answer is kept: the file going away later changes nothing
  fs.rmSync(path.join(projects, 'forked.jsonl'));
  assert.equal(readPage(await t.call('claude:turns', 'forked', { chatId: 'claude:forked' })).turns[0].durationMs, 15_000);
});

test('a session that is no fork, or has no transcript, is timed by all its messages', async () => {
  const t = load();
  const msgs = [user('u1', 0), said('a1', 40)];
  write('plain', msgs);
  fakes.sdk.getSessionMessages = async () => msgs;
  assert.equal(readPage(await t.call('claude:turns', 'plain', { chatId: 'claude:plain' })).turns[0].durationMs, 40_000);
  assert.equal(readPage(await t.call('claude:turns', 'nofile', { chatId: 'claude:nofile' })).turns[0].durationMs, 40_000);
});

test('a copied line with no uuid names no leaf', async () => {
  const t = load();
  const msgs = [user('u1', 0), said('a1', 40)];
  write('nouuid', [...msgs, { type: 'file-history-snapshot', ...from }]);
  fakes.sdk.getSessionMessages = async () => msgs;
  assert.equal(readPage(await t.call('claude:turns', 'nouuid', { chatId: 'claude:nouuid' })).turns[0].durationMs, 40_000);
});
