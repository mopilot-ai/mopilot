#!/bin/zsh
# Marks the benchmark VM's MoPilot data folder as a test install (installOrigin in electron/platform/install.cjs): the app then
# reports origin "test" with its install ping and usage data, and the web analytics leave this install out. Run once in the base
# VM image (clones inherit the file). A user's Mac never runs this. Usage (in the VM): zsh ~/mopilot/bench/vm-mark-test.sh
emulate -L zsh
setopt no_unset pipe_fail
if [[ "$(sysctl -n kern.hv_vmm_present 2>/dev/null)" != 1 ]]; then
  print -r -- 'not a virtual machine: this marks the benchmark VM only'
  exit 2
fi
dir="$HOME/Library/Application Support/MoPilot"
mkdir -p "$dir"
print -r -- test > "$dir/install-origin"
print -r -- "marked: $dir/install-origin"
