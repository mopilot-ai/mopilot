// Closes the motion fixture's Chrome window by AppleScript without starting Chrome: a tell starts an app that isn't running, which on an arm without Chrome left the VM's default profile on its picker (#3571).
import { appleString } from '../frontGuard.mjs';

/**
 * The osascript arguments that close the windows with this title, only if Chrome already runs.
 * @param {string} [title]
 * @returns {string[]}
 */
export const closeFixtureWindowsArgs = (title = 'Motion fixture') => [
  '-e',
  'if application "Google Chrome" is running then',
  '-e',
  `tell application "Google Chrome" to close (every window whose title is ${appleString(title)})`,
  '-e',
  'end if',
];

/**
 * The osascript arguments that bring the fixture's tab to the front of its Chrome window, and keeps Chrome in front of the screen (MoPilot's own window takes the front back while the chat updates), only if Chrome already runs
 * and only changes the active tab when that tab is not already the active one. The operator's step in a browser-extension recording (#4033): MoPilot's extension (like
 * Claude in Chrome's) opens the agent's tab in the background, where the screen recording shows no page and the page reports a screenY of the display's height.
 * @param {string} [title]
 * @returns {string[]}
 */
export const frontFixtureTabArgs = (title = 'Motion fixture') => [
  '-e',
  'if application "Google Chrome" is running then',
  '-e',
  'tell application "Google Chrome"',
  '-e',
  'repeat with w in windows',
  '-e',
  'repeat with i from 1 to (count of tabs of w)',
  '-e',
  `if (title of tab i of w) is ${appleString(title)} then`,
  '-e',
  'if (active tab index of w) is not i then set active tab index of w to i',
  '-e',
  'set index of w to 1',
  '-e',
  'end if',
  '-e',
  'end repeat',
  '-e',
  'end repeat',
  '-e',
  'if not frontmost then activate',
  '-e',
  'end tell',
  '-e',
  'end if',
];
