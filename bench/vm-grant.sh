#!/bin/zsh
# Grants, inside the benchmark VM only (SIP off), the macOS privacy permissions the benchmark drivers and the agents'
# computer-use components need, by writing TCC rows with each program's code requirement. Refuses to run on a real Mac.
# Usage (in the VM, by a person, once per base image): zsh bench/vm-grant.sh; then restart the VM.
set -eu
[[ "$(sysctl -n kern.hv_vmm_present 2>/dev/null)" == 1 ]] || { echo "not a virtual machine: vm-grant.sh never runs on a real Mac" >&2; exit 1; }
SYS="/Library/Application Support/com.apple.TCC/TCC.db"
USR="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
MOPILOT_DIR=${MOPILOT_DIR:-$HOME/mopilot}
REQ=$(mktemp -t req)

# hex of a program's designated requirement, compiled; NULL when it has none
req() {
  local r
  r=$(codesign -dr - "$1" 2>/dev/null | sed -n 's/^designated => //p') || true
  [[ -n $r ]] || { echo NULL; return; }
  csreq -r="$r" -b "$REQ" && echo "X'$(xxd -p "$REQ" | tr -d '\n')'"
}

# command-line clients, granted by path (client_type 1)
clients=(/opt/homebrew/bin/tart-guest-agent /opt/homebrew/bin/cliclick /usr/bin/osascript /bin/zsh /bin/bash /usr/sbin/screencapture /opt/homebrew/opt/node@24/bin/node /opt/homebrew/bin/python3)
# app bundles granted by bundle id (client_type 0): MoPilot's computer-use helper, Claude Desktop, ChatGPT and its
# computer-use service; a missing bundle is skipped
bundles=("$MOPILOT_DIR/native/helper/build/MoPilot.app" /Applications/Claude.app /Applications/ChatGPT.app "$HOME/.codex/computer-use/Codex Computer Use.app")
# apps the clients may send Apple events to
targets=(/System/Library/CoreServices/System\ Events.app /System/Applications/Notes.app /System/Applications/Reminders.app /System/Applications/Calendar.app /System/Applications/Contacts.app /System/Library/CoreServices/Finder.app /System/Applications/TextEdit.app /System/Applications/Preview.app /System/Applications/System\ Settings.app /System/Applications/Automator.app /Applications/Claude.app /Applications/ChatGPT.app /Applications/Google\ Chrome.app /System/Applications/Utilities/Terminal.app)

for c0 in $clients $bundles; do
  [[ -e $c0 ]] || { echo "skip missing $c0" >&2; continue; }
  if [[ -d $c0 && $c0 == *.app ]]; then c=$(defaults read "$c0/Contents/Info" CFBundleIdentifier); ctype=0; else c=$(realpath "$c0"); ctype=1; fi
  cr=$(req "$c0")
  row() { # db service [target-id target-req]; replaces any existing (for example denied) row
    local db=$1 s=$2 tid=${3:-UNUSED} treq=${4:-NULL} ttype=NULL
    [[ $tid == UNUSED ]] || ttype=0
    sudo sqlite3 "$db" "DELETE FROM access WHERE service='$s' AND client='$c' AND indirect_object_identifier='$tid';
      INSERT INTO access (service,client,client_type,auth_value,auth_reason,auth_version,csreq,flags,indirect_object_identifier_type,indirect_object_identifier,indirect_object_code_identity)
      VALUES ('$s','$c',$ctype,2,4,1,$cr,0,$ttype,'$tid',$treq);"
  }
  for s in kTCCServiceAccessibility kTCCServiceScreenCapture kTCCServicePostEvent kTCCServiceListenEvent kTCCServiceSystemPolicyAllFiles; do row "$SYS" $s; done
  for s in kTCCServiceAddressBook kTCCServiceCalendar kTCCServiceReminders kTCCServicePhotos kTCCServiceSystemPolicyDocumentsFolder kTCCServiceSystemPolicyDesktopFolder kTCCServiceSystemPolicyDownloadsFolder; do row "$USR" $s; done
  for t in $targets; do
    [[ -d $t ]] || continue
    row "$USR" kTCCServiceAppleEvents "$(defaults read "$t/Contents/Info" CFBundleIdentifier)" "$(req "$t")"
  done
done
rm -f "$REQ"
sudo chown "$USER" "$USR"
sudo killall tccd 2>/dev/null || true
killall tccd 2>/dev/null || true
echo granted
