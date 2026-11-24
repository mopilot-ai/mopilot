// electron/capabilities/computer.cjs and scripts/build-helper.mjs: launch arguments, framing, the helper's
// Info.plist, and (on a Mac with Swift) a real build + launch + permission status over the socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import edition from '../shared/edition.json' with { type: 'json' };
import { startFakeHelper } from './e2e/fixtures/fake-helper.ts';
import { connectSocket } from './support/connectSocket.ts';
import { helperInfo, plist, defaultPeerRequirement, buildHelper } from '../scripts/build-helper.mjs';

const require = createRequire(import.meta.url);
const { helperAppPath, launchArgs, lineDecoder, ComputerHelper } = require('../electron/capabilities/computer.cjs');
const { HELPER_BUNDLE_ID, withFloor } = require('../electron/capabilities/computerContract.cjs');

test('helper path: Contents/Helpers when packaged, native/helper/build in a checkout', () => {
  assert.equal(
    helperAppPath({ packaged: true, resourcesPath: '/Applications/MoPilot.app/Contents/Resources' }),
    '/Applications/MoPilot.app/Contents/Helpers/MoPilot.app',
  );
  assert.equal(helperAppPath({ repoRoot: '/repo' }), '/repo/native/helper/build/MoPilot.app');
});

test('launched as a new background instance through LaunchServices, token not in argv', () => {
  assert.deepEqual(launchArgs('/x/H.app', '/tmp/d/launch.json'), [
    '-n',
    '-g',
    '-a',
    '/x/H.app',
    '--args',
    '--launch',
    '/tmp/d/launch.json',
  ]);
});

test('line decoder handles split and joined chunks and skips bad lines', () => {
  const got: unknown[] = [];
  const errs: unknown[] = [];
  const feed = lineDecoder(
    (m: unknown) => got.push(m),
    (e: unknown) => errs.push(e),
  );
  feed('{"id":1,"res');
  feed('ult":2}\n{"id":2}\n\nnot json\n{"id"');
  feed(':3}\n');
  assert.deepEqual(got, [{ id: 1, result: 2 }, { id: 2 }, { id: 3 }]);
  assert.equal(errs.length, 1);
});

test('the helper Info.plist uses the bundle id main reports and the requested peer requirement', () => {
  const info = helperInfo({ version: '1.2.3', build: '45' });
  assert.equal(info.LSUIElement, true);
  assert.equal(info.CFBundleIdentifier, `${edition.desktop.appId}.computer-use`);
  assert.equal(info.CFBundleIdentifier, HELPER_BUNDLE_ID);
  assert.equal(info.CFBundleName, 'MoPilot');
  // macOS keeps grants by bundle id and signing requirement, so only what it shows is renamed (#2528)
  assert.equal(info.CFBundleDisplayName, 'MoPilot');
  assert.ok(info.NSAppleEventsUsageDescription);
  assert.ok(info.NSSpeechRecognitionUsageDescription);
  // MoMo's Calendar and Reminders sources: EventKit's full-access prompts need their own texts
  for (const k of ['NSCalendarsFullAccessUsageDescription', 'NSRemindersFullAccessUsageDescription']) assert.match(String(info[k]), /MoMo/);
  assert.equal('MPCPeerRequirement' in info, false);
  assert.equal(helperInfo({ version: '1', build: '1', peerRequirement: 'anchor apple' }).MPCPeerRequirement, 'anchor apple');
  // a dev build marks itself; a build with a peer requirement never does
  assert.equal(helperInfo({ version: '1', build: '1', devBuild: true }).MPCDevBuild, true);
  assert.equal(helperInfo({ version: '1', build: '1', devBuild: true, peerRequirement: 'anchor apple' }).MPCDevBuild, undefined);
  assert.equal(helperInfo({ version: '1', build: '1' }).MPCDevBuild, undefined);
  assert.equal(defaultPeerRequirement('Apple Development: A B (29RC33CGL6)'), undefined);
  const xml = plist({ A: 'x<y', B: true });
  assert.match(xml, /<key>A<\/key>\n\t<string>x&lt;y<\/string>/);
  assert.match(xml, /<key>B<\/key>\n\t<true\/>/);
});

test('release peer requirement pins MoPilot under the signing team', () => {
  assert.equal(
    defaultPeerRequirement('Developer ID Application: MoPilot Inc (AB12CD34EF)'),
    `anchor apple generic and identifier "${edition.desktop.appId}" and certificate leaf[subject.OU] = "AB12CD34EF"`,
  );
  assert.equal(defaultPeerRequirement(''), undefined);
  assert.equal(defaultPeerRequirement('-'), undefined);
});

// The real helper: built with swift, launched with `open`. Opt-in only (MOPILOT_HELPER_TEST=1): every launch makes
// macOS show a Screen Recording / "bypass the system private window picker" prompt on the developer's machine, and
// a normal `npm test` (often several at once) must never do that.
const hasSwift = process.platform === 'darwin' && spawnSync('swift', ['--version'], { stdio: 'ignore' }).status === 0;
const skip = !hasSwift
  ? 'needs macOS with swift'
  : !process.env.MOPILOT_HELPER_TEST
    ? 'set MOPILOT_HELPER_TEST=1 to launch the real helper (shows macOS permission prompts)'
    : false;

