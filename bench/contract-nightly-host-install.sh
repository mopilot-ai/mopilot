#!/bin/zsh
# Installs the harness version contract nightly's trigger on the host: a LaunchAgent that runs contract-nightly-host.sh
# every night at 03:00 from this checkout. Run it once, by hand, after contract-nightly-install.sh set up the VM.
set -euo pipefail
SCRIPT=${0:A:h}/contract-nightly-host.sh
[[ -x $SCRIPT ]] || chmod +x "$SCRIPT"
PLIST=$HOME/Library/LaunchAgents/ai.mopilot.harness-contract-host.plist
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.mopilot.harness-contract-host</string>
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>$SCRIPT</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/ai.mopilot.harness-contract-host" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed: $PLIST (03:00; log ~/Library/Logs/mopilot-contract-nightly.log). Remove with: launchctl bootout gui/$(id -u)/ai.mopilot.harness-contract-host && rm $PLIST"
