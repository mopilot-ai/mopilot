// A real Host process the Mac app reaches the way it reaches any machine: over real ssh (this runner's own sshd, as host-core-install-mac does), its own data dir and socket, its Claude CLI the repo's fake one (MOPILOT_CLAUDE_BIN). Runners only: it turns on sshd and writes the user's ssh config.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, FAKE_ACP } from './app';
import { openHarnessList } from './harnessPicker';
import { fakeAgentBins } from './hostQuestion';
import { withMarkedBlock } from './markedBlock';

const ROOT = path.resolve(__dirname, '../../..');
/** The name the app lists the machine under when the machine does not report one, and its address: a CI runner's user is `runner` (spelled out because the specs' registry seed is read by a guard that evaluates it with nothing else defined). */
export const REMOTE_NAME = 'localhost';
export const REMOTE_ADDRESS = `${os.userInfo().username}@localhost`;
/** Where the Host's files and socket are, spelled out for the same reason. */
export const REMOTE_DIR = '/tmp/mm-remote-host';
export const REMOTE_SOCKET = `${REMOTE_DIR}/data/host.sock`;

const sh = (command: string) => execFileSync('sh', ['-c', command], { cwd: ROOT, stdio: 'inherit' });

/** Our block in a file of the user's ssh setup (created 0600 when it is not there). */
function editMarked(file: string, body: string) {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, withMarkedBlock(before, 'mopilot-e2e ssh-to-self', body), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** Let this user sign in to this machine's sshd with a fresh key that the user's ssh config offers to `localhost`, and trusts its host key on first sight (the app's ssh runs in BatchMode and cannot ask). */
export function sshToSelf() {
  if (os.userInfo().username !== 'runner' && !process.env.MOPILOT_ACCEPT_VM)
    throw new Error('This spec is for a CI runner, whose user is `runner`, or the isolated VM (MOPILOT_ACCEPT_VM=1).');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-ssh-'));
  const key = path.join(dir, 'key');
  sh(`ssh-keygen -q -t ed25519 -N '' -f '${key}'`);
  const home = os.homedir();
  sh(`mkdir -p '${home}/.ssh' && chmod 700 '${home}/.ssh'`);
  // one block of ours in each file, replaced on each run: a machine that keeps its home (the acceptance VM) otherwise grows one per spec run until ssh refuses the file
  editMarked(path.join(home, '.ssh', 'authorized_keys'), fs.readFileSync(`${key}.pub`, 'utf8'));
  editMarked(
    path.join(home, '.ssh', 'config'),
    `Host localhost\n  IdentityFile ${key}\n  IdentitiesOnly yes\n  StrictHostKeyChecking accept-new\n`,
  );
  sh(process.platform === 'darwin' ? 'sudo launchctl load -w /System/Library/LaunchDaemons/ssh.plist' : 'sudo systemctl start ssh');
  // the login must work before the app tries it
  execFileSync('ssh', ['-o', 'BatchMode=yes', REMOTE_ADDRESS, 'true'], { stdio: 'inherit', timeout: 60_000 });
}

/** Which fake agents a Host finds: Claude Code and Codex by their shims on its PATH, the repo's fake ACP agent by its harnesses.json entry (signed in, or out). */
export interface AgentSet {
  claude?: boolean;
  codex?: boolean;
  acp?: 'in' | 'out' | false;
  /** Claude Code / Codex are installed but signed out on the machine (a key the app lends is then what runs them). */
  claudeOut?: boolean;
  codexOut?: boolean;
  /** The ACP agent reports a model (a machine chat can only move to an agent that lists models). */
  acpModels?: boolean;
  /** Agents the Host's own record (`signed-in.json`) marks signed in, for a real agent that keeps no credential (opencode on its free models): the record is the scratch Host's, no provider is signed in to. */
  signedIn?: string[];
}
export type AgentsOption = 'claude+codex' | 'acp' | 'all' | 'real' | AgentSet;
const PRESETS: Record<string, AgentSet> = {
  'claude+codex': { claude: true, codex: true, acp: false },
  acp: { claude: false, codex: false, acp: 'in' },
  all: { claude: true, codex: true, acp: 'in' },
  // the machine's own Claude Code and Codex (the isolated VM only, tests/e2e/host-remote-real.spec.ts): no fake agent, and the PATH is left as it is
  real: {},
};

export interface RemoteHost {
  socketPath: string;
  dataDir: string;
  /** A fresh pairing code the app pairs with. */
  code(): string;
  /** What the fake Claude CLI was asked and answered (its log file). */
  claudeLog: string;
  /** What the fake Codex app-server was asked (its log file). */
  codexLog: string;
  /** What the Host process wrote. */
  hostLog: string;
  /** What the fake ACP agent was asked and answered (its log file), and the folder of its sessions. */
  acpLog: string;
  acpState: string;
  /** Ends the Host (`kill` hard, else the way a service stops) and starts it again on the same data, finding `agents`. */
  restart(o?: { agents?: AgentsOption; kill?: boolean }): Promise<void>;
  /** The Host process's pid (a new one after `restart`). */
  pid(): number;
  stop(): void;
}

/** The machine as the app lists it, and the folder of the chats on it. */
export const REMOTE_ID = `ssh:${REMOTE_ADDRESS}`;
export const REMOTE_FOLDER = path.join(os.homedir(), 'mm-remote-proj');

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const answers = (socket: string) =>
  new Promise<boolean>((resolve) => {
    const c = net.connect(socket);
    c.once('connect', () => (c.destroy(), resolve(true)));
    c.once('error', () => resolve(false));
  });

/**
 * Start a Host with a data dir of its own and wait until its socket answers. `agents`: the fake Claude Code and Codex it finds (the default), `acp`: only the repo's fake ACP agent, defined in the Host's harnesses.json and known to be signed in,
 * so a new chat on it starts on that agent, `all`: the three, or an AgentSet. `restart` brings the same Host back (its data kept) with another set.
 */
export async function startRemoteHost({
  agents = 'claude+codex',
  env: extraEnv = {},
}: {
  agents?: AgentsOption;
  env?: Record<string, string>;
} = {}): Promise<RemoteHost> {
  const dir = REMOTE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const bin = path.join(ROOT, 'host', 'bin', 'mopilot-host.mjs');
  const { bin: agentsBin, claudeLog, codexLog } = fakeAgentBins(dir);
  const setOf = (a: AgentsOption): AgentSet => (typeof a === 'string' ? PRESETS[a] : a);
  /** The Host's environment for a set, with the shims and harnesses.json it reads written. */
  const configure = (set: AgentSet) => {
    fakeAgentBins(dir, { claude: set.claudeOut, codex: set.codexOut });
    for (const [name, wanted] of [
      ['claude', set.claude],
      ['codex', set.codex],
    ] as const)
      if (!wanted) fs.rmSync(path.join(agentsBin, name), { force: true });
    const harnesses = {
      fake: {
        label: 'Fake',
        bin: process.execPath,
        args: [FAKE_ACP],
        env: {
          FAKE_ACP_STATE: path.join(dir, 'acp-state'),
          FAKE_ACP_LOG: path.join(dir, 'acp.jsonl'),
          ...(set.acpModels
            ? {
                FAKE_ACP_PROFILE: JSON.stringify({
                  configOptions: [
                    {
                      id: 'model',
                      name: 'Model',
                      category: 'model',
                      type: 'select',
                      currentValue: 'fake-1',
                      options: [{ value: 'fake-1', name: 'Fake 1' }],
                    },
                  ],
                }),
              }
            : {}),
        },
      },
    };
    if (set.acp) {
      fs.writeFileSync(path.join(dataDir, 'harnesses.json'), JSON.stringify(harnesses));
      fs.writeFileSync(path.join(dataDir, 'signed-in.json'), JSON.stringify({ fake: set.acp === 'in' }));
    } else fs.rmSync(path.join(dataDir, 'harnesses.json'), { force: true });
    if (set.signedIn?.length) {
      const file = path.join(dataDir, 'signed-in.json');
      const had = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      fs.writeFileSync(file, JSON.stringify({ ...had, ...Object.fromEntries(set.signedIn.map((id) => [id, true])) }));
    }
    return {
      ...process.env,
      ...extraEnv,
      ...(set.claude ? { MOPILOT_CLAUDE_BIN: path.join(agentsBin, 'claude') } : {}),
      PATH: `${path.dirname(process.execPath)}:${set.claude || set.codex ? `${agentsBin}:` : ''}${process.env.PATH}`,
    };
  };
  let env = configure(setOf(agents));
  const paths = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { createPaths } from ${JSON.stringify(path.join(ROOT, 'host', 'src', 'paths.mjs'))}; process.stdout.write(JSON.stringify(createPaths({ dataDir: process.argv[1] })))`,
        dataDir,
      ],
      { encoding: 'utf8', env },
    ),
  );
  if (paths.socketPath !== REMOTE_SOCKET) throw new Error(`The Host's socket is ${paths.socketPath}, not ${REMOTE_SOCKET}.`);
  const log = fs.openSync(path.join(dir, 'host.log'), 'a');
  const launch = async () => {
    const child: ChildProcess = spawn(process.execPath, [bin, 'serve', '--data-dir', dataDir], { env, stdio: ['ignore', log, log] });
    const started = Date.now();
    while (!(await answers(paths.socketPath))) {
      if (Date.now() - started > 60_000)
        throw new Error(`The Host did not start: ${fs.readFileSync(path.join(dir, 'host.log'), 'utf8').slice(-600)}`);
      await wait(250);
    }
    return child;
  };
  let child = await launch();
  return {
    socketPath: paths.socketPath,
    dataDir,
    claudeLog,
    codexLog,
    hostLog: path.join(dir, 'host.log'),
    acpLog: path.join(dir, 'acp.jsonl'),
    acpState: path.join(dir, 'acp-state'),
    code: () => {
      // the Host asks to try again while another process of it is updating its trust: the CLI says so, and the next try works
      for (let tries = 1; ; tries++) {
        try {
          return /Pairing code: (\S+)/.exec(
            execFileSync(process.execPath, [bin, 'pair', '--data-dir', dataDir], { encoding: 'utf8', env }),
          )![1];
        } catch (error) {
          if (tries >= 6 || !/Try again after it finishes/.test(String((error as { stderr?: unknown }).stderr ?? error))) throw error;
          execFileSync('sleep', ['2']);
        }
      }
    },
    pid: () => child.pid ?? 0,
    async restart({ agents: next = agents, kill = false } = {}) {
      const gone = new Promise((r) => child.once('exit', r));
      child.kill(kill ? 'SIGKILL' : 'SIGTERM');
      await gone;
      env = configure(setOf(next));
      child = await launch();
    },
    stop() {
      child.kill('SIGTERM');
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
    },
  };
}

const row = (page: Page) =>
  page.evaluate((id) => window.native.host.machines().then((r) => r.machines.find((m) => m.id === id) ?? null), REMOTE_ID);

/** The name the app shows for the machine (its own hostname once paired), the one source for every `on <machine>` expectation. */
export const machineName = async (page: Page) => (await row(page))?.name || REMOTE_NAME;

/** Pair this app with the machine and wait until its row is online with `agent` ready. */
export async function connectRemote(page: Page, remote: RemoteHost, agent: string) {
  await page.evaluate(([id, code]) => window.native.host.pair(id, code), [REMOTE_ID, remote.code()]);
  // the folder menu lists the machines that are online; the row's JSON is what a failure prints
  await expect.poll(async () => JSON.stringify(await row(page)), { timeout: 90_000 }).toContain('"status":"online"');
  await expect
    .poll(async () => JSON.stringify(await row(page)), { timeout: 60_000 })
    .toMatch(new RegExp(`"id":"${agent}"[^}]*"state":"ready"`));
}

/** A new chat in the folder on the machine, started on the machine's agent (the local row picked names it, and a name the machine has not ready falls to its first ready agent), and its first message. */
export async function startRemoteChat(page: Page, localRow: string, message: string, another = false, beforeSend?: () => Promise<void>) {
  if (another) await page.getByRole('button', { name: 'New chat' }).first().click();
  fs.mkdirSync(REMOTE_FOLDER, { recursive: true });
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: localRow }).click();
  // (a harness that has models opens its list: it is closed before the folder menu)
  await page.keyboard.press('Escape');
  await expect(page.locator('.popover-layer .menu-title')).toHaveCount(0);
  await page.locator('.ctxbar .ctx-btn').first().click();
  // the menu says the name the machine reports for itself (its hostname), which is `localhost` only on a runner that is called so
  await page.getByText(`Folder on ${await machineName(page)}…`).click({ timeout: 45_000 });
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('.host-picker-path')).toBeVisible({ timeout: 45_000 });
  if ((await dialog.locator('.host-picker-path').textContent()) !== REMOTE_FOLDER)
    await dialog.getByRole('button', { name: path.basename(REMOTE_FOLDER), exact: true }).click();
  await expect(dialog.locator('.host-picker-path')).toHaveText(REMOTE_FOLDER);
  await dialog.getByRole('button', { name: 'Use this folder' }).click();
  await beforeSend?.();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill(message);
  await expect(composer).toHaveText(message);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
