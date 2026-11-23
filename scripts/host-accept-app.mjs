// The acceptance run for the app's side of a remote Host: the app's own machine list, ssh tunnel, remote connection and outbox (electron/host/*.cjs, plain CommonJS) driven from Node, with no Electron, against a Tart VM over real ssh.
//   node scripts/host-accept-app.mjs --vm mopilot-work [--out report.md]      hold the VM's lock first: VMLOCK_VM=<vm> ~/bench/runner/vmlock.sh
//   node scripts/host-accept-app.mjs --ssh mac-mini-test [--out report.md]     a physical machine: its ssh alias or user@host; the scratch key is authorized and removed over that same ssh
// The VM is reached with `tart exec` (scripts/vm-exec.sh) only to authorize a scratch ssh key for this run; everything the app does goes over ssh to that key.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createChannel, sshLauncher, vmLauncher } from './host-accept/channel.mjs';
import { exitCode, formatReport } from './host-accept/report.mjs';
import { fixtureClosure, runSteps, throwawayKeySafe } from './host-accept.mjs';
import { assertVmName } from '../shared/vmName.mjs';
import { STEPS, cleanup } from './host-accept-app/steps.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What this run cannot show, on top of what the machine-side run lists. */
export const NOT_VERIFIED = Object.freeze([
  'Real Claude Code and Codex logins and turns (the user’s accounts)',
  'The app’s windows: this drives the same modules from Node, so no renderer, IPC or Electron is involved',
  'The tool relay and the browser pane (host-2-6’s run, #2718)',
  'A Linux machine',
]);

/** @param {string[]} argv */
export function parseArgs(argv) {
  const o = { vm: '', ssh: '', out: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--vm') o.vm = argv[++i];
    else if (argv[i] === '--ssh') o.ssh = argv[++i];
    else if (argv[i] === '--out') o.out = argv[++i];
    else throw new Error(`Unknown option ${argv[i]}`);
  }
  if (Boolean(o.vm) === Boolean(o.ssh)) throw new Error('Name the machine with exactly one of --vm <mopilot-*> or --ssh <destination>.');
  return o;
}

