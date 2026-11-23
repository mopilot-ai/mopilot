// Computer History in the menu bar (#1363): while it is on, the tray icon stays up whatever the user's tray setting, says what it is doing in its tooltip, and offers Pause or Resume and Manage at the top of its menu.

/** @typedef {import('./recorder.cjs').Status} Status */

/** The first line of the tray menu and the tooltip for each status (none while off). */
const LABEL = /** @type {Record<Status, string | null>} */ ({
  off: null,
  recording: 'Computer History is recording',
  paused: 'Computer History is paused',
  suspended: 'Computer History is stopped while the Mac is locked, asleep or MoPilot quits',
  'needs-permission': 'Computer History needs Accessibility',
  unavailable: 'Computer History is waiting for the computer-use helper',
  'store-unavailable': "Computer History can't save right now",
});

/** Whether the tray icon must stay up for Computer History. */
const shows = (/** @type {Status} */ status) => !!LABEL[status];

/**
 * The tray menu's Computer History items, or none while it is off.
 * @param {Status} status
 * @param {{ pause: () => void, resume: () => void, manage: () => void }} actions
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function trayItems(status, actions) {
  const label = LABEL[status];
  if (!label) return [];
  return [
    { label, enabled: false },
    status === 'paused'
      ? { label: 'Resume Computer History', click: actions.resume }
      : { label: 'Pause Computer History', click: actions.pause },
    { label: 'Manage Computer History…', click: actions.manage },
    { type: 'separator' },
  ];
}

module.exports = { LABEL, shows, trayItems };
