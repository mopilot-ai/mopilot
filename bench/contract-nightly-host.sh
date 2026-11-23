#!/bin/zsh
# One night of the harness version contract, started on the host (the host's LaunchAgent, contract-nightly-host-install.sh)
# so that it takes the host's VM lock like every other VM user: it waits for ~/.mopilot-vm.lock (up to 3 hours), skips
# the night when the VM is not running (it never starts one), runs bench/contract-nightly.mjs in the VM from merged main,
# waits for it, and releases the lock. The version checks themselves run in the VM; the host only takes the lock.
# Arguments go to the nightly as they are (the LaunchAgent passes none): `--dry-run --harnesses none` exercises the
# whole trigger (lock, VM, checkout, detached start, wait) without running a contract.
set -u
REPO=${0:A:h:h}
VM=${MOPILOT_VM:-mopilot-bench}
LOCK=$HOME/.mopilot-vm.lock
LOG=$HOME/Library/Logs/mopilot-contract-nightly.log
mkdir -p "${LOG:h}"
exec >> "$LOG" 2>&1
echo "== $(date -u +%FT%TZ) night starts${*:+ (arguments: $*)}"

# one VM user at a time: wait for the lock, give the night up after 3 hours. The owner line starts with this night's
# own tag, and the lock is released only while it still does (as ~/bench/runner/vmlock.sh does): a lock someone else
# took meanwhile is never removed.
TAG="#1321 contract-nightly (host LaunchAgent, pid $$)"
for i in {1..36}; do
  if mkdir "$LOCK" 2>/dev/null; then
    print -r -- "$TAG $(date -u +%FT%TZ)" > "$LOCK/owner"
    break
  fi
  [[ $i == 36 ]] && { echo "the VM lock stayed taken ($(cat "$LOCK/owner" 2>/dev/null)); no night tonight"; exit 0; }
  sleep 300
done
release() {
  local owner
  owner=$(cat "$LOCK/owner" 2>/dev/null)
  if [[ "$owner" == "$TAG"* ]]; then rm -rf "$LOCK"; else echo "not releasing the VM lock: it is held by: ${owner:-nobody}"; fi
}
trap release EXIT

if ! tart list 2>/dev/null | awk -v vm="$VM" '$2 == vm && /running/' | grep -q .; then
  echo "$VM is not running; the nightly never starts a VM"
  exit 0
fi

# merged main only: the night's own code comes from main, and the night brings the checkout to main again itself
"$REPO/scripts/vm-exec.sh" zsh -lc "cd ~/mopilot-nightly && git fetch --quiet origin main && git checkout --quiet --force --detach origin/main" ||
  { echo "could not bring ~/mopilot-nightly to origin/main"; exit 0; }
"$REPO/scripts/vm-exec.sh" zsh -lc "cd ~/mopilot-nightly && nohup node bench/contract-nightly.mjs ${(j: :)${(q)@}} < /dev/null >> ~/contract/nightly.log 2>&1 & echo started"

# the night can take hours; a disconnected tart exec must not stop it, so it runs detached and is waited for here
sleep 30
for i in {1..1440}; do
  "$REPO/scripts/vm-exec.sh" pgrep -f bench/contract-nightly.mjs > /dev/null || break
  sleep 60
done
echo "== $(date -u +%FT%TZ) night ends"
"$REPO/scripts/vm-exec.sh" zsh -lc "tail -c 2000 ~/contract/nightly.log"
