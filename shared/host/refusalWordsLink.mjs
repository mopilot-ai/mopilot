// What MoMo's home is told when it cannot use one of the user's other machines (host/src/momoTasks/homeClient.mjs): the words of the machine_* refusals, merged into the table of refusalWords.mjs.
export const LINK_WORDS = {
  machine_offline: (c) => ({ line: `${c.machine} is asleep or offline.`, action: null, retry: true }),
  machine_changed: (c) => ({
    line: `That isn't the machine MoMo was allowed to use as ${c.machine}. Allow it again.`,
    action: null,
    retry: false,
  }),
  machine_lost: (c) => ({
    line: `The connection to ${c.machine} was lost while starting, so it may have started. Retry checks.`,
    action: null,
    retry: true,
  }),
  machine_not_allowed: (c) => ({ line: `MoMo isn't allowed to use ${c.machine} yet.`, action: null, retry: false }),
};
