// electron/harness/claude/index.cjs turnApi.hasTranscript (#2502): a session with a transcript on disk is told from one no message started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load, home } from './support/electron-claude.ts';

test('hasTranscript tells a session with a transcript on disk from one with none', async () => {
  const t = load();
  const projects = path.join(home, '.claude', 'projects', 'proj');
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, 'on-disk.jsonl'), '{}\n');
  assert.equal(await t.claude.turnApi.hasTranscript('on-disk'), true);
  assert.equal(await t.claude.turnApi.hasTranscript('never-started'), false);
});