/** The app's pieces and the machine-side helpers the steps use. */
/** @param {{ ssh?: string }} [o] `ssh`: the machine is a real one named by an ssh destination, not a Tart VM */
export function realDeps(o = {}) {
  const { createMachines } = require('../electron/host/machines.cjs');
  const { createSshChannel } = require('../electron/host/install.cjs');
  const { createTunnelPool } = require('../electron/host/sshTunnel.cjs');
  const { createRemoteSend } = require('../electron/host/remoteSend.cjs');
  const { createOutbox } = require('../electron/host/outbox.cjs');
  const { OwnershipStore } = require('../electron/host/ownership.cjs');
  const gate = { allowed: () => true, watch: () => () => undefined };
  return {
    readFile: (/** @type {string} */ file) => fs.readFileSync(file),
    agentFiles: () =>
      fixtureClosure('tests/fixtures/fake-acp-agent.mjs').map((rel) => ({ rel, data: fs.readFileSync(path.join(ROOT, rel)) })),
    /** The address the app's own ssh reaches: a VM's from tart, a physical machine's from what ssh resolves its alias to. @param {string} target */
    tartIp: (target) =>
      o.ssh
        ? (execFileSync('ssh', ['-G', target], { encoding: 'utf8' }).match(/^hostname (.+)$/m)?.[1] ?? target)
        : execFileSync('tart', ['ip', assertVmName(target)], { encoding: 'utf8' }).trim(),
    keygen: (/** @type {string} */ file) => execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file]),
    ssh: (/** @type {string[]} */ args, /** @type {string} */ dest, /** @type {string} */ command) =>
      execFileSync('ssh', [...args, '-o', 'BatchMode=yes', dest, command], { encoding: 'utf8', timeout: 30_000 }),
    /** The app's machine list over a real ssh tunnel pool; the pool is watched so a step can see each tunnel's socket. @param {any} ctx */
    makeMachines(ctx) {
      // the run's scratch key and known-hosts file are the pool's default ssh options; a machine's own key adds to them (createTunnelPool)
      const sshArgs = ctx.state.sshArgs;
      const pool = createTunnelPool({ dir: path.join(ctx.dir, 'host-tunnels'), sshArgs, ...gate });
      /** @type {{ localSocket: string }[]} */
      const tunnels = [];
      const get = pool.get.bind(pool);
      pool.get = (/** @type {any} */ target) => {
        const t = get(target);
        if (!tunnels.includes(t)) tunnels.push(t);
        return t;
      };
      const machines = createMachines({
        dir: ctx.dir,
        ...gate,
        root: ROOT,
        channel: createSshChannel({ sshArgs }),
        pool,
        safeStorage: throwawayKeySafe,
      });
      return { machines, pool, tunnels };
    },
    /** The app's outbox for a chat that runs on the machine, with an in-memory queue where the chat's window would show it. @param {any} ctx @param {string} chatId */
    makeSend(ctx, chatId) {
      const owners = new OwnershipStore(path.join(ctx.dir, 'host-ownership.json'));
      owners.set(chatId, { hostId: ctx.state.id, ownerHostId: ctx.state.id, epoch: 0, folder: ctx.state.dataDir });
      /** @type {Map<string, { queue: any[] }>} */
      const store = new Map();
      const get = (/** @type {string} */ id) => store.get(id) ?? (store.set(id, { queue: [] }), /** @type {any} */ (store.get(id)));
      const send = createRemoteSend({
        outbox: createOutbox({ dir: path.join(ctx.dir, 'host-outbox') }),
        ownerOf: (/** @type {string} */ id) => (owners.refresh(), owners.get(id)),
        hostFor: (/** @type {string} */ id) => ctx.state.machines.hostFor(id),
        rowOf: (/** @type {string} */ id) => ctx.state.machines.row(id),
        onRowChange: (/** @type {() => void} */ fn) => ctx.state.machines.onRowChange(fn),
        state: () => ({ get, patch: (/** @type {string} */ id, /** @type {any} */ p) => Object.assign(get(id), p) }),
        tray: (/** @type {any} */ item) => ({
          id: item.id ?? crypto.randomUUID(),
          text: item.text,
          cwd: item.cwd,
          attachments: [],
          opts: {},
        }),
      });
      return { send, queue: (/** @type {string} */ id) => get(id).queue };
    },
  };
}

/**
 * @param {string[]} argv
 * @param {{ out: (text: string) => unknown, deps: (o: ReturnType<typeof parseArgs>) => ReturnType<typeof realDeps>, channelFor: (target: string, o: ReturnType<typeof parseArgs>) => ReturnType<typeof createChannel>, patience?: number }} io
 */
export async function main(argv, io) {
  const o = parseArgs(argv);
  const target = o.vm || o.ssh;
  // a data folder too long for a socket on purpose: the tunnel's short-folder fallback is part of what is checked
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'host-accept-app-'));
  const dir = path.join(base, 'a-profile-folder-whose-path-is-long-enough-that-a-unix-socket-cannot-live-in-it-directly');
  fs.mkdirSync(dir, { recursive: true });
  const ctx = {
    m: io.channelFor(target, o),
    deps: io.deps(o),
    root: ROOT,
    outDir: dir,
    dir,
    target,
    nonce: path.basename(base).slice(-6),
    patience: io.patience,
    state: /** @type {any} */ ({}),
  };
  const rows = await runSteps({ steps: STEPS, ctx, only: [] });
  await cleanup(ctx);
  const report = formatReport({ target: `${target} (the app’s side)`, rows, notVerified: NOT_VERIFIED });
  io.out(report);
  if (o.out) fs.writeFileSync(o.out, report);
  fs.rmSync(base, { recursive: true, force: true });
  return exitCode(rows);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const channelFor = (/** @type {string} */ target, /** @type {{ ssh: string }} */ o) =>
    createChannel({ launcher: o.ssh ? sshLauncher(target) : vmLauncher(target, path.join(ROOT, 'scripts/vm-exec.sh')) });
  main(process.argv.slice(2), { out: (text) => process.stdout.write(`${text}\n`), deps: (o) => realDeps(o), channelFor }).then(
    (code) => (process.exitCode = code),
    (e) => {
      process.stderr.write(`host-accept-app: ${e.message}\n`);
      process.exitCode = 2;
    },
  );
}
