#!/bin/bash
# DEV ONLY: the Mobile Remote journey on a real iPhone or a simulator: sign in, pair and compare safety numbers, the chat list, a chat, an approval, a plan, changes, terminal, a new chat, settings, background and relaunch, the Mac dropping off, revoking and pairing again.
# Usage:
#   MOPILOT_WDA_BASE=<WebDriverAgent url> scripts/mobile-ios-journey.sh <phone|sim> [--out <dir>] [--only <step,step>] [--list]
#   scripts/mobile-ios-journey.sh host <start|stop|status>     the dev host the journey drives (started with --ask, so the safety numbers can be compared)
# phone: MOPILOT_IOS_UDID is the device; MOPILOT_WDA_BASE defaults to its tunnel address on :8100 (scripts/mobile-ios-wda.sh run). sim: MOPILOT_WDA_BASE is required; MOPILOT_SIM (default "booted") is the simulator.
# The app is loaded from the Metro at MOPILOT_METRO (default http://<this Mac's LAN address>:8081), started with MOPILOT_DEV_HOST set to the host's address.
# Screenshots go to <out> (default $TMPDIR/mopilot-journey/journey-<time>/); the exit status is non-zero and the last line names the step that failed.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
state="${MOPILOT_JOURNEY_DIR:-${TMPDIR:-/tmp}/mopilot-journey}"
fifo="$state/host.fifo"
log="$state/host.log"
pidfile="$state/host.pid"
# the host's log holds pairing codes and safety numbers: keep the folder and what is in it to this user
umask 077
mkdir -p "$state"
chmod 700 "$state"
# the pid of the dev host this script started, only while that pid is still that host (a pid file can outlive a crash or a reboot, and the number may then belong to another process)
hostpid() {
  [ -s "$pidfile" ] || return 1
  ps -o command= -p "$(cat "$pidfile")" 2>/dev/null | grep -q 'mobile-dev-host\.mjs' && cat "$pidfile"
}
journey() { exec node --input-type=module -e "import { main } from '$root/scripts/mobile-ios-journey/cli.mjs'; process.exitCode = await main(process.argv.slice(1));" -- "$@"; }
case "${1:?usage: mobile-ios-journey.sh <phone|sim|host> ...}" in
host)
  case "${2:?usage: mobile-ios-journey.sh host <start|stop|status>}" in
  start)
    if pid="$(hostpid)"; then echo "dev host already running (pid $pid)"; exit 0; fi
    rm -f "$fifo" "$pidfile"
    mkfifo "$fifo"
    # opened read-write, so the host's input never sees an end of file when a writer closes it
    exec 3<>"$fifo"
    nohup node "$root/scripts/mobile-dev-host.mjs" --ask <&3 >"$log" 2>&1 &
    echo $! >"$pidfile"
    exec 3>&-
    sleep 6
    if ! hostpid >/dev/null; then
      echo "the dev host did not start (is its port still held by the one just stopped?); its log:" >&2
      tail -n 8 "$log" >&2
      exit 1
    fi
    echo "dev host started (pid $(cat "$pidfile")); log $log"
    ;;
  stop)
    if pid="$(hostpid)"; then
      kill "$pid" 2>/dev/null || true
      # wait for it to let go of its port, so a start right after does not meet it
      for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    fi
    rm -f "$pidfile"
    echo "dev host stopped"
    ;;
  status)
    if pid="$(hostpid)"; then echo "running (pid $pid)"; else echo "not running"; exit 1; fi
    ;;
  *) echo "usage: mobile-ios-journey.sh host <start|stop|status>" >&2; exit 2 ;;
  esac
  ;;
phone | sim)
  target="$1"
  shift
  # naming the steps or the usage needs no device and no host
  case " $* " in *" --list "* | *" --help "*) journey "$@" ;; esac
  lan="$(ipconfig getifaddr en0 || true)"
  metro="${MOPILOT_METRO:-http://$lan:8081}"
  deeplink="mopilot://expo-development-client/?url=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$metro")"
  # the device, the simulator and the link are handed to the launch command as environment variables, never pasted into its text
  export MOPILOT_JOURNEY_URL="$deeplink"
  if [ "$target" = phone ]; then
    udid="${MOPILOT_IOS_UDID:?set MOPILOT_IOS_UDID to the device id}"
    if [ -z "${MOPILOT_WDA_BASE:-}" ]; then
      ip="$(xcrun devicectl device info details --device "$udid" 2>/dev/null | sed -n 's/.*Tunnel IP Address: *//p' | head -n 1)"
      [ -n "$ip" ] || { echo "no tunnel address for $udid; is the phone connected and unlocked? (or set MOPILOT_WDA_BASE)" >&2; exit 1; }
      export MOPILOT_WDA_BASE="http://[$ip]:8100"
    fi
    export MOPILOT_JOURNEY_DEVICE="$udid"
    export MOPILOT_JOURNEY_LAUNCH='xcrun devicectl device process launch --device "$MOPILOT_JOURNEY_DEVICE" --terminate-existing --payload-url "$MOPILOT_JOURNEY_URL" ai.mopilot.phone'
  else
    : "${MOPILOT_WDA_BASE:?set MOPILOT_WDA_BASE to the WebDriverAgent url of the simulator, for example http://127.0.0.1:8101}"
    export MOPILOT_JOURNEY_DEVICE="${MOPILOT_SIM:-booted}"
    export MOPILOT_JOURNEY_LAUNCH='xcrun simctl terminate "$MOPILOT_JOURNEY_DEVICE" ai.mopilot.phone; xcrun simctl openurl "$MOPILOT_JOURNEY_DEVICE" "$MOPILOT_JOURNEY_URL"'
  fi
  export MOPILOT_JOURNEY_FIFO="$fifo" MOPILOT_JOURNEY_LOG="$log"
  [ -p "$fifo" ] || { echo "the dev host is not running: scripts/mobile-ios-journey.sh host start" >&2; exit 1; }
  journey "$@"
  ;;
*) echo "usage: mobile-ios-journey.sh <phone|sim|host> ..." >&2; exit 2 ;;
esac
