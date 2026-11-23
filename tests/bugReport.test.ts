// electron/support/bugReport.cjs and electron/app/ipc/bug.cjs: the report a bug report saves locally or sends (scrubbed, cut to the
// server's size, main's own context), handed to the bug intake where the build has one and refused where it has none. The
// private intake's send is tested in tests/bugIntake.private.test.ts.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

mock.module('electron', {
  exports: { app: { getVersion: () => '9.9.9' }, crashReporter: { start: () => {}, setUploadToServer: () => {} } },
});
const require = createRequire(import.meta.url);
const B = require('../electron/support/bugReport.cjs');
const { register } = require('../electron/app/ipc/bug.cjs');
const { fingerprint } = require('../electron/support/telemetry.cjs');
const { noteIgnored, clearIgnored } = require('../electron/ignored.cjs');

const FP = 'a'.repeat(32);
const ctx = (o: Record<string, unknown> = {}) => ({
  installId: '11111111-1111-4111-8111-111111111111',
  appVersion: '1.2.3',
  os: 'macOS 25.0.0',
  arch: 'arm64',
  channel: 'beta',
  versions: { codex: '0.130.0', claude: '2.1.300', basic: { 'acp:kimi': '1.0' } },
  fingerprints: [FP],
  env: { signedIn: false },
  diagnostics: 'MoPilot 1.2.3',
  home: '/Users/alice',
  ...o,
});
const input = (o: Record<string, unknown> = {}) => ({
  kind: 'bug',
  description: 'It crashed',
  harness: 'codex',
  model: 'gpt-5',
  transcript: '# Chat',
  ...o,
});

beforeEach(() => clearIgnored());

