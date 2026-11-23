// A remote Host's scheduled-task requests (#2709 phase 2): the app's whole set of tasks for that machine (host.scheduleSync) and the runs it fired since a cursor (host.scheduleRuns), each one control request through the shared parsers, joined into createRemoteHost (remote.cjs).

/**
 * @param {(method: string, params: object) => Promise<any>} control one control request to the Host
 */
function scheduleCalls(control) {
  return {
    /** The machine keeps these tasks and fires them itself; what is not in the set is no longer kept there: `{ held }`. A Host without schedules refuses as `feature_missing`. @param {{ tasks: object[] }} p */
    scheduleSync: (p) => control('host.scheduleSync', p),
    /** The runs the machine fired after cursor `after`, oldest first, and the cursor to ask from next: `{ runs, next }`. @param {{ after: number }} p */
    scheduleRuns: (p) => control('host.scheduleRuns', p),
  };
}

module.exports = { scheduleCalls };
