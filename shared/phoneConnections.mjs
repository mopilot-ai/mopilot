// The connection words and counts shared by the native phone menu and Settings; saved pairings are distinct from live connections.
/** @typedef {'connected' | 'offline' | 'unknown' | 'paused' | 'closed' | 'removed' | 'locked'} PhoneConnection */
/** @type {Readonly<Record<PhoneConnection, string>>} */
export const PHONE_CONNECTION_LABEL = Object.freeze({
  connected: 'Connected',
  offline: 'Offline',
  unknown: 'Status unavailable',
  paused: 'Reconnecting',
  closed: 'Restart MoPilot to reconnect',
  removed: 'Pairing removed',
  locked: 'Storage needs recovery',
});

/** @param {{ connection: PhoneConnection, retired: boolean }[]} devices */
export function phoneCounts(devices) {
  return {
    paired: devices.filter((d) => !d.retired).length,
    connected: devices.filter((d) => d.connection === 'connected').length,
  };
}

/** @param {{ connection: PhoneConnection, retired: boolean }[]} devices */
export function phoneSummary(devices) {
  const { paired, connected } = phoneCounts(devices);
  return `${connected} connected · ${paired} paired`;
}
