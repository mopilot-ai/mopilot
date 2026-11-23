// `install`: renders and writes the service unit that restarts the Host (a systemd user unit on Linux, a launchd plist on macOS). A Mac that keeps the Host running after a restart runs it as a system daemon (shared/host/launchDaemon.mjs): `install` then writes no agent (two Hosts would fight over the data dir) and only says what the daemon needs (`daemonInfo`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchdStart, launchdStop } from '../../shared/host/launchd.mjs';
import { DAEMON_PLIST } from '../../shared/host/launchDaemon.mjs';

/** Text that goes into a unit file is one line: a line break or another control character would start a new directive (systemd) or a new key (launchd). @param {string} name @param {string} value */
function oneLine(name, value) {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${name} has a control character, which cannot go into the service unit.`);
  return value;
}

/** @param {string} s */
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The unit runs with the PATH of the shell that installed it: a service starts with a minimal one, so `claude`, `codex` and the ACP
 * harnesses installed in a user's own folders would otherwise read as not installed on the Host.
 * @param {{ platform?: NodeJS.Platform, home?: string, env?: NodeJS.ProcessEnv, nodePath: string, binPath: string, dataDir: string }} o
 */
export function renderUnit({ platform = process.platform, home = os.homedir(), env = process.env, nodePath, binPath, dataDir }) {
  for (const [name, value] of /** @type {const} */ ([
    ['The path of node', nodePath],
    ['The path of the Host', binPath],
    ['The data folder', dataDir],
    ['PATH', env.PATH ?? ''],
  ]))
    oneLine(name, value);
  if (platform === 'darwin') {
    // launchd keeps no journal: what the Host prints (a crash, a refusal) goes to a file next to its data, where `status` and an operator can read it
    const logFile = path.join(dataDir, 'host.log');
    const args = [nodePath, binPath, 'serve', '--data-dir', dataDir].map((a) => `    <string>${xml(a)}</string>`).join('\n');
    const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.mopilot.host</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key><dict><key>MOPILOT_HOST_SUPERVISED</key><string>1</string>${env.PATH ? `<key>PATH</key><string>${xml(env.PATH)}</string>` : ''}</dict>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
    return { file: path.join(home, 'Library', 'LaunchAgents', 'ai.mopilot.host.plist'), text };
  }
  const quote = (/** @type {string} */ a) => `"${a.replace(/(["\\])/g, '\\$1').replace(/[$%]/g, '$&$&')}"`;
  const text = `[Unit]
Description=MoPilot Host

[Service]
ExecStart=${[nodePath, binPath, 'serve', '--data-dir', dataDir].map(quote).join(' ')}
Environment=MOPILOT_HOST_SUPERVISED=1
${env.PATH ? `Environment=${quote(`PATH=${env.PATH}`)}\n` : ''}Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
  return { file: path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', 'mopilot-host.service'), text };
}

/** One shell word for a path with spaces or quotes in it. @param {string} text */
const shellQuote = (text) => `'${text.replace(/'/g, "'\\''")}'`;

/** Whether this Mac runs the Host as a system daemon. @param {{ platform?: NodeJS.Platform, daemonPlist?: string }} o */
export const runsAsDaemon = ({ platform = process.platform, daemonPlist = DAEMON_PLIST }) =>
  platform === 'darwin' && fs.existsSync(daemonPlist);

/**
 * A Host the system daemon started removes the user's agent plist left from before it was turned on (a copied command turns it on
 * without the app's own clean-up), which would start a second Host at the next sign-in. Returns whether there was one.
 * @param {{ platform?: NodeJS.Platform, home?: string, env?: NodeJS.ProcessEnv }} o
 */
export function dropAgentUnderDaemon({ platform = process.platform, home = os.homedir(), env = process.env }) {
  if (platform !== 'darwin' || env.MOPILOT_HOST_SUPERVISED !== 'system') return false;
  const agent = path.join(home, 'Library', 'LaunchAgents', 'ai.mopilot.host.plist');
  const had = fs.existsSync(agent);
  fs.rmSync(agent, { force: true });
  return had;
}

/**
 * Write the unit; the caller says how to start it. Under a system daemon the user's agent is removed instead of written, and starting
 * restarts the daemon's Host onto the files just installed.
 * @param {Parameters<typeof renderUnit>[0] & { daemonPlist?: string }} o
 */
export function installUnit(o) {
  const daemonPlist = o.daemonPlist ?? DAEMON_PLIST;
  if (runsAsDaemon({ platform: o.platform, daemonPlist })) {
    const agent = renderUnit(o).file;
    fs.rmSync(agent, { force: true });
    return { file: daemonPlist, start: launchdStart(shellQuote(agent)), daemon: true };
  }
  const { file, text } = renderUnit(o);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const start =
    (o.platform ?? process.platform) === 'darwin'
      ? launchdStart(shellQuote(file))
      : 'systemctl --user daemon-reload && systemctl --user enable mopilot-host && systemctl --user restart mopilot-host';
  return { file, start, daemon: false };
}

/**
 * What the daemon's plist needs (shared/host/launchDaemon.mjs `renderDaemonPlist`): this user, and the Host started through the links
 * an install keeps current (`~/.mopilot-host/current`, its Node under `runtime/current`) when this Host runs from them, so a later
 * install or update needs no new plist.
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, user?: string, nodePath: string, binPath: string, dataDir: string, realpath?: (p: string) => string }} o
 */
export function daemonInfo({
  home = os.homedir(),
  env = process.env,
  user = os.userInfo().username,
  nodePath,
  binPath,
  dataDir,
  realpath = fs.realpathSync,
}) {
  /** The stable link when it leads to `actual`, else `actual`. @param {string} link @param {string} actual */
  const stable = (link, actual) => {
    try {
      return realpath(link) === realpath(actual) ? link : actual;
    } catch {
      return actual;
    }
  };
  const root = path.join(home, '.mopilot-host');
  return {
    user,
    home,
    node: stable(path.join(root, 'runtime', 'current', 'bin', 'node'), nodePath),
    bin: stable(path.join(root, 'current', 'host', 'bin', 'mopilot-host.mjs'), binPath),
    dataDir,
    path: oneLine('PATH', env.PATH ?? ''),
  };
}

/**
 * The command that stops the service the unit runs, so a Host that was installed does not outlive its uninstall.
 * @param {Parameters<typeof renderUnit>[0]} o
 */
export function stopCommand(o) {
  return (o.platform ?? process.platform) === 'darwin'
    ? { bin: '/bin/sh', args: ['-c', launchdStop()] }
    : { bin: 'systemctl', args: ['--user', 'disable', '--now', 'mopilot-host'] };
}

/** Remove the unit `installUnit` wrote; a unit that is not there is already removed. The caller stops the service first. @param {Parameters<typeof renderUnit>[0]} o */
export function uninstallUnit(o) {
  const { file } = renderUnit(o);
  const existed = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  return { file, existed };
}
