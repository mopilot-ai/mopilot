// The Claude Code items main translated (electron/harness/items/claude.cjs), shown in this window.
import { applyNotification } from '../../../store/notifications';
import { createStreamNotifications } from '../../../lib/streamNotifications';
import { claudeNotifications } from '../claudeNotifications';
import { flushSessionPatches } from '../../../store/session/useSession';
import { native } from '../../../lib/native';

/** What the items show: text and thinking deltas once per frame, everything else in order at once (lib/streamNotifications.ts). */
// Main's SDK events record activity before these translated display items arrive.
const display = createStreamNotifications((method, params) => applyNotification(method, params, false));

/** Before an event that is not a delta: the text shown so far, and the session patches main sent before it (a crash, #2847). */
export function flushHeld() {
  display.flush();
  flushSessionPatches();
}

/** Main's items (claude:items), from startClaude on. */
export const showMainItems = () => native.claude.onItems((e) => claudeNotifications(e.key, display.emit)(e.method, e.params));
