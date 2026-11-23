// Isolated iOS simulator check of native vault persistence and pair-scoped relay routing across process restart.
// e2e-runner: release — its npm ci, pod install and Xcode build take about 13 minutes: it runs only before an official
// phone app release (.github/release-repo/mobile-release-checks.yml), never in the pull request check or main-e2e
import { test, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync, readFileSync, cpSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { selectAppScheme } from '../../design/mobile-remote/spike/expo/appScheme.mjs';
import { selectSimulator } from '../../design/mobile-remote/spike/expo/simulatorSelection.mjs';
import { launchWithDeadline } from '../../design/mobile-remote/spike/expo/simulatorLaunch.mjs';
import { copiesIntoScratch, phoneImportsOutsideMobile } from '../../design/mobile-remote/spike/expo/projectCopy.mjs';
import { simulatorBuildArgs } from '../../scripts/mobile-ios-build.mjs';

const root = path.resolve(__dirname, '../..');
const scratch = path.join(process.env.RUNNER_TEMP ?? root, `mopilot-vault-${randomUUID()}`);
const project = path.join(scratch, 'mobile');
const out = path.join(root, 'test-results/e2e/mobile-native-vault');
const run = (bin: string, args: string[], cwd = root, timeout = 120_000) =>
  execFileSync(bin, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
async function logged(bin: string, args: string[], cwd: string, file: string, timeoutMs: number) {
  const fd = openSync(file, 'w');
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, { cwd, stdio: ['ignore', fd, fd], env: { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1' } });
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        // the compiler's own error lines only, no source or environment: the workflow's log is public and it keeps no artifact
        const errors = readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => /(^|\s)error: /.test(line))
          .slice(0, 20);
        reject(new Error(`${bin} failed (${code ?? signal}); log ${path.basename(file)}\n${errors.join('\n')}`));
      });
    });
  } finally {
    closeSync(fd);
  }
}

