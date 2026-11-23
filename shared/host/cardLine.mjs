// A card's states said in words, read by both clients (Remote Run, "A card"): what a waiting, answered, lost, expired or cancelled approval or question shows and the one action it keeps; no component writes these.

/** The Host's reminder and pause defaults (U1); a card shows the clock only after the reminder. */
export const REMIND_MS = 10 * 60_000;
export const PAUSE_MS = 30 * 60_000;

/**
 * @typedef {'allow' | 'deny' | 'other'} OptionKind
 * @typedef {{ name: string, at?: number }} Device
 * @typedef {{ state: 'waiting', since: number, remindMs?: number, pauseMs?: number }
 *   | { state: 'sent' }
 *   | { state: 'answered', optionKind: OptionKind, by?: Device | null }
 *   | { state: 'lost', by: Device }
 *   | { state: 'expired' | 'stopped' | 'turn_ended' | 'restarted' | 'moved' | 'unreachable' | 'policy' }} CardState
 * @typedef {{ text: string | null, hover?: number, action: { kind: 'retry' | 'try-again', label: string } | null, progress?: boolean }} CardLine
 */

/** "Pauses in 20 min" once the reminder has gone, counting down by the minute and never below 1; nothing before it. @param {number} since @param {number} now @param {number} [remindMs] @param {number} [pauseMs] */
export function pausesIn(since, now, remindMs = REMIND_MS, pauseMs = PAUSE_MS) {
  const elapsed = now - since;
  if (elapsed < remindMs) return null;
  return `Pauses in ${Math.max(1, Math.ceil((pauseMs - elapsed) / 60_000))} min`;
}

/** "Allowed", "Denied", or for an answer from another device "Allowed on Pocket iPhone"; a question's answer says "Answered". @param {OptionKind} kind @param {Device | null | undefined} by */
const answered = (kind, by) => {
  const word = kind === 'allow' ? 'Allowed' : kind === 'deny' ? 'Denied' : 'Answered';
  return by ? `${word} on ${by.name}` : word;
};

/**
 * The words under a card and its one action. `machineName` and `org` fill the two states that name them.
 * @param {CardState} s @param {{ now: number, machineName?: string, org?: string }} c @returns {CardLine}
 */
export function cardLine(s, c) {
  switch (s.state) {
    case 'waiting':
      return { text: pausesIn(s.since, c.now, s.remindMs, s.pauseMs), action: null };
    case 'sent':
      return { text: null, action: null, progress: true };
    case 'answered':
      return { text: answered(s.optionKind, s.by), hover: s.by?.at, action: null };
    case 'lost':
      return { text: `Already answered on ${s.by.name}.`, hover: s.by.at, action: null };
    case 'expired':
      return { text: 'Not answered', action: null };
    case 'stopped':
    case 'turn_ended':
      return { text: 'Cancelled', action: null };
    case 'restarted':
      return { text: 'The machine restarted', action: { kind: 'retry', label: 'Retry' } };
    case 'moved':
      return { text: 'This chat moved to another machine.', action: null };
    case 'unreachable':
      return { text: `Couldn't reach ${c.machineName ?? 'this machine'}.`, action: { kind: 'try-again', label: 'Try again' } };
    default:
      return { text: `Managed by ${c.org ?? 'your organization'}`, action: null };
  }
}

/** The line under a message another client sent: "Sent from Pocket iPhone"; none for a message from this device. @param {string | null | undefined} deviceName */
export const sentFrom = (deviceName) => (deviceName ? `Sent from ${deviceName}` : null);
