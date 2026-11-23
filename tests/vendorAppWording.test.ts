// Vendor messages that send the user to a vendor desktop app, in MoPilot's words (shared/vendorAppWording.mjs),
// and the problem they make for Codex's computer use and any vendor control tool (shared/skyComputerUse.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOPILOT_ADVICE, rewordVendorApp } from '../shared/vendorAppWording.mjs';
import { skyProblem, vendorAppProblem } from '../shared/skyComputerUse.mjs';

test('every way a vendor sends the user to its desktop app becomes MoPilot advice, once', () => {
  for (const ask of [
    'Please relaunch ChatGPT.',
    'Quit and reopen the ChatGPT app.',
    'Restart the ChatGPT desktop app and try again.',
    'Open the Codex app to continue.',
    'Update the Codex desktop application.',
    'Open the Claude app.',
    'Make sure Claude Desktop is running.',
    'Ensure the Claude desktop app is open.',
    'Launch Claude for Mac.',
    'Sign in to ChatGPT first.',
    'ChatGPT is not running.',
    "The Claude app isn't open.",
  ])
    assert.equal(rewordVendorApp(`Computer use failed. ${ask} Code 7.`), `Computer use failed. ${MOPILOT_ADVICE} Code 7.`, ask);
  // two such sentences make one advice; a line break is kept
  assert.equal(rewordVendorApp('Open the ChatGPT app. Then relaunch ChatGPT!\nDetails: x'), `${MOPILOT_ADVICE}\nDetails: x`);
  assert.equal(rewordVendorApp('Relaunch ChatGPT'), MOPILOT_ADVICE);
});

test('anything else is left as the vendor sent it', () => {
  for (const other of [
    'Restart Claude Code and try again.',
    'Open Claude in Chrome from the toolbar.',
    'Restart Codex Computer Use.',
    'The page could not be opened.',
    'ChatGPT answered.',
  ])
    assert.equal(rewordVendorApp(other), null, other);
  assert.equal(rewordVendorApp(undefined), null);
  assert.equal(rewordVendorApp(42), null);
});

test("Codex's computer use: a Sky message asking to relaunch ChatGPT reads as MoPilot's, with Try again and Computer use settings", () => {
  const service = skyProblem('Sky Computer Use service startup failed. Please relaunch ChatGPT and try again.', { failed: true })!;
  assert.equal(service.kind, 'serviceUnavailable');
  assert.equal(service.message, `Sky Computer Use service startup failed. ${MOPILOT_ADVICE}`);
  assert.deepEqual(service.actions, [
    { kind: 'retry', label: 'Try again' },
    { kind: 'settings', label: 'Computer use settings', section: 'computer' },
  ]);
  const perms = skyProblem('Computer Use permissions are not granted. Open the ChatGPT app to grant them.')!;
  assert.equal(perms.message, `Computer Use permissions are not granted. ${MOPILOT_ADVICE}`);
  assert.deepEqual(
    perms.actions.map((a) => a.kind),
    ['retry', 'url', 'url', 'settings'],
  );
  // a message without one is kept as sent
  assert.equal(skyProblem('Computer Use permissions are not granted')!.actions.length, 3);
});

test('any vendor tool: a request to open its desktop app is a problem in MoPilot words; other text is none', () => {
  assert.deepEqual(vendorAppProblem('Claude in Chrome lost its connection. Please open the Claude app.'), {
    kind: 'vendorApp',
    code: null,
    name: null,
    message: `Claude in Chrome lost its connection. ${MOPILOT_ADVICE}`,
    title: "Computer use couldn't continue",
    hint: null,
    actions: [
      { kind: 'retry', label: 'Try again' },
      { kind: 'settings', label: 'Computer use settings', section: 'computer' },
    ],
  });
  assert.equal(vendorAppProblem('Navigated to https://a.test'), null);
  assert.equal(vendorAppProblem(null), null);
});
