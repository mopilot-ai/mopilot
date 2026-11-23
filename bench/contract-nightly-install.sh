#!/bin/zsh
# Sets up the harness version contract nightly inside the benchmark VM (VM only): a checkout of its own at
# ~/mopilot-nightly that commits as the signed-in GitHub account. Nothing is scheduled here: the host starts each night
# (contract-nightly-host-install.sh), so it takes the host's VM lock like every other VM user. Needs `gh auth login`.
set -euo pipefail
[[ "$(sysctl -n kern.hv_vmm_present 2>/dev/null)" == 1 ]] || { echo "contract-nightly-install.sh runs only inside the benchmark VM" >&2; exit 2; }
export PATH=/opt/homebrew/bin:/opt/homebrew/opt/node@24/bin:$HOME/.local/bin:$PATH
gh auth status >/dev/null 2>&1 || { echo "sign in to GitHub first: gh auth login (HTTPS, repo scope)" >&2; exit 2; }
gh auth setup-git
CHECKOUT=$HOME/mopilot-nightly
[[ -d $CHECKOUT/.git ]] || gh repo clone mopilot-ai/mopilot-internal "$CHECKOUT" -- --quiet
# the pull requests it opens are committed as the signed-in GitHub account
LOGIN=$(gh api user --jq .login)
ID=$(gh api user --jq .id)
git -C "$CHECKOUT" config user.name "$LOGIN"
git -C "$CHECKOUT" config user.email "$ID+$LOGIN@users.noreply.github.com"
node "$CHECKOUT/scripts/hook-check.mjs" >/dev/null 2>&1 || true
mkdir -p "$HOME/contract"
# an agent an earlier version of this script installed here would run without the host's lock
launchctl bootout "gui/$(id -u)/ai.mopilot.harness-contract" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/ai.mopilot.harness-contract.plist"
echo "ready: $CHECKOUT. Schedule the nights from the host: zsh bench/contract-nightly-host-install.sh"
