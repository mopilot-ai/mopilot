// Launches the real Electron app against the fake harness binaries, in a throwaway profile.
import { test as base, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import { readJsonLineLog } from '../../../scripts/fixture-json-log.mjs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startFakeHelper, type FakeHelper } from './fake-helper';
import { holdAcpLogin } from '../../fixtures/acp-login-gate.mjs';
import { withDevFlags } from './devFlags';
import { nodeCommand, withPath } from './nodeCommand';
import { endLeftovers, startedBy } from './leftovers';

const ROOT = path.resolve(__dirname, '../../..');
const FIXTURES = __dirname;
export const FAKE_CODEX = path.join(FIXTURES, 'fake-codex.mjs');
export const FAKE_CLAUDE = path.join(FIXTURES, 'fake-claude.mjs');
export const FAKE_ACP = path.resolve(FIXTURES, '../../fixtures/fake-acp-agent.mjs');
const LINUX_DESKTOP = path.join(FIXTURES, 'linux-desktop.cjs');
/** Every launch loads it: shell.openExternal records the URL instead of opening it (fixtures/externalUrls.ts). */
export const NO_EXTERNAL = path.join(FIXTURES, 'no-external.cjs');

/**
 * Basic-tier harnesses the app finds installed, by harness id: tests/fixtures/fake-acp-agent.mjs
 * under that id, each with its FAKE_ACP_PROFILE (the capabilities it declares).
 */
export type AcpFakes = Record<string, Record<string, unknown>>;

export interface Logged {
  at: number;
  id: number | string | null;
  method: string;
  params: any;
  /** set on the client's responses to the fake's own server requests (method is then null) */
  response?: { result?: any; error?: { code: number; message: string } };
}

/** One line of the fake Claude CLI's log: the argv a process started with, or a line it read. */
export type ClaudeLogged = { at: number; pid: number } & ({ kind: 'argv'; argv: string[]; cwd?: string } | { kind: 'in'; msg: any });

/**
 * Which harnesses the app finds installed and signed in:
 * - 'codex': the fake Codex; the fake Claude CLI is installed but signed out (so a real CLI
 *   elsewhere on the machine can't stand in for it);
 * - 'claude': the fake Claude CLI; no Codex at all;
 * - 'both': both fakes, signed in;
 * - 'none': no Codex, and the fake Claude CLI signed out (nothing can run a chat).
 */
export type Harnesses = 'codex' | 'claude' | 'both' | 'none';

/** Where a launch keeps its files, for seeding state before the app starts. */
export interface Dirs {
  home: string;
  userData: string;
  codexHome: string;
  claudeHome: string;
}

export interface Harness {
  app: ElectronApplication;
  page: Page;
  dir: string;
  /** The environment the app was launched with (HOME, MOPILOT_USER_DATA, the fake binaries), for launching another build on the same profile. */
  env: Record<string, string>;
  /** Requests the fake Codex app-server has received so far. */
  codexLog(): Logged[];
  /**
   * Everything the fake Claude CLI processes have read so far, plus the argv each started with: chat sessions and the
   * app's own background queries (title helper, /usage probe) alike. For what a chat received, use claudeChatMessages
   * (fixtures/claudeChat.ts).
   */
  claudeLog(): ClaudeLogged[];
  /** Lets a RUNCMDSTREAM command in fake-claude finish. */
  releaseClaudeCommand(): void;
  /** Keeps the next fake `claude auth login` running (as a real login waits for the browser) until the returned function lets it finish. */
  holdClaudeLogin(): () => void;
  /** Holds an ACP terminal login until its terminal has been observed; always release in finally. */
  holdAcpLogin(id: string): () => void;
  /** Everything the fake ACP agents read and wrote (tests/fixtures/fake-acp-agent.mjs), by harness id. */
  acpLog(id: string): any[];
  /** Quit the app (as the user would, through before-quit) and wait for it to exit. */
  quit(): Promise<void>;
  /** Quit the app and start it again on the same profile (app and page are replaced). */
  relaunch(): Promise<void>;
  /** The fake computer-use helper main talks to, when the test asked for one (computerHelper). */
  helper: FakeHelper | null;
}

/**
 * Sends an app:command (as the menu does) to the app window: a window showing the app page, never Quick Chat
 * (#mini) or the browser pane's hidden parking window, which loads no page.
 */
export async function sendAppCommand(h: Pick<Harness, 'app'>, command: string, arg?: unknown) {
  await h.app.evaluate(
    ({ BrowserWindow }, [command, arg]) => {
      const win = BrowserWindow.getAllWindows().find((w) => {
        const url = w.webContents.getURL();
        return url.startsWith('file:') && !url.includes('#mini');
      });
      if (!win) throw new Error('no app window');
      win.webContents.send('app:command', command, arg);
    },
    [command, arg] as const,
  );
}

/**
 * How many built-in browser pages are open: the pane's tabs are main-owned views (#529, no <webview> guests) in
 * the browser's shared partition (shared/browserStorage.mjs SHARED_PARTITION).
 */
export function builtinBrowserPages(h: Pick<Harness, 'app'>): Promise<number> {
  return h.app.evaluate(
    ({ webContents, session }) =>
      webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.session === session.fromPartition('persist:browser')).length,
  );
}

