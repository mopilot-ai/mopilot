// Focused native optimistic send journey in a scratch iOS app on an isolated macOS runner.
// e2e-runner: release — the scratch native build is explicitly invoked with ci-cuj, not ordinary PR/main shards.
import { test, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync, readFileSync, cpSync, openSync, closeSync, rmSync } from 'node:fs';
import path from 'node:path';
import { phoneSendToolchain } from './fixtures/phone-send-toolchain.mjs';
import { phoneSendDiagnostics } from './fixtures/phone-send-diagnostics.mjs';
import { startPhoneSendMac } from './fixtures/phone-send-mac.mjs';
import { randomUUID } from 'node:crypto';
import { selectAppScheme } from '../../design/mobile-remote/spike/expo/appScheme.mjs';
import { selectSimulator } from '../../design/mobile-remote/spike/expo/simulatorSelection.mjs';
import { copiesIntoScratch, phoneImportsOutsideMobile } from '../../design/mobile-remote/spike/expo/projectCopy.mjs';

const root = path.resolve(__dirname, '../..');
const scratch = path.join(process.env.RUNNER_TEMP ?? root, `mopilot-phone-send-${randomUUID()}`);
const project = path.join(scratch, 'mobile');
const out = path.join(root, 'test-results/e2e/phone-native-send');
let nativeEnv: NodeJS.ProcessEnv = process.env;
const run = (bin: string, args: string[], cwd = root, timeout = 120_000) =>
  execFileSync(bin, args, { cwd, env: nativeEnv, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
async function logged(bin: string, args: string[], cwd: string, file: string, timeoutMs: number) {
  const fd = openSync(file, 'w');
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd,
        stdio: ['ignore', fd, fd],
        env: {
          ...nativeEnv,
          CI: '1',
          EXPO_NO_TELEMETRY: '1',
          MOPILOT_BUILD_PROFILE: 'development',
          MOPILOT_DEV_HOST: 'http://localhost:1',
        },
      });
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      }, timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        if (code === 0) return resolve();
        // Only compiler errors and explicitly marked fake-app UI trees; never dump build source or environment.
        const diagnostics = phoneSendDiagnostics(readFileSync(file, 'utf8'), { tail: signal !== null });
        reject(new Error(`${bin} failed (${code ?? signal}); log ${path.basename(file)}\n${diagnostics}`));
      });
    });
  } finally {
    closeSync(fd);
  }
}

