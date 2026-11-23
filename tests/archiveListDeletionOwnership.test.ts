// Real Claude/ACP list entrypoints exclude only chats deleted while the list was in flight.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fx, reset } from './support/harness-logic-fakes.ts';
import { recordThreadDeletion } from '../src/store/archiveOwnership.ts';
const { loadClaudeThreads } = await import('../src/session/harness/claude/threads.ts');
const { loadAcpThreads } = await import('../src/session/harness/acp.ts');
beforeEach(() => reset());
for (const kind of ['claude', 'acp']) {
  test(`${kind}: pending list drops deleted identity but keeps an unrelated row and fresh read`, async () => {
    let resolve!: (data: any[]) => void;
    const page = new Promise<any[]>((r) => {
      resolve = r;
    });
    const id = kind === 'claude' ? 'claude:opaque:/"' : 'acp:kimi:opaque:/"';
    const other = kind === 'claude' ? 'claude:other' : 'acp:kimi:other';
    const rows =
      kind === 'claude'
        ? [
            { sessionId: 'opaque:/"', lastModified: 1000 },
            { sessionId: 'other', lastModified: 1000 },
          ]
        : [
            { id, createdAt: 0, updatedAt: 1000 },
            { id: other, createdAt: 0, updatedAt: 1000 },
          ];
    const load = kind === 'claude' ? loadClaudeThreads : loadAcpThreads;
    fx.native[kind] = { list: () => page };
    const read = load();
    recordThreadDeletion(id);
    recordThreadDeletion(id);
    resolve(rows);
    await read;
    assert.equal(fx.state.threads[id], undefined);
    assert.deepEqual(fx.state.threadOrder, [other]);
    fx.native[kind] = { list: async () => rows };
    await load();
    assert.equal(Object.keys(fx.state.threads).includes(id), true);
  });
  test(`${kind}: rejected list releases its read owner; a retry remains usable`, async () => {
    const original = console.warn;
    console.warn = () => {};
    try {
      fx.native[kind] = {
        list: async () => {
          throw new Error('unavailable');
        },
      };
      await (kind === 'claude' ? loadClaudeThreads : loadAcpThreads)();
      recordThreadDeletion('old');
      fx.native[kind] = { list: async () => [] };
      await (kind === 'claude' ? loadClaudeThreads : loadAcpThreads)();
      assert.deepEqual(fx.state.threadOrder, []);
    } finally {
      console.warn = original;
    }
  });
}