test('real helper: launches, answers permission status, refuses input without control', { skip, timeout: 600_000 }, async (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mpcu-build-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const appPath = buildHelper({ out, log: () => {} });

  const helper = new ComputerHelper({ appPath });
  t.after(() => helper.stop());
  const hello = await helper.start();
  assert.equal(hello.bundleId, `${edition.desktop.appId}.computer-use`);
  assert.ok(hello.pid > 0 && hello.pid !== process.pid);

  const status = await helper.permissionStatus();
  assert.deepEqual(Object.keys(status).sort(), ['accessibility', 'inputMonitoring', 'screenRecording']);
  for (const v of Object.values(status)) assert.equal(typeof v, 'boolean');

  // Input needs Accessibility and then control of the desktop; neither is given here.
  await assert.rejects(helper.click(10, 10), (e: any) => ['permission_denied', 'not_controlling'].includes(e.reason));
  if (!status.screenRecording) {
    await assert.rejects(helper.screenshot(), (e: any) => e.reason === 'permission_denied');
  } else {
    const shot = await helper.screenshot();
    assert.ok(Math.max(shot.width, shot.height) <= 2000);
    assert.equal(Buffer.from(shot.png, 'base64').subarray(1, 4).toString(), 'PNG');
  }
  await assert.rejects(helper.call('no.such.method'), (e: any) => e.reason === 'method_not_found');

  // The helper exits when main disconnects.
  helper.stop();
  const alive = () => {
    try {
      process.kill(hello.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + 5000;
  while (alive()) {
    assert.ok(Date.now() < deadline, 'helper still running after disconnect');
    await new Promise((r) => setTimeout(r, 100));
  }
});

test('real helper: a connection from a pid other than the registered one is closed', { skip, timeout: 600_000 }, async (t) => {
  const appPath = helperAppPath();
  if (!fs.existsSync(appPath)) buildHelper({ log: () => {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpcu-'));
  const socket = path.join(dir, 'h.sock');
  const config = path.join(dir, 'launch.json');
  t.after(() => {
    spawnSync('pkill', ['-f', config]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // Register the parent (a live pid that isn't us): this process must be turned away.
  fs.writeFileSync(config, JSON.stringify({ socket, token: 'b'.repeat(64), mainPid: process.ppid }), { mode: 0o600 });
  execFileSync('/usr/bin/open', launchArgs(appPath, config));
  const s = await connectSocket(socket, 'the helper to accept a peer connection', { timeoutMs: 15_000 });
  t.after(() => s.destroy());
  const reply = await new Promise<string>((resolve) => {
    let data = '';
    s.setEncoding('utf8');
    s.on('data', (d) => (data += d));
    s.on('error', () => {});
    s.on('close', () => resolve(data));
    s.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: { token: 'b'.repeat(64) } })}\n`);
  });
  assert.equal(reply, '');
  assert.equal(fs.existsSync(config), false, 'the launch config is deleted once read');
});

test('ocrElements asks for ocr.elements and passes the options through', async () => {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-')), 'h.sock');
  const fake = await startFakeHelper(sock);
  const helper = new ComputerHelper({ connectTo: sock });
  try {
    await helper.start();
    const r = await helper.ocrElements({ pid: 4242, bundleIds: ['com.apple.Notes'] });
    assert.deepEqual(fake.log.at(-1), { method: 'ocr.elements', params: { pid: 4242, bundleIds: ['com.apple.Notes'] } });
    assert.deepEqual(
      r.elements.map((e: any) => e.source),
      ['ax', 'ocr'],
    );
    assert.equal(r.elements[1].text, 'Hello world');
    await helper.setDeny(['com.example.bank']);
    assert.deepEqual(fake.log.at(-1), { method: 'deny.set', params: { bundleIds: withFloor(['com.example.bank']) } });
  } finally {
    helper.stop();
    await fake.close();
  }
});

test('tray tooltip names the chat that holds the desktop lock', () => {
  const { trayTooltip } = require('../electron/capabilities/computerUse.cjs');
  assert.equal(trayTooltip('Fix the build'), 'Using your computer · Fix the build');
  assert.equal(trayTooltip(null), 'Using your computer');
});

test('a helper error names the missing permission for the in-chat guide card', () => {
  const { missingPermission, helperError } = require('../electron/capabilities/tools/computer.cjs');
  assert.equal(missingPermission({ reason: 'permission_denied', message: 'screenRecording permission not granted' }), 'screenRecording');
  assert.equal(missingPermission({ reason: 'guard_unavailable', message: 'x' }), 'accessibility');
  assert.equal(missingPermission({ reason: 'aborted', message: 'accessibility' }), null);
  assert.equal(helperError({ reason: 'permission_denied', message: 'accessibility permission not granted' }).permission, 'accessibility');
});
