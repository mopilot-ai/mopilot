// Keep running after restart, on a Mac: the Host as a launchd daemon in /Library/LaunchDaemons that runs as the machine's user (never root), so it starts at boot before anyone signs in. The plist is rendered here from what the Host reports (`mopilot-host install --print-daemon`), and the only commands that run as root are the two scripts below, made of system tools: they never run the Host's own files, and they set the user the daemon runs as themselves.

/** Where the daemon's plist lives; launchd loads it at boot. */
export const DAEMON_PLIST = '/Library/LaunchDaemons/ai.mopilot.host.plist';
const LABEL = 'ai.mopilot.host';
/** A macOS short user name; anything else is refused before it reaches a root shell. */
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

/** @typedef {{ user: string, home: string, node: string, bin: string, dataDir: string, path: string }} DaemonInfo */

/** @param {string} s */
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** An absolute path on one line. @param {unknown} v */
const absolute = (v) => typeof v === 'string' && v.startsWith('/') && v.length < 1024 && !/[\0-\x1f]/.test(v);

/**
 * What `mopilot-host install --print-daemon` printed, checked: a user other than root, and absolute paths on one line each. Null for
 * anything else.
 * @param {string} stdout @returns {DaemonInfo | null}
 */
export function parseDaemonInfo(stdout) {
  let v;
  try {
    v = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const { user, home, node, bin, dataDir, path } = v;
  if (typeof user !== 'string' || !USER.test(user) || user === 'root') return null;
  if (![home, node, bin, dataDir].every(absolute)) return null;
  if (typeof path !== 'string' || path.length > 8192 || /[\0-\x1f]/.test(path)) return null;
  return { user, home, node, bin, dataDir, path };
}

/**
 * The daemon's plist: the Host's `serve` as `user`, with its log next to its data, restarted whenever it exits (an update's restart
 * included). `MOPILOT_HOST_SUPERVISED=system` is how the Host knows it starts at boot.
 * @param {DaemonInfo} info
 */
export function renderDaemonPlist({ user, home, node, bin, dataDir, path }) {
  const args = [node, bin, 'serve', '--data-dir', dataDir].map((a) => `    <string>${xml(a)}</string>`).join('\n');
  const log = xml(`${dataDir}/host.log`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>UserName</key><string>${xml(user)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key><dict><key>MOPILOT_HOST_SUPERVISED</key><string>system</string><key>HOME</key><string>${xml(home)}</string>${path ? `<key>PATH</key><string>${xml(path)}</string>` : ''}</dict>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
}

/** Waits (up to 5 s) until launchd let go of the label in every domain it may be in; bootstrap refuses a label still there. */
const GONE = `i=0; while { /bin/launchctl print system/${LABEL} || /bin/launchctl print gui/$uid/${LABEL} || /bin/launchctl print user/$uid/${LABEL}; } >/dev/null 2>&1 && [ $i -lt 50 ]; do /bin/sleep 0.1; i=$((i+1)); done`;

/**
 * The root script that turns it on: writes `plist` as root's file (the user it runs as set here, whatever the text said), unloads the
 * user's agent and any older daemon, and loads the daemon. Prints `turned-on` when it did. `sameUser`: refuse unless sudo was run by
 * that user (the app's own run over ssh); a command copied for an administrator to run leaves it out.
 * @param {{ plist: string, user: string, sameUser: boolean }} o
 */
export function turnOnScript({ plist, user, sameUser }) {
  if (!USER.test(user) || user === 'root') throw new Error('That user cannot run the Host.');
  const b64 = Buffer.from(plist, 'utf8').toString('base64');
  return [
    `U='${user}'`,
    'uid=$(/usr/bin/id -u "$U") || exit 3',
    '[ "$uid" -gt 0 ] || exit 3',
    ...(sameUser ? ['[ "$SUDO_USER" = "$U" ] || exit 3'] : []),
    `t=$(/usr/bin/mktemp /Library/LaunchDaemons/.${LABEL}.XXXXXX) || exit 4`,
    `{ printf %s '${b64}' | /usr/bin/base64 -D > "$t" && /usr/bin/plutil -replace UserName -string "$U" "$t" && { /usr/bin/plutil -remove GroupName "$t" 2>/dev/null; true; } && /usr/bin/plutil -lint -s "$t" && /usr/sbin/chown root:wheel "$t" && /bin/chmod 644 "$t"; } || { /bin/rm -f "$t"; exit 4; }`,
    `/bin/launchctl bootout system/${LABEL} 2>/dev/null; /bin/launchctl bootout gui/$uid/${LABEL} 2>/dev/null; /bin/launchctl bootout user/$uid/${LABEL} 2>/dev/null`,
    GONE,
    `/bin/mv -f "$t" ${DAEMON_PLIST} && /bin/launchctl bootstrap system ${DAEMON_PLIST} && echo turned-on`,
  ].join('\n');
}

/** The root script that turns it off: unloads the daemon and removes its plist. Prints `turned-off` when it did. */
export function turnOffScript() {
  return ['uid=0', `/bin/launchctl bootout system/${LABEL} 2>/dev/null`, GONE, `/bin/rm -f ${DAEMON_PLIST} && echo turned-off`].join('\n');
}

/** A root script as one command line a person can paste at the machine. @param {string} script */
export const sudoCommand = (script) => `sudo /bin/sh -c '${script.split('\n').join('; ').replace(/'/g, `'\\''`)}'`;
