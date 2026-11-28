// What a Host says when MoMo's home, its turns or its main chat refuse (host/src/methods/momo*.mjs, homeGate.mjs), merged into the table of refusal words (refusalWords.mjs): the real cause in a line, with the view's own one-click fix where there is one.

/** @type {Record<string, (c: import('./refusalWords.mjs').RefusalContext) => import('./refusalWords.mjs').RefusalWords>} */
export const MOMO_WORDS = {
  // MoMo's home, its turns and its main chat: the real cause, in a line. The one-click fix, where there is one, is the view's own (`fix {id, label}`),
  // shown beside this line; these words are also what any other surface (a chat's error, the phone's generic path, a log) falls back to
  momo_check_unavailable: (c) => ({ line: `MoMo on ${c.machine} has no model to check this with yet.`, action: null, retry: true }),
  momo_check_too_large: (c) => ({ line: `That is too long for MoMo on ${c.machine} to check.`, action: null, retry: false }),
  momo_check_malformed: (c) => ({ line: `MoMo on ${c.machine} got no usable answer when it checked this.`, action: null, retry: false }),
  momo_check_timeout: (c) => ({ line: `MoMo on ${c.machine} took too long to check this.`, action: null, retry: true }),
  momo_check_budget: (c) => ({ line: `MoMo on ${c.machine} has checked enough for this hour.`, action: null, retry: true }),
  momo_check_failed: (c) => ({ line: `MoMo on ${c.machine} couldn't check this right now.`, action: null, retry: true }),
  momo_chat_unavailable: (c) => ({ line: `MoMo's chat on ${c.machine} can't take this yet.`, action: null, retry: true }),
  momo_chat_fixed: (c) => ({ line: `MoMo's chat on ${c.machine} keeps its own settings, agent and place.`, action: null, retry: false }),
  momo_home_away: (c) => ({ line: `MoMo's home isn't running on ${c.machine}.`, action: 'openMachines', retry: true }),
  // a Host older than the release a home needs (#5626): it refuses the start itself
  host_too_old: (c) => ({ line: `${c.machine} needs a MoPilot update before it can hold MoMo's home.`, action: 'update', retry: true }),
  // MoMo's home on another of the user's machines (host/src/homeGate.mjs): what this machine says when the home asks for more than it may
  home_not_allowed: (c) => ({ line: `MoMo isn't allowed to do that on ${c.machine}.`, action: null, retry: false }),
  home_mode_refused: (c) => ({
    line: `MoMo may start tasks on ${c.machine} only in "Ask for approval" or read-only.`,
    action: null,
    retry: false,
  }),
  home_lease_jump: (c) => ({
    line: `${c.machine} doesn't believe MoMo's claim to a lease far ahead of the one it knows. Allow MoMo again if it really moved that far.`,
    action: null,
    retry: false,
  }),
  home_too_many: (c) => ({
    line: `MoMo already has as many tasks running on ${c.machine} as it may. Wait for one to finish.`,
    action: null,
    retry: false,
  }),
  home_mode_changed: (c) => ({
    line: `This session's mode was raised on ${c.machine}, so MoMo can no longer send to it.`,
    action: null,
    retry: false,
  }),
  home_handover_failed: (c) => ({
    line: `MoMo's key was added on ${c.machine}, but taking over its lease did not finish. Allow MoMo again.`,
    action: null,
    retry: false,
  }),
  home_lease_unassigned: (c) => ({
    line: `MoMo has no key allowed to hold its lease on ${c.machine}. Allow MoMo again from your own device.`,
    action: null,
    retry: false,
  }),
  home_lease_held: (c) => ({
    line: `Another MoMo key holds the lease on ${c.machine}. Allow MoMo again from your own device.`,
    action: null,
    retry: false,
  }),
  home_stamp_missing: (c) => ({ line: `${c.machine} can't tell which MoMo home this comes from.`, action: null, retry: false }),
};
