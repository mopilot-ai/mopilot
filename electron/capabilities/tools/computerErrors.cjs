// Computer-helper error normalization and missing-permission identification.
const { ToolError } = require('../contract/registry.cjs');
const { TRY_AGAIN } = require('../../../shared/uiLabels.mjs');

const PERMISSION_IDS = ['accessibility', 'screenRecording', 'inputMonitoring'];

/** The macOS permission a helper error says is missing, or null. */
function missingPermission(e) {
  if (e?.reason === 'guard_unavailable') return 'accessibility';
  if (e?.reason !== 'permission_denied') return null;
  return PERMISSION_IDS.find((id) => String(e.message).includes(id)) || null;
}

/** The next step for a helper that couldn't start: Settings → Computer use offers its retry (capabilityHealth computer.start). */
const CHECK = `open Settings → Computer use and choose "${TRY_AGAIN}"`;
/** Any other failure: the page says what's wrong, with a button only when there is something to do. */
const LOOK = 'open Settings → Computer use, which says what is wrong';
/** A scheduled task without computer control, and where its person turns it on. */
const SCHEDULED_OFF =
  "Computer control is off for this scheduled task. The user can turn on 'Allow computer control' in the task's settings (Scheduled, then Edit).";

/** What a helper error means for the model. */
function helperError(e) {
  switch (e?.reason) {
    case 'permission_denied':
      return Object.assign(
        new ToolError(
          `${e.message}. macOS reports that access is unavailable to "MoPilot". If its switch is already on, the permission has not taken effect for this helper; check the permission guide in this chat.`,
          'permission',
        ),
        { permission: missingPermission(e) },
      );
    case 'target_refused':
      return new ToolError(`MoPilot won't do that: ${e.message}`, 'refused');
    case 'paused':
      return new ToolError('The user took over the mouse or keyboard, so the agent is paused until they resume.', 'paused');
    case 'aborted':
      return new ToolError(e.message, 'stopped');
    case 'lock_busy':
      return new ToolError(e.message, 'busy');
    // element_index names an element of the latest screenshot; the app's UI has changed since
    case 'element_changed':
    case 'element_gone':
      return new ToolError(
        `The element changed since the latest screenshot (${e.message.replace(/; take a new (app_)?screenshot$/, '')}), so nothing was done. Take a new desktop_screenshot and pick the element again.`,
        'changed',
      );
    case 'no_windows':
      // the helper waited about a second for a window to come on screen before saying so
      return new ToolError(
        'Nothing to capture: the app has no window on screen (it may still be opening, be hidden, or be on another Space). Bring it forward or open a window in it, then take the screenshot again.',
        'unavailable',
      );
    case 'capture_failed':
      // the helper already refreshed the window list and retried once
      return new ToolError(
        `The screenshot failed twice in a row (${e.message}). Wait a moment and take it again; if it keeps failing, check that "MoPilot" still has Screen Recording permission in System Settings.`,
        'failed',
      );
    // the helper exited during an input call and was relaunched: the call may have happened, so look again
    case 'helper_restarted':
      return new ToolError(e.message, 'changed');
    case 'helper_unavailable':
      return new ToolError(`Computer use isn't available: ${e.message} Ask the user to ${CHECK}.`, 'unavailable');
    case 'helper_stopped':
    case 'helper_not_running':
      return new ToolError(
        'The computer-use helper stopped. MoPilot relaunches it on the next call: take a fresh screenshot, then try again.',
        'unavailable',
      );
    case 'guard_unavailable':
      return Object.assign(
        new ToolError(
          'MoPilot needs Accessibility permission to stop the agent instantly; the user has to allow it in System Settings before agents can control the Mac.',
          'permission',
        ),
        { permission: 'accessibility' },
      );
    default:
      return new ToolError(`Computer use failed: ${e?.message ?? e}. Try once more; if it fails again, ask the user to ${LOOK}.`, 'failed');
  }
}

module.exports = { missingPermission, helperError, PERMISSION_IDS, SCHEDULED_OFF };
