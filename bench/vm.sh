#!/bin/zsh
# Host-side look at the benchmark VM's screen without VNC: `bench/vm.sh shot [name]` saves a 1200 px screenshot to
# $BENCH_SHOTS (default bench/results/shots); `click X Y` clicks at screenshot coordinates (scaled to the screen);
# `type TEXT`, `key KEY` (cliclick kp: names such as return, esc); `run CMD...` runs a command in the GUI session.
set -eu
zmodload zsh/mathfunc
VM=${MOPILOT_VM:-mopilot-bench}
# a plain name only: `tart` joins it onto its VM directory, so "x/../mopilot-bench" would reach another machine (the vm-name rule of shared/vmName.mjs); the letters are spelled out because a range like A-Za-z can match accented ones in some locales
alnum=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789
name_re="^[${alnum}][${alnum}._-]*\$"
if [[ ! "$VM" =~ $name_re || "$VM" == *..* || ${#VM} -gt 64 ]]; then print -u2 "bench/vm.sh: MOPILOT_VM is not a plain VM name (got '$VM')"; exit 2; fi
U=${BENCH_GUI_UID:-501}
SHOTS=${BENCH_SHOTS:-${0:A:h}/results/shots}
gui() { tart exec "$VM" zsh -lc "launchctl asuser $U $*"; }
case ${1:-} in
  shot)
    mkdir -p "$SHOTS"
    tart exec "$VM" zsh -lc "f=\$(mktemp -t s).png; launchctl asuser $U /usr/sbin/screencapture -x \$f; sips -Z 1200 \$f >/dev/null; base64 -i \$f; rm -f \$f" | base64 -d > "$SHOTS/${2:-shot}.png"
    echo "$SHOTS/${2:-shot}.png" ;;
  click)
    # screenshot pixels -> screen points: the desktop's width in points over the 1200 px screenshot
    S=$(gui "osascript -e 'tell application \"Finder\" to get item 3 of (get bounds of window of desktop)'")
    S=$(( S / 1200.0 ))
    gui /opt/homebrew/bin/cliclick c:$(( int($2 * S) )),$(( int($3 * S) )) ;;
  type) gui /opt/homebrew/bin/cliclick "t:${(q)2}" ;;
  key) gui /opt/homebrew/bin/cliclick kp:$2 ;;
  run) shift; gui "$@" ;;
  *) echo "usage: bench/vm.sh shot [name] | click X Y | type TEXT | key KEY | run CMD..." >&2; exit 2 ;;
esac
