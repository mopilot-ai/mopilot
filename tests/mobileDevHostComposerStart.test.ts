// Fake-Mac pre-chat mention lists exercise the production ranker and file-search boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';

test('the fake Mac offers pre-chat mentions through the real ranker with default and supplied file search', async () => {
  const { ops } = createFakeApp({ repo: '/repo' });
  const before = await ops.mentionsStart({ harness: 'claude', projectId: null, query: '' });
  assert.deepEqual(before.files, []);
  assert.deepEqual(
    before.chats,
    (await ops.recent(200)).slice(0, 3).map((c: any) => ({ id: c.id, title: c.title })),
  );
  const asked: unknown[] = [];
  const app = createFakeApp({
    repo: '/fake-project',
    search: async (cwd, query, options) => {
      asked.push([cwd, query, options]);
      return { files: [{ path: 'src/a.ts', file_name: 'a.ts', match_type: 'file' }] };
    },
  });
  const found = await app.ops.mentionsStart({ harness: 'codex', projectId: 'app', query: 'src' });
  assert.deepEqual(asked, [['/fake-project', 'src', { limit: 12 }]]);
  assert.deepEqual(found.files, [{ path: 'src/a.ts', name: 'a.ts', directory: false }]);
});
