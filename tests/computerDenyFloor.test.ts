// The helper's no-go floor covers macOS's permission and consent prompts (a click there could grant or revoke a privacy
// permission), and main always sends the floor with the user's list, so a stale helper build still refuses them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { BUILT_IN_DENY, withFloor } = require('../electron/capabilities/computerContract.cjs');

const PROMPTS = [
  'com.apple.tcc.AuthorizationPromptService',
  'com.apple.UserNotificationCenter',
  'com.apple.accessibility.universalAccessAuthWarn',
  'com.apple.screencaptureui',
  'com.apple.coreservices.uiagent',
  'com.apple.CoreLocationAgent',
  'com.apple.NetAuthAgent',
];

test('the floor refuses every permission and consent prompt host, in main and in the helper alike', () => {
  const swift = fs.readFileSync(new URL('../native/helper/Sources/HelperCore/DenyList.swift', import.meta.url), 'utf8');
  for (const id of PROMPTS) {
    assert.ok(
      BUILT_IN_DENY.some((d: any) => d.pattern === id),
      `${id} in BUILT_IN_DENY`,
    );
    assert.ok(swift.includes(`DenyRule("${id}"`), `${id} in DenyList.swift`);
  }
  // the two lists stay in step: every main rule is in the helper
  for (const d of BUILT_IN_DENY) assert.ok(swift.includes(`DenyRule("${d.pattern}", "${d.reason}"`), `${d.pattern} mirrored`);
});

test("withFloor: the floor first, then the user's list, without repeats (any case)", () => {
  const sent = withFloor(['com.example.bank', 'COM.APPLE.USERNOTIFICATIONCENTER', 'com.example.bank']);
  assert.deepEqual(
    sent.slice(0, BUILT_IN_DENY.length),
    BUILT_IN_DENY.map((d: any) => d.pattern),
  );
  assert.deepEqual(sent.slice(BUILT_IN_DENY.length), ['com.example.bank']);
  // no list yet: the floor alone
  assert.deepEqual(
    withFloor(undefined),
    BUILT_IN_DENY.map((d: any) => d.pattern),
  );
});
