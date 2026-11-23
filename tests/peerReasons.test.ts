// shared/peerReasons.mjs: every reason code main's peer messaging gives has a line a person reads, and an unknown one
// gets the generic line, never the code (#1863).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PEER_REASONS, UNKNOWN_PEER_REASON, peerReasonText } from '../shared/peerReasons.mjs';

/** snake_case string literals: every reason code main's peer messaging gives is one. */
const codes = (text: string) => [...text.matchAll(/'([a-z]+(?:_[a-z]+)+)'/g)].map((m) => m[1]);

/** What main gives as a peer reason: the peer services, the receiving chat's gate and tools, and a turned-off start. */
function emitted() {
  const peer = fs
    .readdirSync('electron/session')
    .filter((f) => /^peer.*\.cjs$/.test(f))
    .flatMap((f) => codes(fs.readFileSync(`electron/session/${f}`, 'utf8')));
  const sessions = fs.readFileSync('electron/app/sessions.cjs', 'utf8');
  const availability = /const PEER_AVAILABILITY = \{[\s\S]*?\n {2}\};/.exec(sessions)?.[0] ?? '';
  const wiring = /new PeerRuntime\(\{[\s\S]*?\n {4}\}\);/.exec(sessions)?.[0] ?? '';
  assert.ok(availability && wiring, 'the peer wiring in electron/app/sessions.cjs moved: update this test');
  const controller = /onDispatchResult\?\.\(\{ chatId, item, result: \{ started: false, blocked: off[^}]*\}/.exec(
    fs.readFileSync('electron/session/controller.cjs', 'utf8'),
  )?.[0];
  assert.ok(controller, "the turned-off start's result in electron/session/controller.cjs moved: update this test");
  return new Set([...peer, ...codes(availability), ...codes(wiring), ...codes(controller)]);
}

test('every reason code main gives for peer messaging has a line', () => {
  const all = emitted();
  assert.ok(all.size > 40, `found only ${all.size} codes`);
  const missing = [...all].filter((code) => !Object.hasOwn(PEER_REASONS, code));
  assert.deepEqual(missing, [], 'add a line to shared/peerReasons.mjs for each');
  // the turned-off harness, the receiving chat's sign-in and the tool channel all arrive as codes
  for (const code of ['harness_turned_off', 'login_required', 'tool_bridge_disabled', 'adapter_capability_unavailable'])
    assert.ok(all.has(code), code);
});

test('each line is a short sentence that names no code', () => {
  for (const [code, line] of Object.entries(PEER_REASONS)) {
    assert.match(line, /^[A-Z].*\.$/, code);
    assert.doesNotMatch(line, /_/, code);
    assert.ok(line.length <= 72, code);
  }
});

test('a known code reads as its line; an unknown, absent or malformed one as the generic line', () => {
  assert.equal(peerReasonText('adapter_capability_unavailable'), 'That chat’s harness can’t take messages.');
  for (const code of ['bridge_off', 'Turned off by MoPilot for now', 'toString', '__proto__', null, undefined, 42, {}])
    assert.equal(peerReasonText(code), UNKNOWN_PEER_REASON, String(code));
});
