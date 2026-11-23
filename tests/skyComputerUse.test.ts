// What Codex's computer use (OpenAI's Sky service behind the cua_repl plugin) reports when a step fails
// (shared/skyComputerUse.mjs): the vendor's message kept verbatim, each known Sky error code and message
// mapped to an actionable state with MoPilot's copy as the fallback, unknown codes shown raw, and
// the Info.plist version reading the Computer use settings use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SKY_ERROR_CODES,
  PRIVACY_PANES,
  skyProblem,
  skyProblemText,
  skyProblemOfItem,
  plistVersion,
  compareVersions,
  versionsNewestFirst,
} from '../shared/skyComputerUse.mjs';

const kindOf = (text: string, failed = true) => skyProblem(text, { failed })?.kind ?? null;

test('Sky error codes are the ones its mac client names, -10000 to -10020', () => {
  assert.equal(SKY_ERROR_CODES.permissionsNotGranted, -10009);
  assert.equal(SKY_ERROR_CODES.incompatibleClientVersion, -10013);
  assert.equal(SKY_ERROR_CODES.screenLocked, -10020);
  assert.deepEqual(
    Object.values(SKY_ERROR_CODES).sort((a, b) => b - a),
    Array.from({ length: 21 }, (_, i) => -10000 - i),
  );
});

test('each known Sky message maps to its state, and the vendor message is kept verbatim but for a vendor app request', () => {
  const cases: [string, string, string | null, number | null][] = [
    ['Computer Use permissions are not granted', 'permissions', 'permissionsNotGranted', -10009],
    ['Computer Use permissions are still pending', 'permissionsPending', 'permissionsPending', -10014],
    ["Computer Use is blocked from using the app 'com.apple.Terminal' by your organization's policy.", 'appBlocked', null, null],
    ["Computer Use is not allowed to use the app 'com.1password.1password' for safety reasons.", 'appRefused', null, null],
    ['Computer use actions are not allowed for system security process: loginwindow', 'appRefused', null, null],
    ['Computer Use was not approved to use Notes', 'notApproved', null, null],
    ["Computer Use approval denied via MCP elicitation for app 'Notes'", 'notApproved', null, null],
    ["Computer Use permission request canceled for app 'Notes'", 'notApproved', null, null],
    ['Computer Use stopped due to encountering a disallowed URL: https://bank.example', 'blockedUrl', 'blockedURL', -10015],
    [
      'Sky Computer Use API version mismatch: client=CodexComputerUseIPC-5 server=CodexComputerUseIPC-6',
      'versionMismatch',
      'incompatibleClientVersion',
      -10013,
    ],
    [
      'Computer Use could not start because its runtime app is missing. Try again, and if it fails after 2 more tries, suggest that the user relaunch ChatGPT.',
      'serviceMissing',
      null,
      null,
    ],
    ['Sky Computer Use native pipe is unavailable: ECONNREFUSED', 'serviceUnavailable', null, null],
    ['Sky Computer Use host service connection timed out', 'serviceUnavailable', null, null],
    ['Sky Computer Use service startup request failed', 'serviceUnavailable', null, null],
    ['Computer Use IPC server is unavailable.', 'serviceUnavailable', null, null],
    ['Computer Use XPC session is unavailable.', 'serviceUnavailable', null, null],
    ['Computer Use bootstrap failed.', 'serviceUnavailable', null, null],
    [
      'Computer Use is unavailable because the current turn ended. It will work again after the next user message.',
      'turnEnded',
      null,
      null,
    ],
    ['Computer Use is disabled by your configuration.', 'disabled', null, null],
  ];
  // a sentence sending the user to the ChatGPT app reads in MoPilot's words (vendorAppWording.mjs)
  const shown = (m: string) =>
    m.replace(
      'Try again, and if it fails after 2 more tries, suggest that the user relaunch ChatGPT.',
      'Try again in MoPilot. If it keeps failing, check Settings → Computer use.',
    );
  for (const [message, kind, name, code] of cases) {
    // as node_repl reports a thrown error: its message, here after other output
    const p = skyProblem(`opened the app\n  ${message}  \nmore`, { failed: true })!;
    assert.deepEqual([p.kind, p.name, p.code, p.message], [kind, name, code, shown(message)], message);
    // the vendor's message is the text a known problem reads as
    assert.equal(skyProblemText(p), shown(message));
  }
});

