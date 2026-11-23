// A window deletes a Codex, Claude Code or ACP chat's native session only through main's ChatDeletion (chats:delete), which retires the identity and sends the receipt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/', 'shared/'];

const require = createRequire(import.meta.url);
const { register } = require('../electron/harness/acp/ipc.cjs');
const { CodexApi, CODEX_API, windowMethod } = require('../electron/harness/codexApi.cjs');

test("no acp:* channel a window can call deletes a basic-harness chat's transcript", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const called: string[] = [];
  // every host method answers; the test only records which ones the channels reach
  const host = new Proxy({} as Record<string, unknown>, {
    get: (_t, name: string) => (name === 'on' ? () => {} : (...args: unknown[]) => (called.push(name), args)),
  });
  const items = { history: () => ({ turns: [], activeTurnId: null }) };
  register({ handle: (channel: string, h: (...args: unknown[]) => unknown) => handlers.set(channel, h) }, host, {
    broadcast: () => {},
    items,
  });
  assert.ok(handlers.size > 0);
  for (const [, h] of handlers) await h({ sender: { id: 1 } }, 'acp:kimi:x', 'a', 'b');
  assert.equal(called.includes('remove'), false, 'ChatDeletion calls host.remove; no window channel does');
});

test("the Codex calls a window may make by name don't delete a thread", async () => {
  assert.equal(CODEX_API.has('threadDelete'), false);
  const api = Object.create(CodexApi.prototype);
  await assert.rejects(api.api('threadDelete', ['t']), /Unknown Codex call threadDelete/);
  // ChatDeletion still deletes through main's own method
  assert.equal(typeof CodexApi.prototype.threadDelete, 'function');
});

test("a window's raw Codex request (codex:request, codex:leased) can't be a thread delete", () => {
  assert.throws(() => windowMethod('thread/delete'), /A window can't send thread\/delete/);
  assert.equal(windowMethod('thread/read'), 'thread/read');
  assert.equal(windowMethod(7), '7');
});

test('no claude:* channel a window can call deletes a session a chat owns; it may discard only a fork no chat took', async () => {
  const { load, fakes } = await import('./support/electron-claude.ts');
  const t = load();
  const deleted: string[] = [];
  fakes.sdk.deleteSession = async (id: string) => (deleted.push(id), true);
  fakes.sdk.forkSession = async () => ({ sessionId: 'fork' });
  // every CLI a channel starts (a /usage read, a title) ends at once: nothing is left running
  fakes.onQuery = (q: any) => q.end();
  const owned = new Set(['claude:owned', 'claude:fork']);
  t.claude.setChatNames((key: string) => owned.has(key));
  try {
    assert.ok(t.handlers.size > 0);
    assert.equal(t.handlers.has('claude:delete'), false);
    for (const [name, h] of t.handlers) {
      // a channel that waits (a login, a watch) is left waiting: only what it deletes counts
      const settled = Promise.resolve()
        .then(() => h({ sender: { id: 1 } }, 'owned', 'owned', 'owned'))
        .catch(() => {});
      await Promise.race([settled, new Promise((r) => setTimeout(r, 20))]);
      assert.deepEqual(deleted, [], name);
    }
    // a fork main made, once a chat's record names it, is that chat's
    assert.deepEqual(await t.call('claude:fork', 'owned', null, true), { sessionId: 'fork' });
    await assert.rejects(t.call('claude:discardFork', 'fork'), /belongs to a chat/);
    owned.delete('claude:fork');
    await assert.rejects(t.call('claude:discardFork', 'fork'), /no chat has taken/);
    await t.call('claude:fork', 'owned', null, true);
    assert.equal(await t.call('claude:discardFork', 'fork'), true);
    assert.deepEqual(deleted, ['fork']);
  } finally {
    t.claude.closeAll();
  }
});
