// A fake `ssh` executable for tests that drive the real ssh channel (electron/host/sshChannel.cjs): each machine is a home folder on this disk, and an `up` machine runs the command it is given in /bin/sh with that HOME, as a login on it would, with a banner on stderr. A machine that is down says what ssh says (255, "Connection refused"), one that denies the key says that, one that hangs never answers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Mode = 'up' | 'refused' | 'denied' | 'hang' | 'unknown-key';

/** What `mopilot-host uninstall` does on the fake machine: stops the service (the socket goes) and says what it did; a stopped Host has no socket to remove. */
const stub = (data: string) => `import fs from 'node:fs';
import path from 'node:path';
const home = process.env.HOME;
const data = ${JSON.stringify(data)};
if (process.argv[2] !== 'uninstall') process.exit(2);
const sock = path.join(data, 'host.sock');
if (fs.existsSync(sock)) fs.rmSync(sock);
console.log('No unit at ' + path.join(home, 'unit'));
`;

/** Where the Host keeps its data on the test's supplied platform, under `home`. */
export const dataDirOf = (home: string, platform: string) =>
  platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'mopilot-host')
    : path.join(home, '.local', 'share', 'mopilot-host');

/** Every file and link under `dir`, relative to it, sorted: what is still on a machine. */
export function listing(dir: string): string[] {
  const found: string[] = [];
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const file = path.join(at, entry.name);
      if (entry.isDirectory()) walk(file);
      else found.push(path.relative(dir, file));
    }
  };
  walk(dir);
  return found.sort();
}

/** What a paired Host leaves in `home` (a stopped Host has no `host.sock`), and what is never its own: lookalike siblings, another install's data dir, the person's other config. */
export function seedHost(home: string, { running, platform }: { running: boolean; platform: string }) {
  const put = (file: string, text = 'x') => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const data = dataDirOf(home, platform);
  put(path.join(home, '.mopilot-host', 'current', 'host', 'bin', 'mopilot-host.mjs'), stub(data));
  put(path.join(home, '.mopilot-host', 'current', 'host', 'package.json'), '{"type":"module"}');
  put(path.join(data, 'threads', 'a.jsonl'));
  if (running) put(path.join(data, 'host.sock'));
  put(path.join(home, '.config', 'mopilot-host', 'host-id'));
  // not the Host's: lookalikes, another install with its own data dir, the person's own files
  put(path.join(home, '.mopilot-host-keep', 'x'));
  put(path.join(home, '.config', 'other', 'keep'));
  put(path.join(home, '.local', 'share', 'mopilot-host-other', 'keep'));
  put(path.join(home, 'Library', 'Application Support', 'mopilot-host-other', 'keep'));
  put(path.join(home, 'second-install', 'config', 'host-id'));
  put(path.join(home, 'Documents', 'notes.txt'));
}

/** A set of fake machines behind one fake `ssh`: `sshBin` goes to createSshChannel. */
export function fakeSshMachines(platform: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ssh-machines-')));
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'machines.json');
  const logFile = path.join(root, 'ssh.log');
  fs.mkdirSync(bin);
  const sshBin = path.join(bin, 'ssh');
  fs.writeFileSync(
    sshBin,
    `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const at = args.indexOf('--');
const destination = args[at + 1];
const command = args.slice(at + 2).join(' ');
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ destination, command, args }) + '\\n');
const machine = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'))[destination];
if (!machine || machine.mode === 'refused') {
  process.stderr.write('ssh: connect to host ' + destination + ' port 22: Connection refused\\n');
  process.exit(255);
}
if (machine.mode === 'unknown-key' && args.includes('StrictHostKeyChecking=yes')) {
  process.stderr.write('Host key verification failed.\\n');
  process.exit(255);
}
if (machine.mode === 'denied') {
  process.stderr.write(destination + ': Permission denied (publickey).\\n');
  process.exit(255);
}
if (machine.mode === 'hang') setInterval(() => {}, 1000);
else {
  process.stderr.write("Warning: Permanently added '" + destination + "' (ED25519) to the list of known hosts.\\n");
  const env = { PATH: ${JSON.stringify(`${path.dirname(process.execPath)}:/usr/bin:/bin`)}, HOME: machine.home };
  const ran = spawnSync('/bin/sh', ['-c', command], { env, encoding: 'utf8' });
  process.stdout.write(ran.stdout);
  process.stderr.write(ran.stderr);
  process.exit(ran.status === null ? 255 : ran.status);
}
`,
    { mode: 0o755 },
  );
  const machines: Record<string, { mode: Mode; home: string }> = {};
  const save = () => fs.writeFileSync(state, JSON.stringify(machines));
  save();
  return {
    root,
    sshBin,
    /** Adds a machine whose login folder is `home` (made, with a Host in it, unless `bare`). */
    add(destination: string, { mode = 'up', running = true, bare = false }: { mode?: Mode; running?: boolean; bare?: boolean } = {}) {
      const home = path.join(root, `home-${destination.replace(/[^\w]/g, '_')}`);
      fs.mkdirSync(home, { recursive: true });
      if (!bare) seedHost(home, { running, platform });
      machines[destination] = { mode, home };
      save();
      return home;
    },
    /** Another login on the same machine: the same folder under another destination (an alias and an IP). */
    alias(destination: string, of: string) {
      machines[destination] = { ...machines[of] };
      save();
    },
    set(destination: string, mode: Mode) {
      machines[destination].mode = mode;
      save();
    },
    /** The commands ssh was asked to run, in order. */
    commands: (destination?: string) =>
      (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : [])
        .map((l) => JSON.parse(l) as { destination: string; command: string; args: string[] })
        .filter((c) => !destination || c.destination === destination),
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
