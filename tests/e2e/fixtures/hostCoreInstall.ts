// The Host with its Rust core put on a CI runner by the app's own installer, over real ssh to itself: the addon built for this machine, then scripts/host-accept.mjs (Add a machine's steps, a fake-agent chat, a hard kill, an update). Runners only: it turns on sshd and writes to the user's shell files.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';

export const ROOT = path.resolve(__dirname, '../../..');
/** Where the addons go: the release's folder, which electron/host/bundle.cjs reads in a checkout. */
export const CORES = path.join(ROOT, 'build', 'vendor', 'host-core');

const sh = (command: string) => execFileSync('sh', ['-c', command], { cwd: ROOT, stdio: 'inherit' });

/** Build this repository's addon for `build`. */
export function buildCore(build: string) {
  execFileSync(process.execPath, ['scripts/build-core.mjs', '--host', build, '--out', CORES], { cwd: ROOT, stdio: 'inherit' });
}

/** How many routes the addon built for `build` lists under Electron's own Node: Electron as a plain Node, no app and no window, for the Node-API promise that one file serves both. */
export function routesUnderElectron(build: string) {
  const addon = path.join(CORES, build, 'mopilot_core.node');
  const electron = createRequire(__filename)('electron') as unknown as string;
  const script = `const m={exports:{}};process.dlopen(m,${JSON.stringify(addon)});console.log(process.versions.electron+" "+m.exports.routes().length)`;
  const run = spawnSync(electron, ['-e', script], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  expect(run.status, run.stderr).toBe(0);
  const answer = /^(\S+) (\d+)$/m.exec(run.stdout);
  expect(answer, `Electron said: ${JSON.stringify(run.stdout)} ${JSON.stringify(run.stderr)}`).not.toBeNull();
  return Number(answer?.[2]);
}

/** Sign this user in to this machine's sshd with a fresh key, with the run's Node on the ssh shell's PATH (the acceptance run's fake agent uses it). */
function sshToSelf() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-core-ssh-'));
  const key = path.join(dir, 'key');
  sh(`ssh-keygen -q -t ed25519 -N '' -f '${key}'`);
  const home = os.homedir();
  sh(
    `mkdir -p '${home}/.ssh' && chmod 700 '${home}/.ssh' && cat '${key}.pub' >> '${home}/.ssh/authorized_keys' && chmod 600 '${home}/.ssh/authorized_keys'`,
  );
  const line = `export PATH="${path.dirname(process.execPath)}:$PATH"\n`;
  // first: Ubuntu's .bashrc returns at once for a shell like ssh's
  for (const rc of ['.zshenv', '.bashrc']) {
    const file = path.join(home, rc);
    fs.writeFileSync(file, line + (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''));
  }
  sh(process.platform === 'darwin' ? 'sudo launchctl load -w /System/Library/LaunchDaemons/ssh.plist' : 'sudo systemctl start ssh');
  return key;
}

/** Run the acceptance run on this machine and keep its report with the run's results; the core must have loaded, `routes()` answering. @param {string} build */
export function installAndCheck(build: string) {
  const key = sshToSelf();
  const report = path.join(ROOT, 'test-results', 'e2e', `host-accept-${build}.md`);
  fs.mkdirSync(path.dirname(report), { recursive: true });
  const args = ['-i', key, '-o', 'StrictHostKeyChecking=accept-new'].flatMap((a) => ['--ssh-arg', a]);
  const run = spawnSync(
    process.execPath,
    ['scripts/host-accept.mjs', '--ssh', `${os.userInfo().username}@localhost`, ...args, '--out', report],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 15 * 60_000,
    },
  );
  // kept for this: what the Host said, for a step that failed. The runner goes with the run
  const log =
    process.platform === 'darwin'
      ? `cat "$HOME/Library/Application Support/mopilot-host/host.log"`
      : 'journalctl --user -u mopilot-host --no-pager -n 400';
  fs.writeFileSync(report.replace(/\.md$/, '.log'), spawnSync('sh', ['-c', log], { encoding: 'utf8' }).stdout ?? '');
  const text = fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : `${run.stdout}\n${run.stderr}`;
  expect(text, 'the installer put the Host there').toMatch(/\| A3 [^|]*\| PASS \|/);
  expect(text, 'the Host loaded its core and routes() answered').toMatch(
    new RegExp(`\\| A4 [^|]*\\| PASS \\|[^|]*\\| [^|]*core ${build}, \\d+ routes`),
  );
  expect(text, 'the same build went through a signed update and loaded').toMatch(
    new RegExp(`\\| A8 [^|]*\\| PASS \\|[^|]*\\| [^|]*with its ${build} core`),
  );
}
