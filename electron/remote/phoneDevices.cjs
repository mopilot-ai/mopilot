// Read the current account's saved phones into a secret-free UI snapshot, deciding connection health once for Settings and the tray.

/** @param {ReturnType<typeof import('./runtime.cjs').openRemote> | null | undefined} remote */
function phoneDevices(remote) {
  if (!remote?.devices) return [];
  const { devices, channel, presence } = remote;
  return devices.list().map(({ id, name, lastSeenAt, createdAt, pairId, mirrors }) => {
    const retired = devices.isRetired(pairId);
    const frames = channel?.statsOf(pairId) ?? null;
    /** @type {import('../../shared/phoneConnections.mjs').PhoneConnection} */
    const connection = retired
      ? 'removed'
      : devices.locked
        ? 'locked'
        : frames?.paused
          ? 'paused'
          : channel?.closedReason(pairId)
            ? 'closed'
            : presence?.isOnline(pairId)
              ? 'connected'
              : presence?.isAbsent(pairId)
                ? 'offline'
                : 'unknown';
    return {
      id,
      pairId,
      name,
      lastSeenAt,
      pairedAt: createdAt,
      online: connection === 'connected',
      connection,
      mirrors: mirrors === true,
      retired,
      frames,
    };
  });
}

module.exports = { phoneDevices };
