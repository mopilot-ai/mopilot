// The events the Mac does not seal for a phone the relay says is away: live views the phone rebuilds by reading again when it returns (a followed chat, the chat list, a terminal's replay, the machine list, a live frame). Anything not named here is always sealed, so a one-time message (the push title key, a notice) is never lost.
const { noteIgnored } = require('../ignored.cjs');

const AWAY_SKIPPABLE = new Set([
  'items.append',
  'items.replace',
  'items.delta',
  'turn.state',
  'session.patch',
  'cards.changed',
  'chats.changed',
  'machines.changed',
  'pty.data',
  'frames.frame',
]);

/** Whether this message is a live-view event that a phone which is away does not need sealed. @param {any} msg */
function skippableWhileAway(msg) {
  return msg?.kind === 'event' && typeof msg.ev === 'string' && AWAY_SKIPPABLE.has(msg.ev);
}

/** Refusals the relay made of frames that cannot be taken back (a later one was sealed) before the Mac stops sealing live events: half of the phone's catch-up bound (PHONE_CATCH_UP_SKIP, 32768), so the holes never outrun it. */
const HOLE_LIMIT = 16384;
/**
 * The relay did not store a frame (`mailbox_full`: nothing will ever deliver it). Its counter is taken back only while no later frame was sealed
 * (the chain is strict, so a counter below a later one cannot be reused); otherwise it stays a hole the phone must walk over, and is counted.
 * @param {{ holes?: number, sealed: { ctr: number, before: any } | null, tx: { state(): { ctr: number } } }} s @param {number} ctr @param {(before: any) => void} takeBack
 */
function refusedFrame(s, ctr, takeBack) {
  if (s.sealed && s.sealed.ctr === ctr && s.tx.state().ctr === ctr) takeBack(s.sealed.before);
  else s.holes = (s.holes ?? 0) + 1;
}

/**
 * Whether `msg` is not sealed now: a live-view event for a phone that is away, or anything but a reply (a notice is never asked) once the holes
 * reach the limit, so the chain stops growing until the phone is heard from. Replies to the phone's own requests are always sealed.
 * @param {{ phoneAbsent?: (pairId: string) => boolean }} o @param {{ device: { pairId: string }, holes?: number }} s @param {any} msg
 */
const skipsSeal = (o, s, msg) =>
  (skippableWhileAway(msg) && o.phoneAbsent?.(s.device.pairId) === true) || ((s.holes ?? 0) >= HOLE_LIMIT && msg?.kind !== 'reply');

/** The marker sealed to a phone that was wrongly taken for away: it reads what it has on screen again. */
const MISSED_EVENT = 'live.missed';
/** The notice that carries it. @param {number} at */
const missedNotice = (at) => ({
  id: `n_${at}_${MISSED_EVENT}`,
  t: at,
  kind: 'event',
  ev: MISSED_EVENT,
  patch: { reason: 'late-presence' },
});

/** A phone is sent the marker at most this often per pair. */
const MISSED_EVERY_MS = 60_000;
/** Whether a marker may be sealed to this session now; if so, the time is taken. @param {{ missedAt?: number }} s @param {number} at */
function missedDue(s, at) {
  if (s.missedAt !== undefined && at - s.missedAt < MISSED_EVERY_MS) return false;
  s.missedAt = at;
  return true;
}

/**
 * A frame opened and its message was decoded, so the phone is there. If the Mac had it as away, the live events skipped for it are told with
 * one marker (the phone reads again); the relay's own `peer online` is the normal return and needs none. It runs after the frame is saved and
 * acknowledged, so a failure here is noted and never pauses the session.
 * @param {{ phoneAbsent?: (pairId: string) => boolean, onPhoneFrame?: (pairId: string, receivedAt: number, sentAt: number) => void }} o the channel's options
 * @param {{ device: { pairId: string }, missedAt?: number, holes?: number }} s @param {number} at mono time the frame was received @param {{ t: number }} msg the opened message
 * @param {number} now the wall clock @param {(notice: object) => Promise<void>} send seals a notice for the phone
 */
function phoneHeard(o, s, at, msg, now, send) {
  try {
    s.holes = 0;
    const id = s.device.pairId;
    const wasAbsent = o.phoneAbsent?.(id) === true;
    o.onPhoneFrame?.(id, at, msg.t);
    if (!wasAbsent || o.phoneAbsent?.(id) === true || !missedDue(s, now)) return;
    send(missedNotice(now)).catch((error) => noteIgnored('tell a phone it missed live events', error));
  } catch (error) {
    noteIgnored('note that a phone is present', error);
  }
}

module.exports = {
  AWAY_SKIPPABLE,
  HOLE_LIMIT,
  refusedFrame,
  skipsSeal,
  MISSED_EVENT,
  skippableWhileAway,
  missedNotice,
  missedDue,
  phoneHeard,
};
