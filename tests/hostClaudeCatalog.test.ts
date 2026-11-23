// The Host lists Claude Code's commands and skills for a folder (#4915): through the harness's own catalog, with the CLI it runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createClaudeFamily } from '../host/src/claudeFamily.mjs';
import { setup } from './support/host/claudeKit.ts';

test('the Host lists Claude Code’s commands for a folder through the harness’s own catalog with the CLI it runs, and the factory refuses before the family is built (#4915)', async () => {
  const h = setup();
  try {
    const asked: unknown[] = [];
    h.family.claude.catalog = async (bin: string, cwd: string) => (asked.push([bin, cwd]), { commands: [] });
    assert.deepEqual(await h.family.catalog('/srv/app'), { commands: [] });
    assert.deepEqual(await h.make.catalog('/srv/app'), { commands: [] });
    await h.family.catalog();
    const bin = path.join(h.dir, 'claude');
    assert.deepEqual(asked, [
      [bin, '/srv/app'],
      [bin, '/srv/app'],
      [bin, ''],
    ]);
  } finally {
    await h.close();
  }
  await assert.rejects(createClaudeFamily({}).catalog('/p'), /has not started/);
});
