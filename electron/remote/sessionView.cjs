// A SessionState as a paired device may see it: the keys the app shows, the queue as text, and no approval's tool arguments (those reach a device only as the card a window shows too).

/** Keys passed through as they are. */
const KEYS = [
  'turn',
  'activeTurn',
  'crashed',
  'plan',
  'permission',
  'goal',
  'compaction',
  'pendingSwitch',
  'runningElsewhere',
  'scheduled',
];

/** The longest reason a Host gives for refusing a message that a device is told. */
const REASON_MAX = 300;
/** Why a message waits for something other than the running turn, as the Mac's outbox names it, that a device is told of (electron/host/remoteSendProjection.cjs). */
const WAITS = new Set(['host', 'orgSignin']);

/**
 * What the Mac's queue says about a message that a machine's Host has not taken: it refused it (with its reason), the chat moved to another machine,
 * or it waits for the machine or for a sign-in. A message behind a running turn, or one the Mac's own queue holds, says nothing, as before.
 * @param {any} q
 */
const standing = (q) =>
  q?.waitingFor === 'hostRefused'
    ? { refused: String(q.error ?? '').slice(0, REASON_MAX) }
    : q?.waitingFor === 'hostMoved'
      ? { moved: true }
      : // kept for a Switch host that is moving the chat: a device sees it wait for the machine, as before it knew the switch
        q?.waitingFor === 'hostMoving'
        ? { waiting: 'host' }
        : WAITS.has(q?.waitingFor)
          ? { waiting: q.waitingFor }
          : {};

/**
 * One queued message as the device needs it: its id, what was typed, whether the user wrote it (one another session or chat sent,
 * or no human wrote, is not the phone's to edit or take back: src/lib/queued.ts isUserQueued) and how many files ride with it.
 */
const queued = (/** @type {any} */ q) => ({
  id: String(q?.id ?? ''),
  text: String(q?.text ?? ''),
  mine: !!q && !q.sideSession && !q.peer && !q.authored,
  attached: Array.isArray(q?.attachments) ? q.attachments.length : 0,
  ...standing(q),
  ...(Array.isArray(q?.attachments) && q.attachments.some((file) => file?.kind === 'image')
    ? { images: q.attachments.filter((file) => file?.kind === 'image').length }
    : {}),
});

/**
 * The part of a SessionState patch (or of a whole state) a device sees.
 * @param {Record<string, any>} patch
 * @returns {Record<string, any>}
 */
function viewOf(patch) {
  const out = {};
  for (const k of KEYS) if (Object.hasOwn(patch, k)) out[k] = structuredClone(patch[k]);
  if (Object.hasOwn(patch, 'queue')) out.queue = (Array.isArray(patch.queue) ? patch.queue : []).map(queued);
  return out;
}

/** Whether the patch changes which cards are up. */
const changesCards = (/** @type {Record<string, any>} */ patch) => Object.hasOwn(patch, 'approvals') || Object.hasOwn(patch, 'questions');

module.exports = { viewOf, changesCards };
