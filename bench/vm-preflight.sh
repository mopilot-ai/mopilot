#!/bin/zsh
# Read-only preflight for a benchmark run inside the VM (bench/README.md, docs/control-plane/benchmark.md): lists every
# login, app, profile and port a run needs, so a person is asked once for all that is missing. Changes nothing.
# Usage (in the VM): zsh ~/mopilot/bench/vm-preflight.sh [mgb|edge]
emulate -L zsh
setopt no_unset pipe_fail
what=${1:-mgb}
missing=()
ok() { print -r -- "ok      $1"; }
miss() { print -r -- "MISSING $1"; missing+=("$1"); }
have() { command -v "$1" >/dev/null 2>&1; }

if [[ "$(sysctl -n kern.hv_vmm_present 2>/dev/null)" != 1 ]]; then
  print -r -- 'not a virtual machine: this preflight is for the benchmark VM only'
  exit 2
fi

# tools the drivers call
for t in node cliclick git gh; do have $t && ok "$t $(${t} --version 2>/dev/null | head -1)" || miss "$t on PATH"; done

# harness logins (each CLI answers without a network turn)
if have claude; then
  claude auth status 2>/dev/null | grep -q '"loggedIn": true' && ok 'Claude Code signed in' || miss 'Claude Code sign-in (claude login)'
else
  miss 'Claude Code CLI'
fi
if have codex; then
  codex login status 2>&1 | grep -qi 'logged in' && ok 'Codex signed in' || miss 'Codex sign-in (codex login)'
else
  miss 'Codex CLI'
fi
have opencode && ok "opencode $(opencode --version 2>/dev/null | head -1)" || miss 'opencode CLI (the ACP column: npm i -g opencode-ai)'
gh auth status >/dev/null 2>&1 && ok 'gh signed in' || miss 'gh sign-in'

# the installed app's data folder is marked as a test install, so its usage data stays out of the analytics (bench/vm-mark-test.sh)
[[ "$(cat "$HOME/Library/Application Support/MoPilot/install-origin" 2>/dev/null)" == test ]] && ok 'MoPilot data folder marked as a test install' || miss 'test-install marker (zsh ~/mopilot/bench/vm-mark-test.sh)'

# the vendor apps (native arms) and Chrome
for app in Claude ChatGPT 'Google Chrome'; do
  plist="/Applications/${app}.app/Contents/Info.plist"
  if [[ -f $plist ]]; then ok "${app}.app $(defaults read "/Applications/${app}.app/Contents/Info" CFBundleShortVersionString 2>/dev/null)"; else miss "${app}.app"; fi
done

# the comparison Chrome profile (a copy of the user's signed-in profile) with both vendor extensions' native hosts
profile=${MGB_CHROME_PROFILE:-$HOME/mgb-scratch-chrome}
[[ -d $profile ]] && ok "Chrome profile $profile" || miss "Chrome profile $profile"
hosts="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
ls "$hosts" 2>/dev/null | grep -qi anthropic && ok 'Claude in Chrome native host' || miss 'Claude in Chrome native host manifest'
ls "$hosts" 2>/dev/null | grep -qi openai && ok 'ChatGPT for Chrome native host' || miss 'ChatGPT for Chrome native host manifest'

# the MoPilot checkout and its build
[[ -d $HOME/mopilot/node_modules ]] && ok "~/mopilot at $(git -C $HOME/mopilot log --oneline -1 2>/dev/null)" || miss '~/mopilot with node_modules (npm ci)'
if [[ $what == mgb ]]; then
  # the built-in Mac apps the F4/F5 tasks seed and grade (their spreadsheets are CSV files: Numbers needs the App
  # Store, which a benchmark VM cannot sign in to)
  for app in Calendar Reminders Notes; do
    [[ -d /Applications/${app}.app || -d /System/Applications/${app}.app ]] && ok "${app}.app" || miss "${app}.app (the F4/F5 tasks use it)"
  done
  [[ -f $HOME/mopilot/bench/mgb-run.mjs ]] && ok 'the 12-Grid Bench is in the checkout' || miss 'bench/mgb-run.mjs in ~/mopilot (check out a commit that has it)'
  [[ -d $HOME/mopilot/dist ]] && ok 'MoPilot built (dist)' || miss 'MoPilot build (npm run build) for the MoPilot arms'
  ports=(8820 8830 9381 9382 9383)
else
  ports=(8790 8791 9371 9372 9373)
fi

# ports a run would start servers or instances on
for p in $ports; do
  if lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then print -r -- "busy    port $p ($(lsof -nP -iTCP:$p -sTCP:LISTEN | awk 'NR==2{print $1" pid "$2}'))"; else ok "port $p free"; fi
done

# the shared lock is the host's ~/.mopilot-vm.lock (on the Mac that runs Tart), taken before this preflight runs: it
# cannot be seen from inside the VM, so it is not checked here

# computer use needs a recently active session (an idle Mac refuses as unattended)
idle=$(( $(ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF; exit}') / 1000000000 ))
print -r -- "info    HID idle ${idle} s (the drivers nudge the pointer before computer-use turns)"

if (( ${#missing} )); then
  print -r -- ''
  print -r -- "Ask once for everything missing (${#missing}):"
  for m in $missing; do print -r -- "- $m"; done
  exit 1
fi
print -r -- ''
print -r -- 'preflight: ready'