test('capMiddle keeps the start and most of the end and says how much was cut, never half an emoji', () => {
  assert.equal(B.capMiddle('short', 10), 'short');
  const out = B.capMiddle(`${'a'.repeat(50)}${'b'.repeat(50)}`, 40);
  assert.equal(out, `${'a'.repeat(10)}\n\n[… 60 characters cut …]\n\n${'b'.repeat(30)}`);
  // 😀 is two UTF-16 units: a cut through it drops the half instead of keeping it
  const emoji = B.capMiddle('😀'.repeat(20), 10);
  assert.doesNotMatch(emoji, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
});

test('the report: the window’s fields scrubbed, validated and bounded, with main’s context', () => {
  const r = B.buildReport(
    input({
      description: '  key sk-ant-abcdefghijklmnopqrstuvwxyz in /Users/alice/proj  ',
      transcript: 'mail me@example.com, token=supersecretvalue',
      model: 'gpt-5 /Users/alice',
    }),
    ctx({ diagnostics: 'home /Users/alice/.codex', fingerprints: [FP, FP, 'not-a-hash', 'b'.repeat(32)] }),
  );
  assert.deepEqual(r, {
    installId: '11111111-1111-4111-8111-111111111111',
    kind: 'bug',
    description: 'key [REDACTED:anthropic-key] in ~/proj',
    appVersion: '1.2.3',
    os: 'macOS 25.0.0',
    arch: 'arm64',
    channel: 'beta',
    harness: 'codex',
    harnessVersion: '0.130.0',
    model: 'gpt-5 ~',
    env: { signedIn: false },
    diagnostics: 'home ~/.codex',
    transcript: 'mail <email>, token=[REDACTED:secret]',
    errorFingerprints: [FP, 'b'.repeat(32)],
  });
});

test('the report: defaults for what the window left out or got wrong, and the harness version by its kind', () => {
  const empty = B.buildReport(null, ctx());
  assert.deepEqual(
    [empty.kind, empty.description, empty.harness, empty.harnessVersion, empty.model, empty.transcript],
    ['bug', '', null, null, null, ''],
  );
  assert.equal(B.buildReport(input({ kind: 'good_result' }), ctx()).kind, 'bug');
  assert.equal(B.buildReport(input({ kind: 'bad_result' }), ctx()).kind, 'bad_result');
  assert.equal(B.buildReport(input({ kind: 7, description: 5, transcript: {} }), ctx()).kind, 'bug');
  const version = (harness: unknown, versions?: unknown) => B.buildReport(input({ harness }), ctx({ versions })).harnessVersion;
  assert.equal(version('claude', ctx().versions), '2.1.300');
  assert.equal(version('acp:kimi', ctx().versions), '1.0');
  assert.equal(version('acp:gemini', ctx().versions), null);
  // a name an object inherits is not a version
  assert.equal(version('constructor', ctx().versions), null);
  assert.equal(version('codex', null), null);
  assert.equal(version('codex', { codex: null }), null);
  assert.equal(B.buildReport(input({ harness: 'x'.repeat(500) }), ctx()).harness.length, 200);
  // the latest 50 distinct fingerprints
  const many = Array.from({ length: 60 }, (_, i) => i.toString(16).padStart(32, '0'));
  assert.deepEqual(B.buildReport(input(), ctx({ fingerprints: many })).errorFingerprints, many.slice(10));
});

test('a long transcript keeps its start and end; one that would not fit the body is cut further', () => {
  const long = `HEAD${'x'.repeat(B.MAX_TRANSCRIPT)}TAIL`;
  const r = B.buildReport(input({ transcript: long }), ctx());
  assert.ok(r.transcript.startsWith('HEAD') && r.transcript.endsWith('TAIL'));
  assert.match(r.transcript, /\[… \d+ characters cut …\]/);
  assert.ok(r.transcript.length < B.MAX_TRANSCRIPT + 100);
  // three UTF-8 bytes a unit: at full length the JSON is over 4 MB, so both texts are halved until it fits
  const wide = B.buildReport(input({ transcript: '中'.repeat(B.MAX_TRANSCRIPT) }), ctx({ diagnostics: '文'.repeat(B.MAX_DIAGNOSTICS) }));
  assert.ok(Buffer.byteLength(JSON.stringify(wide)) <= B.MAX_BODY);
  assert.ok(wide.transcript.length < B.MAX_TRANSCRIPT / 2 + 100 && wide.diagnostics.length < B.MAX_DIAGNOSTICS / 2 + 100);
  // a short text is never cut to make room
  const one = B.buildReport(input({ transcript: '中'.repeat(B.MAX_TRANSCRIPT) }), ctx());
  assert.equal(one.diagnostics, 'MoPilot 1.2.3');
  assert.ok(Buffer.byteLength(JSON.stringify(one)) <= B.MAX_BODY);
  // nothing left to cut: the report goes as it is and the server answers 413
  const env = { big: 'e'.repeat(B.MAX_BODY) };
  assert.equal(B.buildReport(input(), ctx({ env })).env, env);
});

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bugreport-'));
/** Telemetry as reportContext reads it: the private service's own context is tested in tests/telemetryEvents.private.test.ts. */
const fakeTelemetry = (o: { consent?: boolean; versions?: unknown; fingerprints?: string[] }) => ({
  consent: o.consent ?? false,
  reportContext: async () => ({
    channel: 'stable',
    versions: o.versions === undefined ? { codex: '0.130.0', claude: null, basic: {} } : o.versions,
    fingerprints: o.fingerprints ?? [],
  }),
});
function deps(
  o: { detect?: () => Promise<any>; consent?: boolean; signedIn?: boolean; api?: any; versions?: unknown; fingerprints?: string[] } = {},
) {
  const telemetry = fakeTelemetry(o);
  return {
    app: { getVersion: () => '4.5.6', getPath: () => userData },
    claude: { turnApi: { detect: mock.fn(o.detect ?? (async () => ({ bin: '/bin/claude' }))) } },
    readState: () => ({ prefs: { claudeBin: '/custom/claude' } }),
    findCodexBinary: async () => '/bin/codex',
    shellEnv: { status: () => ({ captured: true, error: null }), childEnv: () => ({ PATH: '/usr/bin', OPENAI_API_KEY: 'sk-x' }) },
    live: {
      telemetry,
      mopilot: { status: () => ({ signedIn: !!o.signedIn }), api: o.api ?? (async () => null) },
    },
  };
}

test('collectDiagnostics: one collector for Copy diagnostics and bug reports', async () => {
  const d = deps();
  const text = await B.collectDiagnostics(d);
  assert.match(text, /^MoPilot 4\.5\.6/);
  assert.match(text, /Codex: \/bin\/codex/);
  assert.match(text, /Claude Code: \/bin\/claude/);
  assert.match(text, /OPENAI_API_KEY=\[REDACTED:secret\]/);
  assert.deepEqual(d.claude.turnApi.detect.mock.calls[0].arguments, ['/custom/claude']);
  // capability health and native control go in when main has them
  assert.doesNotMatch(text, /Capability health|Native control/);
  const withHealth: any = deps();
  withHealth.live.capabilityHealth = { snapshot: () => ({ browser: 'ok' }) };
  withHealth.live.nativeAvailability = { snapshot: () => ({ helper: 'missing' }) };
  const t3 = await B.collectDiagnostics(withHealth);
  assert.match(t3, /Capability health\n\{\n {2}"browser": "ok"\n\}/);
  assert.match(t3, /Native control\n\{\n {2}"helper": "missing"\n\}/);
  // the last day's request log comes from the ledger main opened (live.ledger); there is none before it opens
  assert.doesNotMatch(text, /Request log/);
  withHealth.live.ledger = { store: { lastDay: async () => ['{"harness":"codex"}'] } };
  assert.match(await B.collectDiagnostics(withHealth), /Request log, last day \(1 lines\)/);
  // the app windows' recent problems (platform/windowRecovery.cjs) go in when main has them
  assert.doesNotMatch(text, /App window problems/);
  const R = require('../electron/platform/windowRecovery.cjs');
  R.clearWindowProblems();
  const wc = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, reload() {} });
  const recovery = R.createWindowRecovery({
    page: 'x',
    isDev: false,
    telemetry: () => null,
    quitting: () => false,
    now: () => 0,
    every: () => ({}),
  });
  recovery.attach({ webContents: wc, isDestroyed: () => false, loadFile: () => Promise.resolve() }, 'main');
  wc.emit('render-process-gone', {}, { reason: 'oom', exitCode: 5 });
  assert.match(
    await B.collectDiagnostics(withHealth),
    /App window problems \(last 1\)\n {2}1970-01-01T00:00:00\.000Z app window: renderer gone: oom \(5\)/,
  );
  // a failed lookup reads as not found, and its error is listed with the ignored ones
  const failed = deps({
    detect: async () => {
      throw new Error('no claude');
    },
  });
  failed.readState = () => ({}) as any;
  const t2 = await B.collectDiagnostics(failed);
  assert.match(t2, /Claude Code: not found/);
  assert.match(t2, /find Claude Code for the diagnostics: no claude/);
  assert.deepEqual(failed.claude.turnApi.detect.mock.calls[0].arguments, [undefined]);
});

