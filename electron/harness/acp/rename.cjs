// A chat's title record on the ACP host: the name kept in the chat's transcript, and where the person's name for a chat on a machine goes next (that machine, through the host's `remoteRename`).
const { prefixUnits } = require('../../../shared/textPrefix.mjs');

/**
 * Keeps `name` as the chat's latest title record, and tells the machine the person's own name (never an automatic title) when the chat runs on one. The record is written first, so the person's choice stands even when the machine is away or too old.
 * @param {any} host the AcpHost @param {string} key @param {unknown} name @param {boolean} auto MoPilot wrote it, not the person
 * @returns {Promise<unknown> | null} what the machine answered, or null for an automatic title, a name that is not text and a chat that runs here
 */
function renameTitle(host, key, name, auto) {
  if (typeof name !== 'string') return null;
  const rec = { t: 'title', name: prefixUnits(name, 200), ...(auto ? { auto: true } : {}), at: host.now() };
  host.titleSessions.latest.set(key, rec);
  host.items.append(key, rec);
  // this run's controller learns the new name now: its notifications carry the person's rename, not the first words they were titled by (#5238)
  host.emit('event', { kind: 'threadName', key, name: rec.name });
  return auto ? null : host.remoteRename(key, rec.name);
}

module.exports = { renameTitle };