test("the states carry MoPilot's fallback copy and the step that fixes them", () => {
  const perms = skyProblem('Computer Use permissions are not granted')!;
  assert.equal(perms.title, 'Codex Computer Use needs permission');
  assert.match(perms.hint!, /Privacy & Security, turn on “Codex Computer Use” under Accessibility and Screen & System Audio Recording/);
  assert.match(perms.hint!, /Already on\? .*remove it with −, add it again with \+, then try again\.$/);
  assert.deepEqual(perms.actions, [
    { kind: 'url', label: 'Open Accessibility settings', url: PRIVACY_PANES.accessibility },
    { kind: 'url', label: 'Open Screen Recording settings', url: PRIVACY_PANES.screenRecording },
    { kind: 'retry', label: 'Try again' },
  ]);
  assert.equal(PRIVACY_PANES.screenRecording, 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  // each problem gets its own copy of the actions
  perms.actions.pop();
  assert.equal(skyProblem('Computer Use permissions are not granted')!.actions.length, 3);
  const settings = [{ kind: 'settings', label: 'Computer use settings', section: 'computer' }];
  const service = skyProblem('Sky Computer Use native pipe is unavailable')!;
  assert.deepEqual([service.title, service.actions], ["Codex Computer Use isn't running", settings]);
  assert.match(service.hint!, /MoPilot's own computer use is the fallback/);
  assert.deepEqual(
    [
      skyProblem('Computer Use could not start because its runtime app is missing')!.title,
      skyProblem('Computer Use could not start because its runtime app is missing')!.actions,
    ],
    ["Codex Computer Use isn't installed", settings],
  );
  const update = skyProblem('Sky Computer Use API version mismatch: client=a server=b')!;
  assert.deepEqual([update.title, update.actions], ['Codex Computer Use needs an update', settings]);
  assert.match(update.hint!, /MoPilot updates it when a newer copy is on this Mac/);
  // MoPilot's own copy never sends the user to another vendor app
  for (const p of [service, update, skyProblem('Computer Use could not start because its runtime app is missing')!])
    assert.doesNotMatch(p.hint!, /ChatGPT|Claude desktop/);
  assert.equal(skyProblem("Computer Use is blocked from using the app 'x'")!.title, 'Blocked by your organization');
  assert.equal(skyProblem("Computer Use is not allowed to use the app 'x'")!.title, "Codex Computer Use won't control this app");
});

test('a printed Sky error object: its code and name, mapped to a state; its own message first', () => {
  const printed = (o: any) => skyProblem(JSON.stringify(o));
  const p = printed({
    name: 'SkyComputerUseError',
    code: -10009,
    errorName: 'permissionsNotGranted',
    message: 'Computer Use permissions are not granted',
  })!;
  assert.deepEqual(
    [p.kind, p.code, p.name, p.message],
    ['permissions', -10009, 'permissionsNotGranted', 'Computer Use permissions are not granted'],
  );
  // a code alone names its error; a name alone gives its code
  assert.deepEqual([printed({ code: -10020 })!.kind, printed({ code: -10020 })!.name], ['screenLocked', 'screenLocked']);
  assert.deepEqual(
    [printed({ errorName: 'userIntervened' })!.kind, printed({ errorName: 'userIntervened' })!.code],
    ['userStopped', -10016],
  );
  assert.equal(printed({ errorName: 'userStoppedSession' })!.kind, 'userStopped');
  assert.equal(printed({ errorName: 'appNotAllowed', message: 'nope' })!.kind, 'appRefused');
  assert.equal(printed({ code: -10015 })!.kind, 'blockedUrl');
  assert.equal(printed({ code: -10013 })!.kind, 'versionMismatch');
  assert.equal(printed({ code: -10014 })!.kind, 'permissionsPending');
  // nested in what the program printed, one JSON value per line
  const nested = skyProblem(`step 1\n{"ok":false,"error":{"code":-10009,"message":"Computer Use permissions are not granted"}}\n{broken`)!;
  assert.deepEqual([nested.kind, nested.code, nested.message], ['permissions', -10009, 'Computer Use permissions are not granted']);
  // inside a printed list
  assert.equal(skyProblem('[{"code":-10011,"message":"no session"}]')!.name, 'noActiveSession');
  // an object with no message reads the text's known message, else its first line
  assert.equal(
    skyProblem('{"code":-10009}\nComputer Use permissions are not granted')!.message,
    'Computer Use permissions are not granted',
  );
  assert.equal(printed({ errorName: 'screenLocked' })!.message, '{"errorName":"screenLocked"}');
  // a number outside Sky's range, or a non-integer, is not a Sky code
  assert.equal(printed({ code: -32601, message: 'Method not found' }), null);
  assert.equal(printed({ code: -10009.5 }), null);
});

test("Node's printout of a SkyComputerUseError: its code and errorName fields", () => {
  const inspected =
    "SkyComputerUseError: Computer Use permissions are pending\n    at native-pipe.js:1:1 {\n  code: -10014,\n  errorName: 'permissionsPending',\n  request: null\n}";
  const p = skyProblem(inspected)!;
  assert.deepEqual(
    [p.kind, p.code, p.name, p.message],
    ['permissionsPending', -10014, 'permissionsPending', 'SkyComputerUseError: Computer Use permissions are pending'],
  );
  // only the code, or only the name
  assert.deepEqual(
    [skyProblem('SkyComputerUseError: x\n  code: -10020')!.kind, skyProblem('SkyComputerUseError: x\n  code: -10020')!.name],
    ['screenLocked', 'screenLocked'],
  );
  assert.deepEqual(
    [
      skyProblem("SkyComputerUseError: y { errorName: 'ambiguousApp' }")!.code,
      skyProblem("SkyComputerUseError: y { errorName: 'ambiguousApp' }")!.kind,
    ],
    [-10018, 'unknown'],
  );
  // a code in Sky's range that this version doesn't know: kept raw
  assert.deepEqual(
    [skyProblem('SkyComputerUseError: w\n  code: -10042')!.code, skyProblem('SkyComputerUseError: w\n  code: -10042')!.name],
    [-10042, null],
  );
  // a code that isn't Sky's is dropped, the error still counts
  const odd = skyProblem('SkyComputerUseError: z code: -19999', { failed: false })!;
  assert.deepEqual([odd.kind, odd.code, odd.name, odd.message], ['unknown', null, null, 'SkyComputerUseError: z code: -19999']);
});

test('an unknown Sky code or name is shown raw with the vendor message and a next step, never dropped', () => {
  const p = skyProblem(JSON.stringify({ name: 'SkyComputerUseError', code: -10042, message: 'Something new happened' }))!;
  assert.deepEqual(
    [p.kind, p.code, p.name, p.message, p.title, p.hint, p.actions],
    [
      'unknown',
      -10042,
      null,
      'Something new happened',
      'Codex Computer Use error',
      'Try again. If it stops again, bring another tab or app to the front, or do this step yourself.',
      [{ kind: 'send', label: 'Try again', text: 'Try that step again.' }],
    ],
  );
  assert.equal(skyProblemText(p), 'Codex Computer Use error (-10042): Something new happened');
  const named = skyProblem(JSON.stringify({ errorName: 'brandNewError', message: 'New thing' }))!;
  assert.deepEqual([named.kind, named.code, named.name], ['unknown', null, 'brandNewError']);
  assert.equal(skyProblemText(named), 'Codex Computer Use error (brandNewError): New thing');
  // a known Sky error with no state of its own keeps its name and code
  assert.equal(
    skyProblemText(skyProblem(JSON.stringify({ code: -10018, message: "Ambiguous app identifier 'Notes'" }))!),
    "Codex Computer Use error (ambiguousApp -10018): Ambiguous app identifier 'Notes'",
  );
  // an object only named SkyComputerUseError: no code or name to show
  assert.equal(
    skyProblemText(skyProblem(JSON.stringify({ name: 'SkyComputerUseError', message: 'odd' }))!),
    'Codex Computer Use error: odd',
  );
  // a failed call whose text only mentions Sky is an unknown Sky problem, with its first line
  assert.deepEqual(
    [
      kindOf('\n SkyComputerUseTransportError: frame too large\nstack'),
      skyProblem('\n SkyComputerUseTransportError: frame too large\nstack', { failed: true })!.message,
    ],
    ['unknown', 'SkyComputerUseTransportError: frame too large'],
  );
  assert.equal(kindOf('Codex Computer Use crashed'), 'unknown');
  // the vendor message is clipped, not dropped, when it is very long
  const long = skyProblem(`Sky Computer Use returned ${'x'.repeat(600)}`, { failed: true })!;
  assert.equal(long.message.length, 400);
  assert.ok(long.message.endsWith('…'));
});

test('no Sky problem: other failures, mentions in a call that worked, and no text', () => {
  assert.equal(kindOf('TypeError: app.click is not a function'), null);
  assert.equal(kindOf('Codex Computer Use crashed', false), null);
  assert.equal(kindOf('Clicked “Save”', false), null);
  for (const t of ['', '   ', null, 42]) assert.equal(skyProblem(t as any), null);
  assert.equal(skyProblem('Sky Computer Use mention'), null, 'not failed by default');
  // a successful call that printed Sky's error still reports it
  assert.equal(kindOf('{"errorName":"permissionsNotGranted"}', false), 'permissions');
});

test('skyProblemOfItem: a finished cua_repl call item, failed by its status, its error or an MCP error result', () => {
  const text = (t: string) => ({ content: [{ type: 'text', text: t }, { type: 'image', data: 'x' }, null] });
  assert.equal(skyProblemOfItem({ status: 'failed', error: { message: 'Computer Use permissions are not granted' } })!.kind, 'permissions');
  assert.equal(
    skyProblemOfItem({ status: 'completed', result: text('Sky Computer Use API version mismatch: client=a server=b') })!.kind,
    'versionMismatch',
  );
  assert.equal(
    skyProblemOfItem({ status: 'completed', result: { ...text('SkyComputerUseTransportError: closed'), isError: true } })!.kind,
    'unknown',
  );
  assert.equal(skyProblemOfItem({ status: 'failed', result: text('SkyComputerUseTransportError: closed') })!.kind, 'unknown');
  assert.equal(skyProblemOfItem({ error: { message: 'Codex Computer Use stopped' } })!.kind, 'unknown');
  assert.equal(skyProblemOfItem({ status: 'completed', result: text('SkyComputerUseTransportError: closed') }), null);
  assert.equal(skyProblemOfItem({ status: 'completed', error: { message: '' }, result: { content: 'x' } }), null);
  assert.equal(skyProblemOfItem(null), null);
});

test('plistVersion reads CFBundleShortVersionString from an XML Info.plist', () => {
  assert.equal(
    plistVersion('<dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>26.1005.1001425</string>\n</dict>'),
    '26.1005.1001425',
  );
  assert.equal(plistVersion('<key> CFBundleShortVersionString </key><string> 1.2 </string>'), '1.2');
  assert.equal(plistVersion('<key>CFBundleShortVersionString</key><string></string>'), null);
  assert.equal(plistVersion('<key>CFBundleVersion</key><string>1001425</string>'), null);
  assert.equal(plistVersion('bplist00 binary'), null);
  assert.equal(plistVersion(undefined), null);
});

test('versionsNewestFirst: newest by number (26.10 after 26.9), and names that are not a version left out', () => {
  assert.deepEqual(versionsNewestFirst(['26.9', 'latest', '26.10', '1.0', '26.10.0-rc', '.DS_Store']), ['26.10', '26.9', '1.0']);
  assert.deepEqual(versionsNewestFirst([]), []);
});

test('compareVersions: dotted numbers, missing parts as zero; null for anything else', () => {
  assert.equal(compareVersions('26.1005.1001425', '26.1007.1'), -1);
  assert.equal(compareVersions('26.1007.1', '26.1005.1001425'), 1);
  assert.equal(compareVersions('26.1005', '26.1005.0'), 0);
  assert.equal(compareVersions('26.1005.0', '26.1005'), 0);
  assert.equal(compareVersions('2', '10'), -1);
  assert.equal(compareVersions('1.0-beta', '1.0'), null);
  assert.equal(compareVersions(null, '1.0'), null);
  assert.equal(compareVersions('1.0', undefined), null);
});