function readJsonl<T>(file: string): T[] {
  return readJsonLineLog(file) as T[];
}

/**
 * An existing profile written before the app starts (as an older build left it):
 * - uiState: merged over the fixture's ui-state.json;
 * - threads: files under userData/threads, by file name;
 * - codexThreads: threads the fake Codex already has (fake-codex.mjs FAKE_CODEX_THREADS);
 * - claudeSessions: Claude Code transcripts under CLAUDE_CONFIG_DIR/projects, cwd relative to HOME;
 * - files: writes anything else (accounts, logins) into the profile's folders.
 */
export interface Seed {
  files?: (d: Dirs) => void;
  uiState?: Record<string, unknown>;
  threads?: Record<string, unknown>;
  codexThreads?: {
    id: string;
    name?: string;
    cwd?: string;
    archived?: boolean;
    turns: string[];
    goal?: { objective: string; status: string };
    elsewhere?: boolean;
    /** another Codex app may write it later (fake-codex-elsewhere.mjs) */
    rollout?: boolean;
  }[];
  /** `running`: another app is still answering the last turn (no reply written yet) */
  claudeSessions?: { id: string; cwd: string; title?: string; turns: string[]; running?: boolean }[];
  /** other files under userData, by path relative to it */
  userData?: Record<string, unknown>;
}

