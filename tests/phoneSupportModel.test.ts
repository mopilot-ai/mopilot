// The support pages' model: each failing troubleshoot step names one problem, the Host states read the Mac's words, the log scrubs every secret and code, and the ported redaction and elapsed-time rows hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../tests/support/phone/register.ts';

const m = (p: string) => `../mobile/src/ui/support/${p}`;
const model = await import(m('supportModel'));
const logMod = await import(m('connectionLog'));
const { redactConnectionLogText, redactConnectionLogEntry } = await import('../mobile/vendor/orca/support/redactLog');
// by a variable path: this file draws React Native, whose types must not enter the node typecheck
const logRowsPath = '../mobile/vendor/orca/support/LogRows';
const { formatElapsed } = await import(logRowsPath);
const { parseMachines } = await import('../mobile/src/remote/machines');
const { t } = await import(m('adapters'));

const base = {
  online: true,
  signedIn: true,
  relay: 'ok',
  mac: { name: 'Studio Mac', paired: true, presence: 'online' },
  host: null,
};
const host = (o: object = {}) => ({
  status: 'online',
  note: '',
  agents: [],
  installable: [],
  lastSeen: null,
  localNetwork: '',
  waitingForLogin: null,
  ...o,
});
const NOW = 1_000_000;

test('every step passes when nothing is wrong', () => {
  const { checks, diagnosis } = model.runChecks(base, NOW);
  assert.deepEqual(
    checks.map((c: any) => c.status),
    ['pass', 'pass', 'pass', 'pass', 'pass'],
  );
  assert.deepEqual(diagnosis, {
    kind: 'ok',
    title: 'All good',
    hint: 'Your Mac is reachable.',
    failing: null,
  });
});

test('each failing step names one problem and skips the steps after it', () => {
  const cases: [object, string, string, string][] = [
    [{ online: false }, 'phone-offline', "You're offline", 'phone'],
    [{ signedIn: false }, 'signed-out', 'Signed out', 'account'],
    [{ relay: 'down' }, 'relay-down', "Can't reach MoPilot", 'relay'],
    [{ mac: { name: 'Studio Mac', paired: false, presence: null } }, 'unpaired', 'No Mac paired', 'mac'],
    [{ mac: { name: 'Studio Mac', paired: true, presence: 'sleeping' } }, 'mac-asleep', 'Studio Mac is asleep', 'mac'],
    [{ mac: { name: 'Studio Mac', paired: true, presence: 'gone' } }, 'mac-closed', 'MoPilot is closed on Studio Mac', 'app'],
  ];
  for (const [patch, kind, title, failing] of cases) {
    const { checks, diagnosis } = model.runChecks({ ...base, ...patch }, NOW);
    assert.equal(diagnosis.kind, kind);
    assert.equal(diagnosis.title, title);
    assert.equal(diagnosis.failing, failing);
    const at = checks.findIndex((c: any) => c.status === 'fail');
    assert.equal(checks.filter((c: any) => c.status === 'fail').length, 1);
    assert.ok(checks.slice(at + 1).every((c: any) => c.status === 'skip' && c.hint === null));
    assert.ok(checks.slice(0, at).every((c: any) => c.status === 'pass'));
  }
});

test('the Mac asleep and the Mac app closed are different problems with different next steps', () => {
  const asleep = model.runChecks({ ...base, mac: { name: 'M', paired: true, presence: 'sleeping' } }, NOW).diagnosis;
  const closed = model.runChecks({ ...base, mac: { name: 'M', paired: true, presence: 'gone' } }, NOW).diagnosis;
  assert.equal(asleep.hint, 'Wake your Mac, then run again.');
  assert.equal(closed.hint, 'Open MoPilot on your Mac.');
});

