// What a Host's answers to pairing by a code say (host/src/codePairService.mjs, R2b of #5576), merged into the table of refusal words (refusalWords.mjs): each line names the machine, says the cause and, in the same words, the fix in place. None is a Retry: a pairing answered this way is over, and its fix is a new code or a change on that machine.

export const CODE_PAIR_WORDS = {
  bad_credential: (c) => ({
    line: `${c.machine} got something from the other Mac it can’t use. Make a new code and enter it again.`,
    action: null,
    retry: false,
  }),
  approval_unavailable: (c) => ({
    line: `This pairing wasn’t allowed in person on ${c.machine}. Make a new code, then allow it there.`,
    action: null,
    retry: false,
  }),
  failed: (c) => ({ line: `The pairing with ${c.machine} didn’t finish. Make a new code and try again.`, action: null, retry: false }),
  relay: (c) => ({
    line: `${c.machine} couldn’t reach MoPilot’s relay. Check its connection, then make a new code.`,
    action: null,
    retry: false,
  }),
  connections_off: (c) => ({
    line: `Connections are off on ${c.machine}. Turn on Allow connections in its Settings › Connections, then make a code.`,
    action: null,
    retry: false,
  }),
  paused: (c) => ({
    line: `Pairing by code is paused on ${c.machine} after too many wrong codes. Wait a few minutes, then make a new code.`,
    action: null,
    retry: false,
  }),
  limited: (c) => ({
    line: `Too many codes were made on ${c.machine}. Wait a few minutes, then make a new one.`,
    action: null,
    retry: false,
  }),
  burned: (c) => ({ line: `That code was used up on ${c.machine}. Make a new code.`, action: null, retry: false }),
  no_such_offer: (c) => ({ line: `That code isn’t open on ${c.machine} any more. Make a new code.`, action: null, retry: false }),
  not_asked: (c) => ({
    line: `Nobody is waiting to be allowed on ${c.machine}. Enter the code on the other Mac first.`,
    action: null,
    retry: false,
  }),
  // the reasons a Host cannot take the person's approval (codePairService.mjs UNAVAILABLE), each raised as its own code
  no_approval_helper: (c) => ({
    line: `${c.machine} can’t ask for a pairing to be allowed yet. Update MoPilot on ${c.machine}, then make a new code.`,
    action: null,
    retry: false,
  }),
  unsupported_platform: (c) => ({
    line: `Pairing by code works between Macs, and ${c.machine} isn’t one. Add it over SSH instead.`,
    action: null,
    retry: false,
  }),
  busy: (c) => ({
    // also a set-up running or an Allow prompt open: generic here; the reset says its own case (ResetApproval.tsx)
    line: `${c.machine} is in the middle of another pairing step. Finish or cancel it there, then try again.`,
    action: null,
    retry: false,
  }),
  reset_incomplete: (c) => ({
    line: `Resetting pairing approval on ${c.machine} didn’t finish. Reset it again.`,
    action: null,
    // not a Retry of the same request: the reset itself is the fix, from its own button
    retry: false,
  }),
};
