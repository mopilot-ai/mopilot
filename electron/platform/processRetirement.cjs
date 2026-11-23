// A managed tree releases ownership only after its groups and exact kernel-born loose descendants are gone.
const { groupsOf } = require('./processTree.cjs');
const { identityTable } = require('./processIdentity.cjs');
const { noteIgnored } = require('../ignored.cjs');
const GRACE_MS = 3000;

/** Strict completion is distinct from the best-effort signalTree API; unavailable identity remains unverified.
 * @param {number | null} pgid @param {NodeJS.Signals} sig
 * @param {{ table?: () => import('./processTree.cjs').ProcRow[] | Promise<import('./processTree.cjs').ProcRow[]>,
 *   kill?: (pid: number, signal: NodeJS.Signals) => void, own?: number, known?: Map<number, number>, births?: Map<number, string>,
 *   ownedGroups?: Map<number, string | null>,
 *   valid?: (group: number) => boolean }} [o] */
async function retireTree(
  pgid,
  sig,
  {
    table = identityTable,
    kill = process.kill.bind(process),
    own,
    known = new Map(),
    births = new Map(),
    ownedGroups = new Map(),
    valid = () => true,
  } = {},
) {
  let rows = await table();
  const checked = (snapshot) => snapshot.length > 0 && snapshot.every((row) => typeof row[3] === 'string');
  if (!checked(rows)) throw new Error('Kernel process identities are unavailable; process retirement is unverified.');
  const self = own ?? rows.find(([pid]) => pid === process.pid)?.[2] ?? 0;
  const initial = pgid == null ? new Set() : groupsOf(rows, pgid, self).groups;
  for (const group of initial) if (!rows.some(([, , current]) => current === group)) initial.delete(group);
  const groups = ownedGroups;
  const authorize = (group) => {
    if (!valid(group)) throw new Error('A process group changed owner; retirement is unverified.');
  };
  const addGroup = (group, birth) => {
    authorize(group);
    if (!groups.has(group)) groups.set(group, birth);
  };
  for (const group of initial) addGroup(group, rows.find(([pid]) => pid === group)?.[3] ?? null);
  const loose = new Map();
  for (const pid of known.keys()) {
    const row = rows.find(([id]) => id === pid);
    if (!row) continue;
    if (!row[3]) throw new Error('A recorded descendant cannot be identified; process retirement is unverified.');
    if (!births.has(pid)) throw new Error('A recorded descendant has no birth identity; process retirement is unverified.');
    if (row[3] !== births.get(pid)) continue;
    const group = row[2];
    if (pid === group && group !== self && group > 1) addGroup(group, row[3]);
    loose.set(pid, row[3]);
  }
  let signalled = false;
  const verify = () => {
    if (rows.some(([pid, , group, birth]) => !birth && (groups.has(group) || loose.has(pid))))
      throw new Error('An owned process birth identity is unavailable; process retirement is unverified.');
  };
  const send = (target, signal) => {
    try {
      kill(target, signal);
      signalled = true;
    } catch (error) {
      noteIgnored('retire a managed process', error, ['ESRCH']);
    }
  };
  const reconcileGroups = () => {
    for (const [group, birth] of groups) {
      if (!rows.some(([, , current]) => current === group)) {
        groups.delete(group);
        continue;
      }
      const leader = rows.find(([pid]) => pid === group);
      if (leader && leader[3] !== birth) {
        if (!birth) throw new Error('A process group leader cannot be identified; retirement is unverified.');
        groups.delete(group);
      }
    }
  };
  reconcileGroups();
  verify();
  // A recorded birth remains ours if it later calls setsid/setpgid; group membership is mutable.
  const remember = () => {
    for (const [pid, , group, birth] of rows)
      if (groups.has(group)) {
        loose.set(pid, birth);
        // These maps and ownedGroups belong to the run, so a failed attempt cannot forget a discovered writer.
        known.set(pid, group);
        births.set(pid, /** @type {string} */ (birth));
      }
  };
  for (const group of groups.keys()) authorize(group);
  remember();
  for (const group of groups.keys()) send(-group, sig);
  for (const [pid, , group, birth] of rows) if (!groups.has(group) && loose.get(pid) === birth) send(pid, sig);
  const deadline = Date.now() + GRACE_MS;
  for (let attempt = 0; attempt < 300; attempt++) {
    // Empty or failed reads cannot establish disappearance. A replacement birth never receives an old signal.
    if (checked(rows)) {
      verify();
      reconcileGroups();
      for (const group of groups.keys()) authorize(group);
      // Group identity survives the last original member handing off to a new member of that same group.
      for (const [pid, birth] of loose) if (!rows.some(([id, , , current]) => id === pid && current === birth)) loose.delete(pid);
      for (const group of [...groups.keys()])
        for (const childGroup of groupsOf(rows, group, self).groups)
          if (!groups.has(childGroup)) addGroup(childGroup, rows.find(([pid]) => pid === childGroup)?.[3] ?? null);
      verify();
      remember();
      const active = rows.filter(([pid, , group, birth]) => groups.has(group) || loose.get(pid) === birth);
      if (!active.length) return signalled;
      if (Date.now() >= deadline) for (const [pid] of active) send(pid, 'SIGKILL');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    rows = await table();
  }
  throw new Error('The managed process tree did not retire; its installation lock is still held.');
}

module.exports = { retireTree };
