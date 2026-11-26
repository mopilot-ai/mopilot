// What a Host's answers about "Allow connections" say (host.codePair.connections, R2b of #5576), in the shape of the table of refusal words (refusalWords.mjs): the cause naming the machine, and the fix in place.

export const CONNECTIONS_WORDS = {
  not_saved: (/** @type {{ machine: string }} */ c) => ({
    line: `${c.machine} couldn’t save Allow connections, so it stays off. Free some disk space on ${c.machine}, then turn it on again.`,
    action: null,
    retry: false,
  }),
};
