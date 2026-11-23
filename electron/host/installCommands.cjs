// The commands an add-machine run sends (electron/host/install.cjs): where the Host's files go, the service start and its undo, lingering on Linux, and putting an uploaded tarball in place.
const { launchdStart, launchdStop } = require('../../shared/host/launchd.mjs');
const { quote } = require('./daemonInstall.cjs');
const { HOST_NODE } = require('./installRuntime.cjs');

/** Where the Host's files go on the machine: `versions/<sha256>` unpacked, `current` pointing at the one in use, `incoming` for the upload. */
const HOST_HOME = '$HOME/.mopilot-host';
/** The Host's executable inside `current`. */
const BUNDLE_BIN = `${HOST_HOME}/current/host/bin/mopilot-host.mjs`;
/** The Node the Host runs on, as a shell word: MoPilot's once an install put it there, else (a Host installed before that) the machine's `node`. */
const HOST_RUN_NODE = `"$([ -x "${HOST_NODE}" ] && echo "${HOST_NODE}" || echo node)"`;
/** How the Host's CLI is run on the machine. */
const HOST_CLI = `${HOST_RUN_NODE} "${BUNDLE_BIN}"`;
/** The command that starts the service on `os` (the name `uname -s` gave), or restarts it onto the version just unpacked when it already runs (`enable --now` leaves a running unit as it is). @param {string} os */
function startCommand(os) {
  return os === 'Darwin'
    ? launchdStart('"$HOME/Library/LaunchAgents/ai.mopilot.host.plist"')
    : 'systemctl --user daemon-reload && systemctl --user enable mopilot-host && systemctl --user restart mopilot-host';
}

/**
 * The command that stops the service, removes its unit and puts the files back as this run found them; each part is allowed to find nothing.
 * @param {string} os @param {string} cli how the Host is run on the machine @param {string} [undo] what to put back of the files
 */
function rollbackCommand(os, cli, undo = '') {
  const stop = os === 'Darwin' ? launchdStop() : `systemctl --user disable --now mopilot-host 2>/dev/null; ${LINGER_UNDO}`;
  return `${stop}; ${cli} uninstall${undo ? `; ${undo}` : ''}`;
}

/** Marks that this app turned lingering on, so only lingering it turned on is turned off again. */
const LINGER_MARK = `${HOST_HOME}/linger-on`;
/** Prints `on` when the user's systemd manager lingers (keeps running with nobody signed in). */
const LINGERS = '[ "$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null)" = yes ] && echo on';
/**
 * Linux: a systemd user service stops when its user signs out and starts only when they sign in, unless the user's manager lingers.
 * Lingering for oneself needs no administrator under systemd's own polkit rule (org.freedesktop.login1.set-self-linger); a system
 * that asks for one leaves the Host as it was, with the command that fixes it.
 */
const LINGER_ON = `if ${LINGERS} >/dev/null; then echo already; elif loginctl enable-linger "$(id -un)" >/dev/null 2>&1 && ${LINGERS} >/dev/null; then mkdir -p "${HOST_HOME}" && touch "${LINGER_MARK}"; echo turned-on; else echo refused; fi`;
/** Lingering goes again only when this app turned it on. */
const LINGER_UNDO = `if [ -f "${LINGER_MARK}" ]; then loginctl disable-linger "$(id -un)" 2>/dev/null; rm -f "${LINGER_MARK}"; fi`;

/** The commands that put a tarball on the machine: upload to `incoming`, check its SHA-256, unpack into `versions/<sha>` (unless it is there) and point `current` at it. @param {string} sha */
function bundleCommands(sha) {
  const file = `${HOST_HOME}/incoming/${sha}.tgz`;
  const dir = `${HOST_HOME}/versions/${sha}`;
  const current = `${HOST_HOME}/current`;
  return {
    file,
    upload: `mkdir -p "${HOST_HOME}/incoming" && cat > "${file}"`,
    verify: `h=$( (sha256sum "${file}" 2>/dev/null || shasum -a 256 "${file}") | cut -d' ' -f1 ); if [ "$h" = "${sha}" ]; then echo "$h"; else rm -f "${file}"; echo "got $h" >&2; exit 1; fi`,
    unpack:
      `prev=$(readlink "${current}" 2>/dev/null || true); ` +
      `if [ -f "${dir}/host/bin/mopilot-host.mjs" ]; then made=no; ` +
      `else rm -rf "${dir}.tmp" && mkdir -p "${dir}.tmp" && tar -xzf "${file}" --no-same-owner --no-same-permissions -C "${dir}.tmp" && mv "${dir}.tmp" "${dir}" || { rm -rf "${dir}.tmp"; exit 1; }; made=yes; fi; ` +
      `ln -sfn "${dir}" "${current}" && rm -f "${file}" && echo "made=$made prev=$prev"`,
    /** What puts the files back: `current` where it pointed (or away), and the version this run unpacked removed. @param {boolean} made @param {string} prev */
    undo: (made, prev) => `${prev ? `ln -sfn ${quote(prev)} "${current}"` : `rm -f "${current}"`}${made ? `; rm -rf "${dir}"` : ''}`,
  };
}

module.exports = {
  HOST_HOME,
  BUNDLE_BIN,
  HOST_RUN_NODE,
  HOST_CLI,
  startCommand,
  rollbackCommand,
  bundleCommands,
  LINGER_ON,
  LINGER_UNDO,
};
