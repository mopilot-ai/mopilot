// This Mac as the target of a continue (electron/host/continueInbox.cjs) takes every family a chat can run on, unchanged by the Host taking them too (#4906): Claude Code, Codex and an ACP agent, and it refuses a harness no one spells.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createContinueInbox } = require('../electron/host/continueInbox.cjs');

test('A: the Mac as a target accepts Claude Code, Codex and an ACP agent, the way a chat on a machine is spelled too, and refuses an unknown harness', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-families-'));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-folder-'));
  const inbox = createContinueInbox({ dir: path.join(dir, 'inbox') });
  for (const harness of ['claude', 'codex', 'acp:gemini', 'acp:host-claude:chat-1']) {
    assert.equal(await inbox.target.check({ harness, cwd: folder }), fs.realpathSync(folder), harness);
  }
  await assert.rejects(inbox.target.check({ harness: 'nonsense', cwd: folder }), (e: any) => e.code === 'harness_not_configured');
});