test('IPC: bug:preview builds the report from main’s context; bug:submit builds it again and sends it', async () => {
  const handlers = new Map<string, (...a: any[]) => any>();
  const ipcMain = { handle: (ch: string, fn: any) => handlers.set(ch, fn) };
  const api = mock.fn(async (_pathname: string, _init: unknown) => null);
  // an error telemetry saw, without consent, and one ignored on purpose: both are named by fingerprint
  const d = deps({ signedIn: true, api, fingerprints: [fingerprint('boom', '')] });
  noteIgnored('read a file', new Error('denied'));
  const reports: any[] = [];
  const intake = {
    sendReport: mock.fn(async (report: any, o: { api: (p: string, i: RequestInit) => Promise<Response | null> }) => {
      reports.push(report);
      await o.api('/sent', { method: 'POST' });
      return { ok: true, id: 'r1', shortId: 'ABCD1234' };
    }),
  };
  register(ipcMain, d, intake);
  const preview = await handlers.get('bug:preview')!({}, input({ harness: 'codex' }));
  assert.equal(preview.installId.length, 36);
  assert.deepEqual(
    [preview.appVersion, preview.channel, preview.harnessVersion, preview.arch],
    ['4.5.6', 'stable', '0.130.0', process.arch],
  );
  assert.match(preview.os, new RegExp(`${os.release()}$`));
  assert.deepEqual(preview.errorFingerprints, [fingerprint('denied'), fingerprint('boom', '')]);
  // a full ring of ignored errors never pushes telemetry's out: those link to the admin portal's error groups
  for (let i = 0; i < 60; i++) noteIgnored(`step ${'x'.repeat(i)}`, new Error(`failed ${'y'.repeat(i)}`));
  const full = await handlers.get('bug:preview')!({}, input());
  assert.equal(full.errorFingerprints.length, 50);
  assert.equal(full.errorFingerprints.at(-1), fingerprint('boom', ''));
  assert.equal(preview.env.signedIn, true);
  assert.equal(preview.env.shellEnvCaptured, true);
  assert.equal(preview.env.shareUsageData, false);
  assert.equal(preview.env.node, process.versions.node);
  assert.match(preview.diagnostics, /^MoPilot 4\.5\.6/);
  // the window's copy of main's fields is ignored: main reads them again
  const out = await handlers.get('bug:submit')!({}, { ...input(), installId: 'forged', diagnostics: 'forged' });
  assert.deepEqual(out, { ok: true, id: 'r1', shortId: 'ABCD1234' });
  // the intake sends it on the account's api()
  assert.deepEqual(api.mock.calls[0].arguments, ['/sent', { method: 'POST' }]);
  assert.equal(reports[0].installId, preview.installId);
  assert.match(reports[0].diagnostics, /^MoPilot 4\.5\.6/);
});

test('IPC: diagnostics that fail to collect, or harness versions that fail to read, still leave a report', async () => {
  const handlers = new Map<string, (...a: any[]) => any>();
  // telemetry that could not read the harness versions answers none
  const d = deps({ versions: null });
  d.findCodexBinary = async () => {
    throw new Error('disk gone');
  };
  register({ handle: (ch: string, fn: any) => handlers.set(ch, fn) }, d);
  const r = await handlers.get('bug:preview')!({}, input());
  assert.equal(r.diagnostics, "Couldn't collect the diagnostics: disk gone");
  assert.equal(r.harnessVersion, null);
  const { recentIgnored } = require('../electron/ignored.cjs');
  const contexts = recentIgnored().map((e: any) => e.context);
  assert.ok(contexts.includes('collect the diagnostics for a bug report'));
});

test('IPC: a build without a bug intake refuses to send, saying to save the report instead', async () => {
  const handlers = new Map<string, (...a: any[]) => any>();
  register({ handle: (ch: string, fn: any) => handlers.set(ch, fn) }, deps(), null);
  const out = await handlers.get('bug:submit')!({}, input());
  assert.deepEqual(out, {
    ok: false,
    error: { kind: 'unavailable', message: 'This build sends no reports. Save the report to a file and attach it to an issue.' },
  });
  // saving still works: the preview is the report as a file holds it
  assert.equal((await handlers.get('bug:preview')!({}, input())).kind, 'bug');
});
