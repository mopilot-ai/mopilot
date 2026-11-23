// A message as a chat's queue stores it: what was typed, every option it was sent with, and where it came from.
const { carryInputGuard } = require('./contract/inputGuard.cjs');
const { clock } = require('../platform/ports/clock.cjs');
const crypto = require('node:crypto');

/** A queue item as stored: what was typed, and every option it was sent with. */
function queueItem(item, origin) {
  const opts = item && typeof item.opts === 'object' && item.opts ? { ...item.opts } : {};
  const queued = {
    id: typeof item?.id === 'string' && item.id ? item.id : crypto.randomUUID(),
    text: String(item?.text ?? ''),
    attachments: Array.isArray(item?.attachments) ? item.attachments : [],
    opts,
    ...(item?.peer ? { peer: { ...item.peer } } : {}),
    // a brief, wake-up or family message main delivered keeps its id as the harness's client id (inputGuard clientIdOf)
    ...(typeof item?.sideSession?.id === 'string' ? { sideSession: { id: item.sideSession.id } } : {}),
    // and an input no human wrote keeps the id its chat's meta shows it by (authoredInput.cjs)
    ...(typeof item?.authored?.id === 'string' ? { authored: { id: item.authored.id } } : {}),
    ...(item?.planApproval ? { planApproval: { ...item.planApproval } } : {}),
    origin: origin ?? null,
    queuedAt: clock.now(),
  };
  return item && typeof item === 'object' ? carryInputGuard(item, queued) : queued;
}

module.exports = { queueItem };
