// The words of a phone's direct access to a Host and of a machine card's states (Remote Run plan, "Clients"): one vocabulary for every client, no copy of these states written in a component.

/** The reach of one machine from the phone: its own enrollment, the Mac's path, or neither; `down` is an enrollment whose Host does not answer (it lost its side of the link). @param {'direct' | 'through' | 'none'} reach @param {string} mac the Mac's name @param {boolean} [down] */
export const reachWord = (reach, mac, down = false) =>
  reach === 'direct' ? (down ? 'Not reachable directly' : 'Direct') : reach === 'through' ? `Through ${mac}` : null;

/** The buttons of direct access: setting it up, trying again, setting it up again when the machine does not answer, and taking a machine off the phone. */
export const DIRECT_ACTIONS = Object.freeze({
  start: 'Use without your Mac',
  retry: 'Try again',
  repair: 'Reconnect',
  remove: 'Remove this machine',
  confirmRemove: 'Remove',
  keep: 'Keep',
});

/** What removing a machine does, before it is done. @param {string} machine */
export const removeLine = (machine) =>
  `Remove ${machine} from this phone? Its chats and approvals stop showing here until you set it up again from your Mac.`;

/** Why the machine does not answer and what to do, under its page's Reach row. @param {string} machine @param {boolean} macUp whether the Mac reaches it now */
export const downLine = (machine, macUp) =>
  macUp
    ? `${machine} is not linked to the relay: approvals cannot reach this phone. Reconnect to set it up again.`
    : `${machine} does not answer.`;

/** The line for each step of setting direct access up. @param {'working' | 'failed' | 'update'} state @param {string} machine */
export const setupLine = (state, machine) =>
  state === 'working' ? 'Setting up…' : state === 'update' ? `Update ${machine}.` : `Couldn't set up direct access to ${machine}.`;

/** A closed card by who answered: here ("Allowed"), or on another device ("Allowed on Pocket iPhone"). @param {'allow' | 'deny' | 'other'} kind @param {string | null} device null: this phone */
export function answeredLine(kind, device) {
  const word = kind === 'allow' ? 'Allowed' : kind === 'deny' ? 'Denied' : 'Answered';
  return device ? `${word} on ${device}` : word;
}

/** What a card says for each state a machine chat adds. @param {'lost' | 'gone' | 'expired' | 'cancelled' | 'restarted' | 'moved' | 'unreachable' | 'no-path' | 'managed'} state @param {{ device?: string | null, machine?: string, org?: string }} o */
export function cardLine(state, { device = null, machine = 'the machine', org = '' } = {}) {
  switch (state) {
    case 'lost':
      return device ? `Already answered on ${device}.` : 'Already answered.';
    case 'gone':
      return 'No longer waiting.';
    case 'expired':
      return 'Not answered';
    case 'cancelled':
      return 'Cancelled';
    case 'restarted':
      return 'The machine restarted';
    case 'moved':
      return 'This chat moved to another machine.';
    case 'unreachable':
      return `Couldn't reach ${machine}.`;
    case 'no-path':
      return `Can't reach ${machine}.`;
    default:
      return `Managed by ${org}`;
  }
}

/** The countdown on a waiting card once the reminder went: "Pauses in 24 min", or null before it. @param {number} minutes */
export const pausesLine = (minutes) => (minutes > 0 ? `Pauses in ${minutes} min` : null);
