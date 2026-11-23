#!/usr/bin/env bash
# Runs one command inside an isolated macOS virtual machine (tart), where agents may start release-only suites (AGENTS.md).
# Usage: scripts/vm-exec.sh [--vm <name>] <command> [args...]. The machine is --vm, else MOPILOT_VM, else mopilot-bench
# (benchmarks, vendor runs, CU/BU); mopilot-cuj takes fake-based E2E/CUJ runs. Only mopilot-* machines: the release hook
# lets this command through unprefixed, so it must never reach another VM on the host. Each VM has its own lock
# (VMLOCK_VM=<name> ~/bench/runner/vmlock.sh), and a benchmark on mopilot-bench pauses the others on the same host
# (docs/unit-coverage.md). A VM listed in ~/.mopilot-vm-hosts (`<vm> <ssh destination> <identity file>`) runs on that
# Mac, so the command goes there over ssh; that file is the host's own, never in the repository.
set -euo pipefail
vm="${MOPILOT_VM:-mopilot-bench}"
if [[ "${1:-}" == --vm ]]; then
  vm="${2:-}"
  shift $(($# < 2 ? $# : 2))
fi
# a plain name only: `tart` joins the name onto its VM directory, so "mopilot-x/../mopilot-bench" would reach another machine
# (shared/vmName.mjs holds the same rule for the Host's driver). The letters are spelled out: a range like A-Za-z matches accented
# letters in some locales (glibc's en_US.UTF-8), and a name must not depend on the locale of whoever runs this.
alnum=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789
name_re="^mopilot-[${alnum}][${alnum}._-]*\$"
case "$vm" in
  mopilot-?*)
    if [[ ! "$vm" =~ $name_re || "$vm" == *..* || ${#vm} -gt 64 ]]; then
      echo "vm-exec: --vm must name a mopilot-* machine (got '${vm}')" >&2
      exit 2
    fi
    ;;
  *)
    echo "vm-exec: --vm must name a mopilot-* machine (got '${vm}')" >&2
    exit 2
    ;;
esac
# --stdin passes this command's standard input to the one in the machine (`tart exec -i`): bytes in, as for a file to write
stdin_flag=()
if [[ "${1:-}" == --stdin ]]; then
  stdin_flag=(-i)
  shift
fi
if [[ $# -eq 0 ]]; then
  echo "usage: scripts/vm-exec.sh [--vm <name>] [--stdin] <command> [args...]" >&2
  exit 2
fi
hosts="${MOPILOT_VM_HOSTS:-$HOME/.mopilot-vm-hosts}"
if [[ -f "$hosts" ]] && read -r _ dest key < <(awk -v v="$vm" '$1 == v' "$hosts") && [[ -n "${dest:-}" ]]; then
  key="${key/#\~/$HOME}"
  # the remote shell re-parses the line, so every argument is quoted for it
  exec ssh ${key:+-i "$key"} -o BatchMode=yes -o ConnectTimeout=10 "$dest" \
    "export PATH=\$HOME/.local/bin:/opt/homebrew/bin:\$PATH; tart exec ${stdin_flag[*]-} $(printf '%q ' "$vm" "$@")"
fi
exec tart exec ${stdin_flag[@]+"${stdin_flag[@]}"} "$vm" "$@"
