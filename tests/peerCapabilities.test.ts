import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ChatController } = require('../electron/session/controller.cjs');
const { CodexAdapter } = require('../electron/harness/codex.cjs');
const { ClaudeAdapter } = require('../electron/harness/claude/adapter.cjs');
const { AcpTurns } = require('../electron/harness/acpTurns.cjs');

test('peer protocol declarations come from each adapter and follow a switched chat', () => {
  let kind = 'codex';
  // Exercise the real dispatch contract with real adapter declarations; constructors
  // are unnecessary because declarations neither start processes nor access accounts.
  const controller = Object.create(ChatController.prototype);
  controller.ref = () => ({ kind });
  controller.codex = Object.create(CodexAdapter.prototype);
  controller.claudeTurns = Object.create(ClaudeAdapter.prototype);
  controller.acpTurns = Object.create(AcpTurns.prototype);
  for (const target of ['codex', 'claude', 'acp:kimi', 'acp:qwen']) {
    kind = target;
    assert.deepEqual(controller.peerCapabilities('same-stable-chat'), {
      messaging: true,
      read: true,
      steer: target === 'codex' || target === 'claude',
      toolChannel:
        target === 'codex' ? 'channel.codex.threadConfigMcp' : target === 'claude' ? 'channel.claude.sdkMcp' : 'channel.acp.sessionMcp',
    });
  }
  controller.acpTurns = {};
  assert.deepEqual(controller.peerCapabilities('same-stable-chat'), { messaging: false, read: false, steer: false });
});
