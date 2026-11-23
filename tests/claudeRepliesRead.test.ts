// A reader of prose (the sidebar's PR badge) gets only a Claude chat's finished assistant replies, read on the turns worker
// (electron/platform/claudeTurnsWorker.cjs) or in this thread when it is gone, and nothing it reads is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createTranscriptReader, createReadCache } = require('../electron/platform/claudeTranscriptRead.cjs');
const { readTurnPage } = createTranscriptReader({ noteIgnored: () => undefined });
const { createTranscripts } = require('../electron/harness/claude/transcripts.cjs');
const sdk = await import(new URL('../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs', import.meta.url).href);

const SID = randomUUID();
const row = (uuid: string, parentUuid: string | null, type: string, message: object) => ({
  uuid,
  parentUuid,
  type,
  timestamp: '2026-10-22T12:00:00Z',
  message,
});
const rows = [
  row('u1', null, 'user', { role: 'user', content: 'open a PR' }),
  row('a1', 'u1', 'assistant', {
    id: 'a1',
    role: 'assistant',
    content: [{ type: 'text', text: 'Opened https://github.com/o/r/pull/7' }],
    stop_reason: 'end_turn',
  }),
];
const realSdk = {
  getSessionMessages: (id: string, opts: any) =>
    sdk.getSessionMessages(id, { ...opts, sessionStore: { load: async () => rows }, dir: '/repo' }),
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replies-'));
const file = path.join(dir, `${SID}.jsonl`);
fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const request = { sessionId: SID, file, chatId: `claude:${SID}`, cwd: '/repo', replies: true };

test('a reader of prose gets only the finished assistant replies, from the worker or this thread, and keeps nothing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'turns-root-'));
  const proj = path.join(root, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  fs.copyFileSync(file, path.join(proj, `${SID}.jsonl`));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    const cache = createReadCache();
    const inline = await readTurnPage({ sdk: realSdk, cache }, request);
    assert.ok(inline.length > 0);
    for (const turn of inline) {
      assert.ok(turn.items.every((item: any) => item.type === 'agentMessage'));
    }
    assert.equal(cache.size, 0, 'a prose read is not kept');
    const state: any = { sdk: async () => realSdk, resumeAt: new Map() };
    const seen: any[] = [];
    const worker = { read: async (req: any) => (seen.push(req), 'from the worker') };
    assert.equal(await createTranscripts(state, worker).replies(SID, { cwd: '/repo' }), 'from the worker');
    assert.deepEqual(
      [seen[0].replies, seen[0].cwd, seen[0].chatId, seen[0].file],
      [true, '/repo', `claude:${SID}`, path.join(proj, `${SID}.jsonl`)],
    );
    await createTranscripts(state, worker).replies(SID);
    assert.equal(seen[1].cwd, '');
    const gone = { read: async () => Promise.reject(Object.assign(new Error('gone'), { workerDown: true })) };
    assert.deepEqual(
      await createTranscripts(state, gone).replies(SID, { cwd: '/repo' }),
      await createTranscripts(state, null).replies(SID, { cwd: '/repo' }),
    );
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
