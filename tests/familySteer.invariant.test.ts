// A message from another session steers into a running turn only where the harness takes a steer: each family's `steers`
// trait (what Send now routes by) and its adapter's declared peer steer capability (what admission asks) must agree, so
// a message is never admitted for a steer the route then refuses, or queued where it could have steered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MAIN_TRAITS, agentTraitsOf } = require('../electron/harness/family.cjs');
const { codexBindings, claudeBindings, acpBindings, machineBindings } = require('../electron/harness/bindings.cjs');
const { CodexAdapter } = require('../electron/harness/codex.cjs');
const { ClaudeAdapter } = require('../electron/harness/claude/adapter.cjs');
const { AcpTurns } = require('../electron/harness/acpTurns.cjs');

test('every harness family steers exactly when its adapter declares the peer steer capability', () => {
  const declared = {
    codex: CodexAdapter.prototype.peerCapabilities.call({}).steer,
    claude: ClaudeAdapter.prototype.peerCapabilities.call({}).steer,
    acp: AcpTurns.prototype.peerCapabilities.call({}).steer,
  };
  assert.deepEqual(Object.keys(declared).sort(), Object.keys(MAIN_TRAITS).sort(), 'a new family must be listed here');
  for (const [family, steer] of Object.entries(declared)) assert.equal(MAIN_TRAITS[family].steers, steer, family);
});

test("every family's steer capability (what the composer's Send label and hint read) is native exactly where its trait steers", () => {
  const bound = { codex: codexBindings(null), claude: claudeBindings(), acp: acpBindings(null, 'acp:kimi') };
  assert.deepEqual(Object.keys(bound).sort(), Object.keys(MAIN_TRAITS).sort(), 'a new family must be listed here');
  for (const [family, bindings] of Object.entries(bound)) assert.equal(bindings.steer.via !== 'none', MAIN_TRAITS[family].steers, family);
  // a chat on a machine takes a steer where its Host's agent does, whatever this Mac's family for it says
  for (const agent of ['codex', 'claude', 'acp:kimi', 'acp:host-claude', 'acp:host-codex', 'gemini'])
    for (const bindings of Object.values(bound))
      assert.equal(machineBindings(bindings, agent).steer.via !== 'none', agentTraitsOf(agent)?.steers === true, agent);
});
