// Starts agents, shells and ptys outside MoPilot's TCC responsibility (macOS). macOS attributes the
// microphone, Automation and file grants of a process to its "responsible process", normally the app that
// started it; native/disclaim execs the command with that link cut, so a command an agent runs does not
// ride on the grants MoPilot holds.
//
// Opt-in (MOPILOT_DISCLAIM=1) until a person has checked the cost on a packaged build: a disclaimed command
// is its own responsible process, so it no longer reads Desktop, Documents, Downloads or removable volumes
// on MoPilot's grant, and macOS asks (or refuses) for the command itself. Many repos live there.
// See docs/multi-harness/ARCHITECTURE.md. Without the launcher, or without the opt-in, commands start as before.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** Where the launcher lives: Contents/Helpers in a packaged app, native/disclaim/build in a checkout. */
function disclaimPath({ packaged = false, resourcesPath = process.resourcesPath, repoRoot = path.join(__dirname, '../..') } = {}) {
  return packaged ? path.join(resourcesPath, '..', 'Helpers', 'disclaim') : path.join(repoRoot, 'native/disclaim/build', 'disclaim');
}

/** @type {string | null} */
let launcher = null;
/** @type {(() => string | null) | null} set by configure, which is also the only way to get a launcher */
let scriptDir = null;

/**
 * @param {{launcher?: string | null, dir?: () => string | null, platform?: string, env?: NodeJS.ProcessEnv, exists?: (p: string) => boolean}} o
 * `dir`: where generated wrapper scripts go (see wrapProgram).
 */
function configure({
  launcher: path_ = null,
  dir = () => null,
  platform = process.platform,
  env = process.env,
  exists = fs.existsSync,
} = {}) {
  launcher = platform === 'darwin' && env.MOPILOT_DISCLAIM === '1' && path_ && exists(path_) ? path_ : null;
  scriptDir = dir;
}

const active = () => launcher;

/** The command and arguments to run `command args` disclaimed (unchanged when there is no launcher). */
function wrap(command, args = []) {
  return launcher ? { command: launcher, args: [command, ...args] } : { command, args };
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * For code that only takes a program path and spawns it itself (the Claude Agent SDK's
 * pathToClaudeCodeExecutable): a small script that execs `program` through the launcher. Scripts to
 * be run by node (.js) are left alone: the SDK starts those with node, not directly.
 */
function wrapProgram(program) {
  // configure() sets the launcher and scriptDir together
  const dir = launcher && /** @type {() => string | null} */ (scriptDir)();
  if (!dir || /\.(c|m)?js$/i.test(program)) return program;
  try {
    const file = path.join(dir, `disclaim-${crypto.createHash('sha1').update(`${launcher}\n${program}`).digest('hex').slice(0, 12)}`);
    const body = `#!/bin/sh\nexec ${shQuote(launcher)} ${shQuote(program)} "$@"\n`;
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== body) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, body, { mode: 0o755 });
    }
    return file;
  } catch {
    return program;
  }
}

module.exports = { disclaimPath, configure, active, wrap, wrapProgram, shQuote };
