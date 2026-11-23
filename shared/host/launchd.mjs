// The shell lines that start and stop the Host's launchd agent on a Mac: bootstrap into the logged-in user's GUI domain (the user domain when nobody is logged in) and then kickstart it, because a job loaded from an ssh session is registered but never started (RunAtLoad does not fire there, macOS 26+). A Mac that keeps the Host running after a restart runs it as a system daemon instead (./launchDaemon.mjs): starting then means restarting that daemon's Host, never loading a second copy as an agent.

import { DAEMON_PLIST } from './launchDaemon.mjs';

export const LAUNCHD_LABEL = 'ai.mopilot.host';

/** Sets D to the domain the agent lives in: the GUI session's when there is one (the keychain and sign-ins are there), else the background user domain. */
const DOMAIN = 'U=$(id -u); D=gui/$U; launchctl print "$D" >/dev/null 2>&1 || D=user/$U';
/** Removes the agent and waits (up to 5 s) until launchd let go of it; bootstrap refuses a label that is still there. */
const BOOTOUT = `launchctl bootout "$D/${LAUNCHD_LABEL}" 2>/dev/null; i=0; while launchctl print "$D/${LAUNCHD_LABEL}" >/dev/null 2>&1 && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done`;
/**
 * The daemon's Host, ended so launchd starts it again (KeepAlive) on the files just installed: only root may kickstart a system job,
 * but the Host runs as this user, who may signal it. Nothing running is not an error.
 */
const RESTART_DAEMON_HOST = `pkill -TERM -U "$(id -u)" -f 'mopilot-host.mjs serve' 2>/dev/null; true`;

/**
 * What starting the agent prints when nobody is signed in at the Mac as this user: launchd has no GUI domain then and refuses the agent
 * in the background one ("Bootstrap failed: 5: Input/output error", macOS 26). shared/host/installFailure.mjs reads it.
 */
export const NO_GUI_SESSION = 'MoPilot: nobody is signed in at this Mac.';

/** Load the agent from `plist` (already one shell word) and start it, replacing a running one so it runs the files just installed; on a Mac that runs the Host as a system daemon, restart that one instead. Fails (without leaving the shell) when it could not. @param {string} plist */
export function launchdStart(plist) {
  return `if [ -f ${DAEMON_PLIST} ]; then ${RESTART_DAEMON_HOST}; else ${DOMAIN}; ${BOOTOUT}; launchctl bootstrap "$D" ${plist} && launchctl kickstart -k "$D/${LAUNCHD_LABEL}" || { case "$D" in user/*) echo '${NO_GUI_SESSION}' >&2;; esac; false; }; fi`;
}

/** Stop and unload the agent; an agent that is not loaded is already stopped. */
export function launchdStop() {
  return `${DOMAIN}; ${BOOTOUT}; true`;
}