test('real iOS vault and key survive process restart', async () => {
  test.setTimeout(70 * 60_000);
  test.skip(process.platform !== 'darwin', 'Requires macOS');
  test.skip(process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true', 'Requires an isolated GitHub runner');
  // a simulator build and two launches outlast an e2e shard's 25 minutes: it runs alone, before a phone app release
  // (.github/release-repo/mobile-release-checks.yml), or by hand through ci-cuj (mobile/README.md)
  test.skip(test.info().config.shard !== null, 'Runs alone: node scripts/ci-cuj.mjs --spec tests/e2e/mobile-native-vault.spec.ts');
  mkdirSync(out, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  cpSync(path.join(root, 'mobile'), project, {
    recursive: true,
    filter: (source) => copiesIntoScratch(path.join(root, 'mobile'), source),
  });
  cpSync(path.join(root, 'shared'), path.join(scratch, 'shared'), { recursive: true });
  for (const file of phoneImportsOutsideMobile(root)) {
    mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true });
    cpSync(path.join(root, file), path.join(scratch, file));
  }
  cpSync(path.join(root, 'tests/e2e/fixtures/mobile-native-vault-entry.tsx'), path.join(project, 'native-check.tsx'));
  const manifestPath = path.join(project, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.main = 'native-check.tsx';
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  run('xcodebuild', ['-version']);
  run('pod', ['--version']);
  const runtimes = JSON.parse(run('xcrun', ['simctl', 'list', 'runtimes', '-j'])).runtimes;
  const types = JSON.parse(run('xcrun', ['simctl', 'list', 'devicetypes', '-j'])).devicetypes;
  const devices = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'available', '-j'])).devices;
  writeFileSync(path.join(out, 'simulator-environment.json'), JSON.stringify({ runtimes, types, devices }, null, 2));
  const { runtime, device } = selectSimulator(runtimes, types, devices);
  let udid = '';
  let logger: ReturnType<typeof spawn> | undefined;
  let logFd: number | undefined;
  let executable = '';
  try {
    await logged('npm', ['ci', '--no-audit', '--no-fund'], project, path.join(out, 'npm.log'), 10 * 60_000);
    await logged('npx', ['expo', 'prebuild', '--platform', 'ios', '--no-install'], project, path.join(out, 'prebuild.log'), 5 * 60_000);
    await logged('pod', ['install'], path.join(project, 'ios'), path.join(out, 'pods.log'), 15 * 60_000);
    const workspace = readdirSync(path.join(project, 'ios')).find((name) => name.endsWith('.xcworkspace'));
    expect(workspace, 'Expo prebuild must create an Xcode workspace').toBeTruthy();
    const workspacePath = path.join(project, 'ios', workspace!);
    const list = JSON.parse(run('xcodebuild', ['-list', '-json', '-workspace', workspacePath], project));
    const scheme = selectAppScheme(readdirSync(path.join(project, 'ios')), list.workspace.schemes);
    const derived = path.join(process.env.RUNNER_TEMP!, `mopilot-native-derived-${randomUUID()}`);
    await logged(
      'xcodebuild',
      simulatorBuildArgs({ workspace: workspacePath, scheme, derived }),
      project,
      path.join(out, 'build.log'),
      30 * 60_000,
    );
    const products = path.join(derived, 'Build/Products/Release-iphonesimulator');
    const app = readdirSync(products).find((name) => name.endsWith('.app'));
    expect(app, 'the simulator build must produce an app').toBeTruthy();
    executable = run('plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(products, app!, 'Info.plist')]).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(executable)) throw new Error('invalid app executable name');
    const bundleId = run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(products, app!, 'Info.plist')]).trim();
    if (!/^[A-Za-z0-9.-]+$/.test(bundleId)) throw new Error('invalid bundle identifier');
    // Xcode generates simulator entitlements during linking as well as signing; a later host codesign cannot replace it.
    const appPath = path.join(products, app!);
    run('codesign', ['--verify', '--strict', appPath]);
    writeFileSync(
      path.join(out, 'simulator-entitlements.txt'),
      run('xcrun', ['otool', '-s', '__TEXT', '__entitlements', path.join(appPath, executable)]),
    );
    udid = run('xcrun', ['simctl', 'create', `mopilot-native-${randomUUID()}`, device, runtime]).trim();
    run('xcrun', ['simctl', 'boot', udid]);
    run('xcrun', ['simctl', 'bootstatus', udid, '-b']);
    run('xcrun', ['simctl', 'install', udid, appPath]);
    logFd = openSync(path.join(out, 'simulator.log'), 'w');
    logger = spawn('xcrun', ['simctl', 'spawn', udid, 'log', 'stream', '--style', 'compact', '--predicate', `process == "${executable}"`], {
      stdio: ['ignore', logFd, logFd],
    });
    logger.on('error', (error) => writeFileSync(path.join(out, 'logger-error.txt'), String(error)));
    const swift = path.join(out, 'ocr.swift');
    writeFileSync(
      swift,
      `import AppKit\nimport Vision\nimport Foundation\nlet image = NSImage(contentsOfFile: CommandLine.arguments[1])!\nvar rect = CGRect(origin: .zero, size: image.size)\nlet cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil)!\nlet request = VNRecognizeTextRequest()\nrequest.recognitionLevel = .accurate\ntry VNImageRequestHandler(cgImage: cg).perform([request])\nfor item in request.results ?? [] { if let text = item.topCandidates(1).first?.string { print(text) } }\n`,
    );
    for (const phase of ['FIRST', 'SECOND']) {
      const launchFd = openSync(path.join(out, `launch-${phase.toLowerCase()}.log`), 'w');
      try {
        const launched = await launchWithDeadline(
          () => spawn('xcrun', ['simctl', 'launch', udid, bundleId], { stdio: ['ignore', launchFd, launchFd] }),
          120_000,
        );
        writeFileSync(path.join(out, `launch-${phase.toLowerCase()}.json`), JSON.stringify({ executable, ...launched }, null, 2));
        expect(launched, `${phase} launch must complete successfully`).toMatchObject({ status: 'returned', code: 0 });
      } finally {
        closeSync(launchFd);
      }
      const screenshot = path.join(out, `simulator-${phase.toLowerCase()}.png`);
      let observed = '';
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        run('xcrun', ['simctl', 'io', udid, 'screenshot', screenshot]);
        observed = run('swift', [swift, screenshot]);
        if (
          /MOBILE\s+VAULT\s+FAIL/i.test(observed) ||
          (new RegExp(`MOBILE\\s+VAULT\\s+${phase}\\s+PASS`, 'i').test(observed) &&
            /MOBILE\s+ROUTING\s+PASS/i.test(observed) &&
            /MoPilot\s+Remote/i.test(observed) &&
            /Sign\s+in/i.test(observed))
        )
          break;
      }
      writeFileSync(path.join(out, `observed-${phase.toLowerCase()}.txt`), observed);
      expect(observed, `${phase} launch must visibly pass`).toMatch(new RegExp(`MOBILE\\s+VAULT\\s+${phase}\\s+PASS`, 'i'));
      expect(observed, `${phase} launch must exercise production pair routing`).toMatch(/MOBILE\s+ROUTING\s+PASS/i);
      expect(observed, `${phase} launch must show the production app`).toMatch(/MoPilot\s+Remote/i);
      expect(observed, `${phase} launch must reach sign in`).toMatch(/Sign\s+in/i);
      run('xcrun', ['simctl', 'terminate', udid, bundleId]);
    }
  } finally {
    if (udid && executable) {
      for (const [file, args] of [
        ['processes.txt', ['simctl', 'spawn', udid, 'launchctl', 'list']],
        ['process-table.txt', ['simctl', 'spawn', udid, 'ps', '-A', '-o', 'pid,comm']],
        [
          'system.log',
          [
            'simctl',
            'spawn',
            udid,
            'log',
            'show',
            '--last',
            '5m',
            '--style',
            'compact',
            '--predicate',
            `process == "${executable}" OR process == "SpringBoard" OR process == "runningboardd" OR process == "launchd_sim" OR process == "securityd"`,
          ],
        ],
      ] as const) {
        try {
          writeFileSync(path.join(out, file), run('xcrun', [...args], root, 15_000));
        } catch (error) {
          writeFileSync(path.join(out, `${file}.error`), String(error));
        }
      }
      try {
        run('xcrun', ['simctl', 'io', udid, 'screenshot', path.join(out, 'final-simulator.png')], root, 15_000);
      } catch (error) {
        writeFileSync(path.join(out, 'screenshot.error'), String(error));
      }
    }
    logger?.kill('SIGTERM');
    if (logFd !== undefined) closeSync(logFd);
    if (udid) {
      try {
        run('xcrun', ['simctl', 'shutdown', udid]);
      } catch {
        /* already stopped */
      }
      run('xcrun', ['simctl', 'delete', udid]);
    }
  }
});