/** A finished Claude Code transcript: each turn a user line and the fake's reply. */
function claudeTranscript(home: string, claudeHome: string, s: NonNullable<Seed['claudeSessions']>[number]) {
  const cwd = path.join(home, s.cwd);
  fs.mkdirSync(cwd, { recursive: true });
  const dir = path.join(claudeHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  let parentUuid: string | null = null;
  let t = Date.now() - 60_000;
  const lines: string[] = [];
  const add = (type: string, extra: object) => {
    const uuid = randomUUID();
    lines.push(
      JSON.stringify({
        parentUuid,
        isSidechain: false,
        userType: 'external',
        cwd,
        sessionId: s.id,
        version: '9.9.9',
        gitBranch: '',
        type,
        uuid,
        timestamp: new Date((t += 1000)).toISOString(),
        ...extra,
      }),
    );
    parentUuid = uuid;
  };
  for (const [i, text] of s.turns.entries()) {
    add('user', { message: { role: 'user', content: text } });
    if (s.running && i === s.turns.length - 1) continue;
    add('assistant', {
      message: {
        id: `msg_${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: `fake-claude: ${text}` }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
  }
  if (s.title) lines.push(JSON.stringify({ type: 'custom-title', customTitle: s.title, sessionId: s.id }));
  fs.writeFileSync(path.join(dir, `${s.id}.jsonl`), lines.join('\n') + '\n');
}

/**
 * Everything the app could read or write lives under one temp dir: HOME, userData (through the
 * app's MOPILOT_USER_DATA override), CODEX_HOME and CLAUDE_CONFIG_DIR. Nothing points at real
 * credentials, and the MoPilot API is an address nothing listens on.
 */
async function launch(
  harnesses: Harnesses,
  codexProjects: string[],
  claudeOnShellPath: boolean,
  seed: Seed | null = null,
  acp: AcpFakes = {},
  computerHelper = false,
  extraEnv: Record<string, string> = {},
  shellPath: string[] = [],
  mainRequire: string[] = [],
): Promise<Harness> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-e2e-')));
  const home = path.join(dir, 'home');
  const userData = path.join(dir, 'userData');
  const codexHome = path.join(home, '.codex');
  const claudeHome = path.join(home, '.claude');
  for (const d of [home, userData, codexHome, claudeHome]) fs.mkdirSync(d, { recursive: true });
  seed?.files?.({ home, userData, codexHome, claudeHome });
  const log = path.join(dir, 'fake-codex.jsonl');
  const claudeLogFile = path.join(dir, 'fake-claude.jsonl');
  // Windows: the fakes as programs (launcher .exe files), as a Codex or Claude Code install gives them there; a terminal
  // (`claude auth login` in a pty) runs only a program, not a Node script
  const fakeBin = (name: string, script: string) =>
    process.platform === 'win32' ? nodeCommand(path.join(dir, 'fake-bin'), name, script) : script;
  let codexBin = fakeBin('codex', FAKE_CODEX);
  if (harnesses === 'claude' || harnesses === 'none') {
    // "Not installed": a pinned path that exists but can't be run, so the app's search never falls
    // through to a real Codex on this machine and starting the app-server fails as it would without one.
    codexBin = path.join(dir, 'no-codex', 'codex');
    fs.mkdirSync(path.dirname(codexBin));
    fs.writeFileSync(codexBin, '', { mode: 0o644 });
  }
  const uiState = {
    ...(seed?.uiState ?? {}),
    codexBin,
    // no first-run consent dialog, no update checks; quitting at teardown doesn't stop to ask
    // (a test that wants the exit gate's dialog seeds confirmClose)
    prefs: {
      confirmClose: 'never',
      ...((seed?.uiState?.prefs as object) ?? {}),
      shareUsageData: false,
      // off unless a spec seeds it (Host auto-update follows the same setting; an unpackaged build never updates itself)
      autoUpdate: (seed?.uiState?.prefs as { autoUpdate?: boolean } | undefined)?.autoUpdate ?? false,
      importSync: false,
    },
  };
  fs.writeFileSync(path.join(userData, 'ui-state.json'), JSON.stringify(uiState));
  for (const [name, body] of Object.entries(seed?.threads ?? {})) {
    fs.mkdirSync(path.join(userData, 'threads'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'threads', name), JSON.stringify(body));
  }
  for (const [name, body] of Object.entries(seed?.userData ?? {})) {
    fs.mkdirSync(path.dirname(path.join(userData, name)), { recursive: true });
    fs.writeFileSync(path.join(userData, name), JSON.stringify(body));
  }
  for (const s of seed?.claudeSessions ?? []) claudeTranscript(home, claudeHome, s);
  const seedEnv: Record<string, string> = {};
  if (seed?.codexThreads) {
    const threads = JSON.stringify(seed.codexThreads.map((t) => ({ ...t, cwd: t.cwd ? path.join(home, t.cwd) : home })));
    // thousands of seeded threads are past what an environment variable holds (spawn E2BIG): the fake reads `@<file>`
    const file = path.join(dir, 'codex-threads.json');
    if (threads.length > 64 * 1024) fs.writeFileSync(file, threads);
    seedEnv.FAKE_CODEX_THREADS = threads.length > 64 * 1024 ? `@${file}` : threads;
  }
  // folders under HOME that the fake Codex already lists as projects
  const seeded = codexProjects.map((rel) => {
    const p = path.join(home, rel);
    fs.mkdirSync(p, { recursive: true });
    return { name: path.basename(p), path: p };
  });
  // The login shell the app snapshots its env from: exports nothing of the developer's, and with
  // claudeOnShellPath puts a dir holding the fake `claude` on PATH, as nvm or ~/.local/bin would.
  const shellBin = path.join(dir, 'shell-bin');
  fs.mkdirSync(shellBin);
  // Windows: a launcher .exe, which is what the app finds on PATH there (fixtures/nodeCommand.ts)
  if (claudeOnShellPath) {
    if (process.platform === 'win32') nodeCommand(shellBin, 'claude', FAKE_CLAUDE);
    else fs.symlinkSync(FAKE_CLAUDE, path.join(shellBin, 'claude'));
  }
  const fakeShell = path.join(dir, 'fake-shell');
  // shellPath: folders the login shell puts first, so a fake tool wins over one a machine has installed (a CI runner's gh)
  const front = [...shellPath, ...(claudeOnShellPath ? [shellBin] : [])];
  const extraPath = front.length ? `export PATH="${front.join(':')}:$PATH"\n` : '';
  fs.writeFileSync(fakeShell, `#!/bin/sh\n${extraPath}for a; do c=$a; done\nexec /bin/sh -c "$c"\n`, { mode: 0o755 });
  const env: Record<string, string> = {};
  // DISPLAY and XAUTHORITY: the virtual display xvfb-run gives the app on a Linux runner (the PR check's job e2e), and
  // the cookie it takes, which the X server refuses the app without (HOME is the temp one, which holds no ~/.Xauthority)
  for (const k of ['PATH', 'TMPDIR', 'LANG', 'DISPLAY', 'XAUTHORITY']) if (process.env[k]) env[k] = process.env[k]!;
  // Windows (win-e2e.yml): what its system libraries need to start a process (sockets and the crypto provider fail without
  // SystemRoot), and the profile folders under the temp HOME, since Windows reads USERPROFILE and APPDATA, not HOME.
  // PSModuleAnalysisCachePath: the runner image points Windows PowerShell at the module analysis cache it built
  // (C:\PSModuleAnalysisCachePath); without it PowerShell's first auto-loaded cmdlet took 18 to 30 s in every process the
  // app started, so every terminal command, setup script and !cmd timed out. A user's
  // session has no such variable and its own warm cache. (Halving probe: win-e2e run 43608467187.)
  if (process.platform === 'win32') {
    for (const k of ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'PSModuleAnalysisCachePath'])
      if (process.env[k]) env[k] = process.env[k]!;
    const appData = { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') };
    for (const d of Object.values(appData)) fs.mkdirSync(d, { recursive: true });
    // Git for Windows' system config checks files out with CRLF (core.autocrlf), which no macOS or Linux Git does
    Object.assign(env, { USERPROFILE: home, ...appData, GIT_CONFIG_NOSYSTEM: '1' });
  }
  Object.assign(env, {
    HOME: home,
    MOPILOT_USER_DATA: userData,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_BIN: codexBin,
    SHELL: fakeShell,
    FAKE_CODEX_LOG: log,
    FAKE_CODEX_PROJECTS: JSON.stringify(seeded),
    FAKE_CLAUDE_LOG: claudeLogFile,
    FAKE_CLAUDE_AUTH: harnesses === 'codex' || harnesses === 'none' ? 'signed-out' : 'subscription',
    SAGE_NO_RELAY: '1',
    // main registers the sage_debug_echo tool
    SAGE_DEBUG_TOOLS: '1',
    // main's scheduler lets a test move its clock on (globalThis.__schedulerAdvance)
    MOPILOT_SCHEDULER_TEST: '1',
    // open behind the user's work instead of taking focus (electron/app/backgroundMode.cjs); SAGE_E2E_FOREGROUND=1 to watch
    ...(process.env.SAGE_E2E_FOREGROUND === '1' ? {} : { SAGE_E2E_BACKGROUND: '1' }),
    MOPILOT_API: 'http://127.0.0.1:9',
    ...seedEnv,
    ...extraEnv,
  });
  // flags in development are on unless the spec pins one off (fixtures/devFlags.ts)
  env.MOPILOT_FLAGS = withDevFlags(env.MOPILOT_FLAGS);
  // Windows reads no login shell (electron/platform/env.cjs childEnv): the shell's folders go first on the app's own PATH
  if (process.platform === 'win32' && front.length) env.PATH = withPath(front, env.PATH);
  // the fake reports a version above any installed CLI, so the app picks it over a real one
  if (!claudeOnShellPath) env.CLAUDE_BIN = fakeBin('claude', FAKE_CLAUDE);
  // computer use talks to a fake helper on a socket; the real helper is never launched
  // Windows has no unix socket in a folder: a named pipe of this launch's own
  const helperSocket = process.platform === 'win32' ? `\\\\.\\pipe\\mopilot-e2e-cu-${path.basename(dir)}` : path.join(dir, 'cu.sock');
  const helper = computerHelper ? await startFakeHelper(helperSocket) : null;
  if (helper) env.SAGE_CU_FAKE_HELPER = helper.socket;
  // --use-mock-keychain keeps Chromium's cookie encryption away from the login keychain
  // Basic-tier harnesses: only the fakes asked for, never one installed on this machine.
  const acpBins: Record<string, string> = {};
  for (const [id, profile] of Object.entries(acp)) {
    acpBins[id] = nodeCommand(path.join(dir, 'acp-bin'), id, FAKE_ACP, {
      FAKE_ACP_LOG: path.join(dir, `fake-acp-${id}.jsonl`),
      FAKE_ACP_STATE: path.join(dir, `fake-acp-${id}-state`),
      FAKE_ACP_PROFILE: JSON.stringify(profile),
    });
  }
  env.SAGE_ACP_BINS = JSON.stringify(acpBins);
  const start = async () => {
    const app = await electron.launch({
      args: [
        '--use-mock-keychain',
        // a Linux runner has no keyring or notification server (fixtures/linux-desktop.cjs)
        ...(process.platform === 'linux' ? ['--password-store=basic', '-r', LINUX_DESKTOP] : []),
        // shell.openExternal records the URL: no browser or System Settings opens on this machine (fixtures/externalUrls.ts)
        '-r',
        NO_EXTERNAL,
        ...mainRequire.flatMap((m) => ['-r', m]),
        ...(env.SAGE_DEBUG_PORT ? [`--remote-debugging-port=${env.SAGE_DEBUG_PORT}`] : []),
        ROOT,
      ],
      cwd: ROOT,
      env,
    });
    return { app, page: await app.firstWindow() };
  };
  const h: Harness = {
    ...(await start()),
    dir,
    env,
    codexLog: () => readJsonl<Logged>(log),
    claudeLog: () => readJsonl<ClaudeLogged>(claudeLogFile),
    releaseClaudeCommand: () => fs.writeFileSync(`${claudeLogFile}.release`, ''),
    holdAcpLogin: (id) => {
      if (!Object.hasOwn(acp, id)) throw new Error(`No fake ACP harness configured for ${id}`);
      return holdAcpLogin(path.join(dir, `fake-acp-${id}-state`));
    },
    holdClaudeLogin: () => {
      fs.writeFileSync(`${claudeLogFile}.hold-login`, '');
      return () => fs.rmSync(`${claudeLogFile}.hold-login`, { force: true });
    },
    helper,
    acpLog: (id) => readJsonl<any>(path.join(dir, `fake-acp-${id}.jsonl`)),
    quit: async () => {
      const closed = new Promise<void>((r) => h.app.once('close', () => r()));
      await h.app.evaluate(({ app }) => app.quit()).catch(() => {});
      await closed;
    },
    relaunch: async () => {
      // already gone after quit()
      await h.app.close().catch(() => {});
      Object.assign(h, await start());
    },
  };
  return h;
}

export const test = base.extend<{
  harnesses: Harnesses;
  codexProjects: string[];
  claudeOnShellPath: boolean;
  shellPath: string[];
  seed: Seed | null;
  acp: AcpFakes;
  computerHelper: boolean;
  env: Record<string, string>;
  mainRequire: string[];
  harness: Harness;
  page: Page;
}>({
  harnesses: ['codex', { option: true }],
  /** Folders (relative to HOME) the fake Codex lists as its projects at start. */
  codexProjects: [[], { option: true }],
  /** Find the fake Claude CLI only through the login shell's PATH (no CLAUDE_BIN). */
  claudeOnShellPath: [false, { option: true }],
  /** Folders the login shell puts first on PATH (the app finds tools there before the machine's own). */
  shellPath: [[], { option: true }],
  /** Writes an existing profile (ui-state.json, threads/, transcripts) before the app starts. */
  seed: [null, { option: true }],
  /** Basic-tier harnesses the app finds installed (fakes). */
  acp: [{}, { option: true }],
  /** Start a fake computer-use helper and point the app at it (SAGE_CU_FAKE_HELPER). */
  computerHelper: [false, { option: true }],
  /** Extra environment for the app and the fakes (e.g. FAKE_CODEX_VERSION). */
  env: [{}, { option: true }],
  /** Modules main loads before the app (Electron's -r), e.g. fixtures/update-hook.cjs; also on relaunch. */
  mainRequire: [[], { option: true }],
  harness: async (
    { harnesses, codexProjects, claudeOnShellPath, seed, acp, computerHelper, env, shellPath, mainRequire },
    use,
    testInfo,
  ) => {
    const h = await launch(harnesses, codexProjects, claudeOnShellPath, seed, acp, computerHelper, env, shellPath, mainRequire);
    await use(h);
    // Windows: what the app started, to tell and end what outlives it (fixtures/leftovers.ts)
    // (a test that quit the app has no process to ask about)
    let pid: number | undefined;
    try {
      pid = h.app.process().pid;
    } catch {
      pid = undefined;
    }
    const started = startedBy(pid);
    await h.app.close().catch(() => {});
    await endLeftovers(started, h.dir, testInfo.titlePath.join(' › '));
    await h.helper?.close();
    // Shutdown can leave a last filesystem write racing removal; retry transient errors without hiding persistent ones.
    fs.rmSync(h.dir, { recursive: true, force: true, maxRetries: 5 });
  },
  page: async ({ harness }, use) => {
    await use(harness.page);
  },
});

export { expect };
