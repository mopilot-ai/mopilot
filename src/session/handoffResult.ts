// What the renderer does once a "Continue in Chrome" hand-off succeeded: the browser channel follows Your Chrome, and a change to the saved Preferred browser is said with a way back (#1523 §3).
import { get as getState, setPrefs, toast } from '../store/core';
import { navigate } from '../store/panes';
import { PREFERRED_CHANGED, opensInUserChrome, type HandoffRoute } from '../../shared/chromeHandoff.mjs';

/** The hand-off notice's line on what going ahead does to the saved Preferred browser. */
export { PREFERRED_WILL_CHANGE } from '../../shared/chromeHandoff.mjs';

/** Whether the saved Preferred browser is Chrome already (a hand-off then changes nothing, whatever the live channel). */
export const savedChrome = () => getState().prefs.browserChannel === 'chrome';

/**
 * Applies a successful hand-off's result from main (handoff.cjs) to the renderer: only Your Chrome switches the browser
 * channel (the other routes open the site in the user's Chrome), and when that changed the saved Preferred browser the
 * user is told, with Browser settings to change it back. The pane and the ways-forward strip both call it.
 */
export function applyHandoffResult(route: HandoffRoute, preferredChanged: boolean | undefined) {
  if (opensInUserChrome(route)) return;
  setPrefs({ browserChannel: 'chrome' });
  if (preferredChanged)
    toast(PREFERRED_CHANGED, 'info', {
      action: { label: 'Browser settings', run: () => navigate({ name: 'settings', section: 'browser' }) },
    });
}