test("a Host's trouble reads in the Mac's own words, never a copy of them", () => {
  const cases: [object, string, string][] = [
    [{ cloud: 'deleted' }, 'host-deleted', 'Deleted at the provider'],
    [{ cloud: 'asleep', canWake: true }, 'host-asleep', 'Asleep · wakes on next message'],
    [{ cloud: 'asleep' }, 'host-asleep', 'Asleep · wake it from your Mac'],
    [{ cloud: 'stopping' }, 'host-asleep', 'Stopping · idle'],
    [{ cloud: 'waking' }, 'host-waking', 'Waking…'],
    [{ cloud: 'creating' }, 'host-waking', 'Creating…'],
    [{ status: 'offline', lastSeen: NOW - 120_000 }, 'host-away', 'Offline · seen 2 min ago'],
  ];
  for (const [patch, kind, title] of cases) {
    const { checks, diagnosis } = model.runChecks({ ...base, host: host(patch), hostName: 'Cloud box' }, NOW);
    assert.equal(diagnosis.kind, kind);
    assert.equal(diagnosis.title, title);
    assert.equal(diagnosis.failing, 'host');
    assert.equal(checks.at(-1).label, 'Cloud box is reachable');
  }
  assert.equal(model.runChecks({ ...base, host: host({ status: 'offline' }) }, NOW).diagnosis.hint, 'Check it on your Mac.');
  assert.equal(model.runChecks({ ...base, host: host({ cloud: 'deleted' }) }, NOW).diagnosis.hint, null);
});

test('a reachable Host passes, and a Mac problem stops before the Host is asked', () => {
  const ok = model.runChecks({ ...base, host: host() }, NOW);
  assert.equal(ok.checks.at(-1).status, 'pass');
  assert.equal(ok.diagnosis.kind, 'ok');
  assert.equal(model.hostKind(host()), null);
  const down = model.runChecks({ ...base, online: false, host: host({ cloud: 'deleted' }) }, NOW);
  assert.equal(down.checks.at(-1).status, 'skip');
  assert.equal(down.diagnosis.kind, 'phone-offline');
});

test('the Mac list row becomes the shared line input; a needs-setup machine is one that needs attention', () => {
  const row = {
    id: 'h',
    name: 'H',
    status: 'needs-setup',
    line: 'x',
    tone: 'warn',
    keepRunning: null,
    agents: [{ id: 'claude', label: 'Claude', state: 'ready', via: null }],
    lastSeen: 5,
    waitingForLogin: 'restarted',
    cloud: 'waking',
    waiting: 2,
  };
  const out = model.toLineMachine(row);
  assert.equal(out.status, 'attention');
  assert.equal(out.cloud, 'waking');
  assert.equal(out.lastSeen, 5);
  assert.deepEqual(out.agents, [{ id: 'claude', label: 'Claude', state: 'ready' }]);
  const bare = model.toLineMachine({
    ...row,
    status: 'online',
    lastSeen: undefined,
    waitingForLogin: undefined,
    cloud: undefined,
  });
  assert.deepEqual([bare.status, bare.lastSeen, bare.waitingForLogin, bare.cloud], ['online', null, null, null]);
});

test('the report is the steps and their hints, with no ids', () => {
  const { checks } = model.runChecks({ ...base, mac: { name: 'M', paired: true, presence: 'gone' } }, NOW);
  assert.equal(
    model.checksReport(checks),
    '✓ Phone online\n✓ Signed in\n✓ MoPilot reachable\n✓ Your Mac is awake\n✗ MoPilot is open on your Mac — Open MoPilot on your Mac.',
  );
  assert.match(model.checksReport(model.runChecks({ ...base, online: false }, NOW).checks), /–/);
});

test('the machine notice appears only on a direct path and says what the Mac is doing', () => {
  const vm = (reach: string) => ({
    name: 'H',
    state: 'connected',
    reach,
    waiting: 0,
  });
  assert.equal(model.machineNotice(vm('direct'), 'sleeping'), 'Your Mac is asleep. Direct access still works.');
  assert.equal(model.machineNotice(vm('direct'), 'gone'), 'Your Mac is away. Direct access still works.');
  assert.equal(model.machineNotice(vm('direct'), 'online'), null);
  assert.equal(model.machineNotice(vm('direct'), null), null);
  assert.equal(model.machineNotice(vm('through'), 'sleeping'), null);
});

