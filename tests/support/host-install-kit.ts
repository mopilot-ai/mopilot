// A fake SSH machine for the installer's tests (electron/host/install.cjs): answers by the command it is given, and models the service manager (which version the running Host was started from; `enable --now` leaves a running unit alone, `restart` and unload+load run `current`).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HOST_CLI } = require('../../electron/host/install.cjs');

export const status = {
  version: '0.0.1',
  running: true,
  socketPath: '/home/u/.local/share/mopilot-host/host.sock',
  harnesses: [{ id: 'claude', detected: true, signedIn: false }],
  capabilities: { iab: false, cu: false, bu: false, shell: false },
  platform: 'linux',
  startup: { atBoot: 'yes', fileVault: 'unknown' },
};
export const BYTES = Buffer.from('pretend this is the Host tarball');
export const SHA = createHash('sha256').update(BYTES).digest('hex');
export const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-bundle-'));
export const FILE = path.join(dir, 'host.tgz');
fs.writeFileSync(FILE, BYTES);
export const bundle = (build = 'linux-x64-gnu') => ({ file: FILE, sha256: SHA, version: '1.2.3', core: build });
export const CLI = HOST_CLI;

export type Reply = { code?: number; stdout?: string; stderr?: string } | Error | Promise<any>;
/** A machine that answers by the command it is given (the first default key the command contains; `script` replaces the answer for a key); `ran` is every command in order with the bytes sent to it. */
export function machine(script: Record<string, Reply | (() => Reply)> = {}) {
  const ran: { command: string; input?: Buffer }[] = [];
  /** The service manager: which version the running Host was started from (null: not running), and the version `current` points to. `enable --now` starts a stopped unit but leaves a running one alone; `restart` and `kickstart -k` run `current`. launchd as macOS 26+ does it over ssh: `bootstrap` (or `load`) registers the agent without starting it, `bootout` (or `unload`) stops it. */
  const service = { runningFrom: null as string | null, current: '' };
  const manage = (command: string) => {
    const link = /ln -sfn "[^"]*\/versions\/([0-9a-f]{64})" /.exec(command);
    if (link) service.current = link[1];
    for (const m of command.matchAll(/systemctl --user (enable --now|restart|disable --now)|launchctl (unload|bootout|kickstart -k)/g)) {
      const v = m[1] ?? m[2];
      if (v === 'restart' || v === 'kickstart -k') service.runningFrom = service.current;
      else if (v === 'enable --now') service.runningFrom ??= service.current;
      else service.runningFrom = null;
    }
  };
  const defaults: Record<string, Reply> = {
    // MoPilot's Node (electron/host/installRuntime.cjs): already on the machine unless a test says otherwise
    // what the Node set up says it needs (shared/host/coreBuild.mjs)
    'process.report': { stdout: 'linux-x64-gnu\n' },
    'echo have': { stdout: 'have\n' },
    'echo placed': { stdout: 'placed\n' },
    'curl -fsSL': { stdout: '' },
    '-lic': { stdout: 'v22.1.0\n' },
    'uname -sm': { stdout: 'Linux x86_64\n' },
    'test -f': { stdout: '' },
    'command -v': { stdout: '' },
    'node --version': { stdout: 'v22.4.0\n' },
    'cat >': { stdout: '' },
    sha256sum: { stdout: `${SHA}\n` },
    'tar -xzf': { stdout: 'made=yes prev=\n' },
    install: { stdout: 'Wrote /home/u/.config/systemd/user/mopilot-host.service\n' },
    'systemctl --user enable': { stdout: '' },
    'launchctl bootstrap': { stdout: '' },
    status: { stdout: JSON.stringify(status) },
    pair: { stdout: 'Pairing code: ABCD-EFGH-JKMN\n' },
    uninstall: { stdout: 'Removed unit' },
    'rm -f': { stdout: '' },
    'npm install': { stdout: 'added 1 package\n' },
    'trust-update-key': { stdout: 'Update key kept.\n' },
    // Linux: the user's systemd manager may linger without an administrator (electron/host/install.cjs LINGER_ON)
    'enable-linger': { stdout: 'turned-on\n' },
    '--print-daemon': {
      stdout: `${JSON.stringify({ user: 'me', home: '/Users/me', node: '/Users/me/n', bin: '/Users/me/b', dataDir: '/Users/me/d', path: '/usr/bin' })}\n`,
    },
    '/usr/bin/sudo': { stdout: 'turned-on\n' },
  };
  const channel = async (_dest: string, command: string, input?: Buffer) => {
    ran.push({ command, input });
    // the more specific word first: `uninstall` before `install`, `pair` and `status` before the rest
    const key = [
      // Keep running after restart (electron/host/daemonInstall.cjs): sudo's line carries the root script, which names launchctl
      '/usr/bin/sudo',
      '--print-daemon',
      'process.report',
      'echo have',
      'echo placed',
      'curl -fsSL',
      '-lic',
      'uninstall',
      'enable-linger',
      'uname -sm',
      'test -f',
      'command -v',
      'node --version',
      'cat >',
      'sha256sum',
      'tar -xzf',
      'npm install',
      'rm -f',
      'trust-update-key',
      'systemctl --user enable',
      'launchctl bootstrap',
      'pair',
      'status',
      'install',
    ].find((k) => command.includes(k));
    const raw = key === undefined ? { code: 127, stderr: 'not found' } : (script[key] ?? defaults[key]);
    const r = typeof raw === 'function' ? (raw as () => Reply)() : raw;
    if (r instanceof Error) throw r;
    const v: any = await r;
    if ((v.code ?? 0) === 0) manage(command);
    return { code: v.code ?? 0, stdout: v.stdout ?? '', stderr: v.stderr ?? '' };
  };
  return { ran, channel, service, commands: () => ran.map((r) => r.command) };
}
export const added: any[] = [];
export const registry = { add: (h: any) => void added.push(h) };
export const upto = (m: ReturnType<typeof machine>, word: string) => m.commands().find((c) => c.includes(word)) as string;
