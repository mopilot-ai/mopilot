// Every supported harness's official install commands, keyed by registry kind, and the lines a machine shows for
// them. One table: the registry (src/harness/registry.ts) carries it as StaticInfo.install, and main resolves a run
// by (kind, line) from it rather than running a command a window sends. Types are in harnessInstall.d.mts.
import { ownTable } from './ownTable.mjs';
import { ACP_CATALOG, ACP_PUBLIC_IDS } from './harnessCatalog.mjs';

const POSIX = ['darwin', 'linux'];
const WIN = ['win32'];

/** What each way of installing is called on its line. */
export const INSTALL_VIA_LABEL = ownTable({ script: 'Script', brew: 'Homebrew', npm: 'npm', winget: 'winget', powershell: 'PowerShell' });

/** A vendor's standalone script for macOS and Linux (no Node.js needed). */
const script = (command) => ({ via: 'script', command, os: POSIX });
/** A vendor's PowerShell one-liner for Windows. */
const powershell = (command, note) => ({ via: 'powershell', command, os: WIN, ...(note ? { note } : {}) });
/** A global npm install; `spec` is what follows `npm install -g` when it is not the bare package. */
const npm = (pkg, os = POSIX, spec = pkg) => ({ via: 'npm', command: `npm install -g ${spec}`, os, needs: 'node', npm: pkg });
/** A Homebrew formula, or a cask. */
const brew = (name, { cask = false, os = POSIX } = {}) => ({
  via: 'brew',
  command: `brew install ${cask ? '--cask ' : ''}${name}`,
  os,
  needs: 'brew',
  brew: { name, cask },
});

/** In the vendor's own order of recommendation (verified against each vendor's docs, 2026-10-17). */
export const HARNESS_INSTALL = ownTable({
  codex: {
    docs: 'https://developers.openai.com/codex/cli',
    methods: [
      script('curl -fsSL https://chatgpt.com/codex/install.sh | sh'),
      brew('codex', { cask: true, os: ['darwin'] }),
      npm('@openai/codex', [...POSIX, ...WIN]),
      powershell('irm https://chatgpt.com/codex/install.ps1 | iex'),
    ],
  },
  claude: {
    docs: 'https://code.claude.com/docs/en/setup',
    methods: [
      script('curl -fsSL https://claude.ai/install.sh | bash'),
      brew('claude-code', { cask: true, os: ['darwin'] }),
      npm('@anthropic-ai/claude-code'),
      powershell('irm https://claude.ai/install.ps1 | iex'),
      { via: 'winget', command: 'winget install Anthropic.ClaudeCode', os: WIN },
    ],
  },
  ...Object.fromEntries(ACP_PUBLIC_IDS.map((id) => [`acp:${id}`, ACP_CATALOG[id].install])),
});

/** The table's OS for a Node platform: anything not macOS or Windows takes the Linux lines. */
export const installOs = (platform) => (platform === 'win32' || platform === 'darwin' ? platform : 'linux');

/** What the terminal runs for a command: through a shell, so the vendor's pipe and the login PATH work. */
export const installArgv = (command, platform) =>
  installOs(platform) === 'win32' ? ['powershell.exe', '-NoProfile', '-Command', command] : ['/bin/sh', '-c', command];

/** The package managers that can't run two installs at once: their runs wait for each other across harnesses. */
const LOCKED = new Set(['npm', 'brew']);
export const installGroup = (via) => (LOCKED.has(via) ? via : null);

/** Automatic package changes need verified process retirement; Windows retains its manual command workflow. */
export const packageExecutionBlock = (platform) =>
  platform === 'win32' ? 'Run this command in your terminal. Automatic package changes are unavailable on Windows.' : null;

/** Manual commands obey the same known compatibility refusals as automatic updates. */
export const manualUpdateCommand = (info) => (info.latestStatus === 'knownBad' || info.latestStatus === 'tooOld' ? null : info.command);

/** The method at `index` of `kind`'s table, when it is one for this platform; null for anything else. */
export function installMethod(kind, index, platform) {
  const m = Number.isInteger(index) ? HARNESS_INSTALL[kind]?.methods[index] : undefined;
  return m && m.os.includes(installOs(platform)) ? m : null;
}

/** Why a line can't run on this machine: a missing tool or a folder it can't write to. Null when it can. */
function blocked(m, tools) {
  if (!tools) return null;
  if (m.needs === 'node' && !tools.npm) return 'Needs Node.js';
  if (m.needs === 'brew' && !tools.brew) return 'Needs Homebrew';
  if (m.via === 'npm' && tools.npmWritable === false) return 'Needs admin rights';
  return null;
}

/**
 * The install lines `kind` shows on `platform`, in the vendor's order: a line this machine can't run says why (and
 * keeps its Copy), and an npm line without Node.js goes last. `tools` null (not known yet) blocks nothing. The first
 * line that can run is `recommended`: the one an install surface offers, the others behind "Other ways to install".
 */
export function installLines(kind, platform, tools) {
  const os = installOs(platform);
  const lines = (HARNESS_INSTALL[kind]?.methods ?? [])
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => m.os.includes(os))
    .map(({ m, index }) => ({
      index,
      via: m.via,
      label: INSTALL_VIA_LABEL[m.via],
      command: m.command,
      note: m.note ?? null,
      blocked: packageExecutionBlock(platform) ?? blocked(m, tools),
      group: installGroup(m.via),
    }));
  const last = (l) => (l.blocked === 'Needs Node.js' ? 1 : 0);
  const sorted = lines.sort((a, b) => last(a) - last(b));
  // the one line offered first: the vendor's first that this machine can run (its standalone script, no Node.js needed)
  const pick = sorted.find((l) => !l.blocked) ?? null;
  return sorted.map((l) => ({ ...l, recommended: l === pick }));
}
