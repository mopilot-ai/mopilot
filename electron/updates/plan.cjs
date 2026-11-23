// What an app update check does: whether new prefs restart the schedule, and whether a macOS copy outside /Applications may check.

/** Whether new prefs change anything the schedule depends on. */
function prefsChanged(cur, next) {
  return !cur || cur.auto !== next.auto || cur.channel !== next.channel;
}

/**
 * What a check does: 'check' runs it; 'ask-move' asks to move to /Applications first (manual only,
 * and not again after Not Now); 'skip' does nothing (a scheduled check outside /Applications);
 * 'blocked' reports that updates need /Applications.
 */
function checkPlan({ manual, inApplications, declinedMove }) {
  if (inApplications) return 'check';
  if (!manual) return 'skip';
  return declinedMove ? 'blocked' : 'ask-move';
}

const NEEDS_APPLICATIONS = 'Move MoPilot to the Applications folder to receive updates.';

module.exports = { prefsChanged, checkPlan, NEEDS_APPLICATIONS };
