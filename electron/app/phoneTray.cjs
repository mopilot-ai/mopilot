// The compact native Phones submenu: each saved phone's health and one route to inspect or manage the pairings.
const { PHONE_CONNECTION_LABEL, phoneCounts, phoneSummary } = require('../../shared/phoneConnections.mjs');

/**
 * @param {ReturnType<typeof import('../remote/phoneDevices.cjs').phoneDevices>} devices
 * @param {(() => void) | undefined} manage
 * @param {boolean} locked
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function phoneTrayItems(devices, manage, locked) {
  const action = { click: manage, enabled: !!manage };
  if (!devices.length && !locked) return [{ label: 'Connect a phone…', ...action }, { type: 'separator' }];
  const { connected } = phoneCounts(devices);
  return [
    {
      label: locked ? 'Phones · Needs attention' : `Phones · ${connected} connected`,
      submenu: [
        { label: locked ? 'Phone storage needs recovery' : phoneSummary(devices), enabled: false },
        ...devices.map((device) => ({ label: `${device.name} — ${PHONE_CONNECTION_LABEL[device.connection]}`, ...action })),
        { type: 'separator' },
        { label: 'Manage phones…', ...action },
      ],
    },
    { type: 'separator' },
  ];
}

module.exports = { phoneTrayItems };
