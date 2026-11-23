// Claude Code's rename IPC and the turn code's rename both go through the one rename that keeps a name past the SDK's
// 64 KB read (electron/harness/claude/rename.cjs, #1932; its behavior: tests/claudeRename.test.ts).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fakes, load, fakeBin, lastQuery } from './support/electron-claude.ts';

test('the rename IPC and the turn code rename through the SDK and resolve once the name is kept', async () => {
  const t = load();
  const renamed = mock.method(fakes.sdk, 'renameSession', async () => {});
  try {
    assert.equal(await t.call('claude:rename', 'a', 'New'), undefined);
    assert.equal(await t.claude.turnApi.rename('b', 'Other'), undefined);
    assert.deepEqual(
      renamed.mock.calls.map((c) => c.arguments),
      [
        ['a', 'New'],
        ['b', 'Other'],
      ],
    );
  } finally {
    renamed.mock.restore();
  }
});

test("a chat whose CLI runs is renamed through that CLI's query", async () => {
  const t = load();
  await t.claude.send(
    'claude:live',
    { bin: fakeBin('rename/claude'), sessionId: 'live', ephemeral: true },
    { role: 'user', content: 'hi' },
  );
  const sent: unknown[][] = [];
  (lastQuery() as any).renameSession = async (...a: unknown[]) => void sent.push(a);
  const file = mock.method(fakes.sdk, 'renameSession', async () => {});
  try {
    await t.call('claude:rename', 'live', 'Mine');
    assert.deepEqual(sent, [['Mine', 'live']]);
    assert.equal(file.mock.callCount(), 0);
  } finally {
    file.mock.restore();
    t.claude.closeAll();
  }
});
