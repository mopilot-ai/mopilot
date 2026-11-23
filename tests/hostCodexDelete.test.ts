// Deleting a Codex chat on a Host reaches Codex's own delete for the chat's thread, awaited, and nothing of it stays in Codex's store that the Host can reach (host/src/chatRetire.mjs, agentLeftovers.mjs), over the stand-in app-server that keeps a rollout file per thread (tests/fixtures/fake-codex-app-server.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { base, installCodex, open, until } from './support/hostCodexKit.ts';
import { waitFor } from './support/waitFor.ts';

const WORDS = 'SECRET-codex-prompt';

/** A Host whose Codex keeps its store under `home`, and a chat that ran one turn on it. */
async function ran(mode: string) {
  const dir = fs.mkdtempSync(path.join(base, 'cd-'));
  const home = path.join(dir, 'codex-home');
  const h = await open(
    dir,
    { ...installCodex(dir).env, CODEX_HOME: home, FAKE_CODEX_HOME: home, FAKE_CODEX_UUIDS: '1', FAKE_CODEX_DELETE: mode },
    undefined,
    {},
    { dataDir: dir },
  );
  const chatId = `codex-chat-${mode}`;
  await h.call('chat.subscribe', chatId);
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(base, 'cwd-')));
  await h.call('chat.start', chatId, { harness: 'codex', text: WORDS, cwd });
  await until(() => h.sessions.state.snapshot(chatId).turn === 'idle' && h.replies(chatId).length > 0);
  const thread = h.sessions.controller.ref(chatId).id as string;
  const stored = () => {
    const found: string[] = [];
    const walk = (at: string) => {
      for (const e of fs.existsSync(at) ? fs.readdirSync(at, { withFileTypes: true }) : []) {
        const file = path.join(at, e.name);
        if (e.isDirectory()) walk(file);
        else if (fs.readFileSync(file, 'utf8').includes(WORDS)) found.push(path.relative(home, file));
      }
    };
    walk(home);
    return found;
  };
  return { h, dir, chatId, thread, stored, remove: () => h.call('chat.remove', chatId) };
}

test("a Codex chat's delete is Codex's own delete for its thread, awaited, and the rollout is gone", async () => {
  const c = await ran('remove');
  try {
    assert.equal(c.stored().length, 1, 'the prompt is in the rollout before the delete');
    assert.deepEqual((await c.remove()).result, { removed: true });
    const asked = c.h.requests().filter((r: any) => r.method === 'thread/delete');
    assert.deepEqual(
      asked.map((r: any) => r.params),
      [{ threadId: c.thread }],
    );
    assert.deepEqual(c.stored(), []);
    assert.ok(c.h.logs.includes(`[codex-delete] chat=${c.chatId} session=${c.thread} deleted`), c.h.logs.join('\n'));
  } finally {
    c.h.close();
  }
});

for (const mode of ['archive', 'leave'])
  test(`Codex's delete that only ${mode === 'archive' ? 'archives' : 'answers'} leaves a rollout the Host removes itself, and says so in its log`, async () => {
    const c = await ran(mode);
    try {
      await c.remove();
      assert.equal(c.h.requests().filter((r: any) => r.method === 'thread/delete').length, 1);
      assert.deepEqual(c.stored(), []);
      const line = c.h.logs.find((l: string) => l.startsWith('[codex-delete]'));
      assert.match(line!, new RegExp(`session=${c.thread} deleted; left in its store and removed: rollout-.*${c.thread}\\.jsonl$`));
      assert.equal(c.h.logs.join('\n').includes(WORDS), false, 'the log holds ids, never text');
    } finally {
      c.h.close();
    }
  });

test('a Codex delete that fails refuses the chat deletion as a storage fault, keeps the record for the retry, and says why in the log', async () => {
  const c = await ran('fail');
  try {
    await assert.rejects(c.remove(), { code: 'session_journal_delete_failed' });
    assert.ok(c.h.logs.some((l: string) => l.includes(`[codex-delete] chat=${c.chatId} session=${c.thread} failed: database is locked`)));
    assert.equal(c.stored().length, 1, 'nothing is removed behind a delete Codex refused');
    assert.equal(c.h.sessions.chats.saved(c.chatId), true);
  } finally {
    c.h.close();
  }
});

test('a Codex thread that never had a turn has nothing to delete: Codex says so and the chat is deleted', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'cd-'));
  const home = path.join(dir, 'codex-home');
  const h = await open(
    dir,
    { ...installCodex(dir).env, CODEX_HOME: home, FAKE_CODEX_HOME: home, FAKE_CODEX_UUIDS: '1' },
    undefined,
    {},
    { dataDir: dir },
  );
  try {
    const chatId = 'codex-chat-empty';
    await h.call('chat.subscribe', chatId);
    // the thread is made and recorded, and no message follows
    await h.sessions.chatRuntime.prepare({ chatId, harness: 'codex', cwd: dir });
    assert.equal(h.sessions.chats.saved(chatId), true);
    assert.deepEqual((await h.call('chat.remove', chatId)).result, { removed: true });
    await waitFor(
      () => h.logs.some((l: string) => l.includes('[codex-delete]') && l.endsWith(' gone')),
      'the log says the thread was gone',
    );
    assert.equal(h.sessions.chats.saved(chatId), false);
  } finally {
    h.close();
  }
});
