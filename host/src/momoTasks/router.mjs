// One machine port over this Host and the user's other machines: a request goes to the machine that owns the id, always. A machine that is not this one is never answered by this Host's port, whether or not a way to reach it is bound: with none, it is unreachable, not gone.

/**
 * @param {object} o
 * @param {import('../../../shared/momoTasks/types.ts').MachinePort} o.local
 * @param {import('../../../shared/momoTasks/types.ts').MachinePort} o.remote
 * @param {() => string | null | undefined} o.localId this Host's machine id while it is the running home
 * @returns {import('../../../shared/momoTasks/types.ts').MachinePort}
 */
export function createMachineRouter({ local, remote, localId }) {
  /** @param {string} machineId */
  const portFor = (machineId) => (machineId === localId() ? local : remote);
  return {
    list: async () => [...(await local.list()), ...(await remote.list())],
    start: (req) => portFor(req.machineId).start(req),
    stop: (machineId, sessionId) => portFor(machineId).stop(machineId, sessionId),
    probe: (machineId, sessionId) => portFor(machineId).probe(machineId, sessionId),
  };
}