test('phone sends render before start and send replies, replace records once, recover refusals, and show pictures end to end', async () => {
  test.setTimeout(80 * 60_000);
  test.skip(process.platform !== 'darwin', 'Requires macOS');
  test.skip(process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true', 'Requires an isolated GitHub runner');
  test.skip(test.info().config.shard !== null, 'Focused ci-cuj run only');
  nativeEnv = phoneSendToolchain({
    applications: readdirSync('/Applications'),
    active: process.env.DEVELOPER_DIR ?? run('xcode-select', ['-p']).trim(),
    env: process.env,
    probe: (env: NodeJS.ProcessEnv) => execFileSync('xcrun', ['swift', '--version'], { env, encoding: 'utf8', timeout: 30_000 }),
  });
  mkdirSync(out, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  let udid = '';
  let mac: Awaited<ReturnType<typeof startPhoneSendMac>> | undefined;
  try {
    cpSync(path.join(root, 'mobile'), project, {
      recursive: true,
      filter: (source) => copiesIntoScratch(path.join(root, 'mobile'), source),
    });
    cpSync(path.join(root, 'shared'), path.join(scratch, 'shared'), { recursive: true });
    for (const file of phoneImportsOutsideMobile(root)) {
      mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true });
      cpSync(path.join(root, file), path.join(scratch, file));
    }
    mac = await startPhoneSendMac();
    writeFileSync(
      path.join(project, 'native-check.tsx'),
      readFileSync(path.join(root, 'tests/e2e/fixtures/phone-send-native-entry.tsx'), 'utf8').replaceAll(
        '__NATIVE_SEND_ORIGIN__',
        mac.origin,
      ),
    );
    const swiftSource = path.join(scratch, 'PhoneSendUITests.swift');
    writeFileSync(
      swiftSource,
      readFileSync(path.join(root, 'tests/e2e/fixtures/PhoneSendUITests.swift'), 'utf8').replaceAll('__NATIVE_SEND_ORIGIN__', mac.origin),
    );
    const manifestPath = path.join(project, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.main = 'native-check.tsx';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const runtimes = JSON.parse(run('xcrun', ['simctl', 'list', 'runtimes', '-j'])).runtimes;
    const types = JSON.parse(run('xcrun', ['simctl', 'list', 'devicetypes', '-j'])).devicetypes;
    const devices = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'available', '-j'])).devices;
    const { runtime, device } = selectSimulator(runtimes, types, devices);
    await logged('npm', ['ci', '--no-audit', '--no-fund'], project, path.join(out, 'npm.log'), 10 * 60_000);
    await logged('npx', ['expo', 'prebuild', '--platform', 'ios', '--no-install'], project, path.join(out, 'prebuild.log'), 5 * 60_000);
    await logged('pod', ['install'], path.join(project, 'ios'), path.join(out, 'pods.log'), 10 * 60_000);
    const workspace = readdirSync(path.join(project, 'ios')).find((name) => name.endsWith('.xcworkspace'));
    expect(workspace, 'Expo must produce an Xcode workspace').toBeTruthy();
    const workspacePath = path.join(project, 'ios', workspace!);
    const list = JSON.parse(run('xcodebuild', ['-list', '-json', '-workspace', workspacePath], project));
    const scheme = selectAppScheme(readdirSync(path.join(project, 'ios')), list.workspace.schemes);
    const xcodeProject = readdirSync(path.join(project, 'ios')).find((name) => name.endsWith('.xcodeproj'));
    expect(xcodeProject).toBeTruthy();
    run('ruby', [
      path.join(root, 'tests/e2e/fixtures/phone-send-ui-target.rb'),
      path.join(project, 'ios', xcodeProject!),
      scheme,
      swiftSource,
    ]);
    udid = run('xcrun', ['simctl', 'create', `phone-send-${randomUUID()}`, device, runtime]).trim();
    run('xcrun', ['simctl', 'boot', udid]);
    run('xcrun', ['simctl', 'bootstatus', udid, '-b']);
    const common = [
      '-workspace',
      workspacePath,
      '-scheme',
      scheme,
      '-configuration',
      'Release',
      '-sdk',
      'iphonesimulator',
      '-destination',
      `platform=iOS Simulator,id=${udid}`,
      '-derivedDataPath',
      path.join(scratch, 'derived'),
    ];
    // Build and test run apart: the compile takes 20 to 35 minutes on a hosted runner, and one shared limit killed the test
    // that had just started (run 42532140779). Only the compile is slow, so it is built unoptimized, for arm64 alone (the
    // runner is Apple silicon; x86_64 as well doubled the compile).
    await logged(
      'xcodebuild',
      [
        ...common,
        '-resultBundlePath',
        path.join(out, 'PhoneSendBuild.xcresult'),
        'ARCHS=arm64',
        'ONLY_ACTIVE_ARCH=YES',
        'SWIFT_OPTIMIZATION_LEVEL=-Onone',
        'GCC_OPTIMIZATION_LEVEL=0',
        'CODE_SIGNING_ALLOWED=YES',
        'CODE_SIGN_IDENTITY=-',
        'build-for-testing',
      ],
      project,
      path.join(out, 'native-build.log'),
      45 * 60_000,
    );
    await logged(
      'xcodebuild',
      [
        ...common,
        '-resultBundlePath',
        path.join(out, 'PhoneSend.xcresult'),
        '-parallel-testing-enabled',
        'NO',
        '-only-testing:PhoneSendUITests',
        // a hung test fails in minutes with its step trace
        '-test-timeouts-enabled',
        'YES',
        '-default-test-execution-time-allowance',
        '180',
        '-maximum-test-execution-time-allowance',
        '300',
        'test-without-building',
      ],
      project,
      path.join(out, 'native-ui.log'),
      25 * 60_000,
    );
    const log = readFileSync(path.join(out, 'native-ui.log'), 'utf8');
    expect(log).toContain('testPendingStartWarningAndRecords');
    expect(log).toContain('testRefusalRestoresDraftAndRetryId');
    expect(log).toContain('testLocalPictureOnlySendShowsOnePictureAndOpensViewer');
    expect(log).toContain('testHostPictureOnlyStartUploadsAndShowsOnePicture');
    expect(log).toContain('testLegacyHostPictureStartFailsVisiblyAndKeepsAttachment');
    expect(log).toContain('Executed 5 tests, with 0 failures');
  } finally {
    try {
      if (udid) {
        try {
          run('xcrun', ['simctl', 'io', udid, 'screenshot', path.join(out, 'final.png')]);
        } catch {
          /* runner may have stopped */
        }
        try {
          run('xcrun', ['simctl', 'shutdown', udid]);
        } catch {
          /* already stopped */
        }
        run('xcrun', ['simctl', 'delete', udid]);
      }
    } finally {
      try {
        if (mac) await mac.close();
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  }
});