test('the Mac list carries a Host cloud state only when it is one the phone knows', () => {
  const row = (cloud: unknown) => ({ id: 'h', line: 'x', cloud });
  const [a] = parseMachines({ machines: [row('deleted')] });
  const [b] = parseMachines({ machines: [row('bogus')] });
  assert.equal(a.cloud, 'deleted');
  assert.ok(!('cloud' in b));
});

test('the log keeps newest first, bounded, and tells listeners', () => {
  let at = 1_700_000_000_000;
  const log = logMod.createConnectionLog({ limit: 2, now: () => (at += 1000) });
  let heard = 0;
  const off = log.subscribe(() => heard++);
  log.add('info', 'one');
  log.add('ok', 'two');
  log.add('bad', 'three');
  assert.deepEqual(
    log.lines().map((l: any) => l.text),
    ['three', 'two'],
  );
  assert.match(log.report(), /^\d\d:\d\d:\d\d three\n\d\d:\d\d:\d\d two$/);
  off();
  log.clear();
  assert.equal(heard, 3);
  assert.deepEqual(log.lines(), []);
  assert.equal(log.report(), '');
  assert.ok(logMod.connectionLog.lines);
  const dflt = logMod.createConnectionLog();
  dflt.add('info', 'x');
  assert.equal(dflt.lines().length, 1);
});

test('no secret, pairing link, key-like run or safety number reaches a line', () => {
  const cases: [string, RegExp][] = [
    ['token=abc123 failed', /token=\[redacted\]/],
    ['open mopilot://pair?c=AAAA1111 now', /\[code\]/],
    ['code 1234 5678 9012 3456 7890 shown', /\[number\]/],
    ['code 12345678901234567890 shown', /\[number\]/],
    ['key AbCdEfGhIjKlMnOpQrStUvWx12 used', /\[hidden\]/],
  ];
  for (const [input, expected] of cases) assert.match(logMod.scrubLine(input), expected);
  const out = logMod.scrubLine('token=abc123 mopilot://pair?c=AAAA1111 1234 5678 9012 3456 7890 AbCdEfGhIjKlMnOpQrStUvWx12');
  assert.doesNotMatch(out, /abc123|AAAA1111|1234 5678|AbCdEf/);
  assert.equal(logMod.scrubLine('Mac is asleep'), 'Mac is asleep');
});

test('the ported redaction hides credential assignments in every shape', () => {
  const text = [
    '{"token":"abc","x":1}',
    "authorization: 'Bearer abc'",
    '{"credential":"unterminated',
    "deviceToken='unterminated",
    'resumeToken=plain',
    'https://h/p?token=zzz&a=1',
    'wss://user:pw@host/x',
  ].join('\n');
  const out = redactConnectionLogText(text);
  assert.doesNotMatch(out, /abc|unterminated|plain|zzz|user:pw/);
  assert.match(out, /\[redacted\]/);
  assert.deepEqual(
    redactConnectionLogEntry({
      message: 'token=a',
      detail: 'token=b',
      extra: 1,
    }),
    { message: 'token=[redacted]', detail: 'token=[redacted]', extra: 1 },
  );
  assert.deepEqual(redactConnectionLogEntry({ message: 'ok' }), {
    message: 'ok',
  });
});

test('elapsed time reads in tenths of a second up to ten, then seconds', () => {
  assert.equal(formatElapsed(1500, 1000), '+0.50s');
  assert.equal(formatElapsed(21_000, 1000), '+20.0s');
  assert.equal(formatElapsed(201_000, 1000), '+200s');
  assert.equal(formatElapsed(0, 1000), '+0.00s');
});

test('the words fill their blanks from the catalog, in both languages', async () => {
  assert.equal(t('check.host', { name: 'Box' }), 'Box is reachable');
  const { showLocale } = await import('../mobile/src/ui/i18n/index.ts');
  await showLocale('zh-Hans');
  assert.equal(t('check.host', { name: 'Box' }), 'Box 可连接');
  await showLocale('en');
});
