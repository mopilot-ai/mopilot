// Deleting what a cloud acceptance run made, and proving it: the machine and its boot volume are deleted, anything else live in the compartment is too (it was empty when the run began, so it is the run's), and the compartment is read until it holds no machine and no disk.
import { adapterIn } from './machine.mjs';

/** How long a disk may stay after its machine is gone before the run deletes it itself. */
const DISK_GRACE_MS = 30_000;
/** Whether OCI says a machine is already on its way out. */
const going = (/** @type {string} */ state) => state === 'TERMINATING' || state === 'TERMINATED';

/**
 * @param {any} cloud @param {{ waitMs?: number }} [o]
 * @returns {Promise<{ ok: boolean, ms: number, detail: string }>}
 */
export async function tearDown(cloud, { waitMs = 600_000 } = {}) {
  const started = cloud.deps.now();
  /** @type {string[]} */
  const notes = [];
  /** @param {string} what @param {() => Promise<unknown>} act */
  const attempt = async (what, act) => {
    try {
      await act();
    } catch (error) {
      notes.push(`${what}: ${/** @type {Error} */ (error).message}`);
    }
  };
  const adapter = adapterIn(cloud, cloud.made?.ad ?? cloud.ads[0]);
  const end = started + waitMs;
  /** @type {number | null} */
  let diskSince = null;
  /** @type {Set<string>} */
  const asked = new Set();
  for (;;) {
    /** @type {Awaited<ReturnType<typeof cloud.readers.look>> | null} */
    let look = null;
    try {
      look = await cloud.readers.look();
    } catch (error) {
      notes.push(`read the compartment: ${/** @type {Error} */ (error).message}`);
    }
    if (look?.empty)
      return {
        ok: true,
        ms: cloud.deps.now() - started,
        detail: `the compartment holds no machine and no disk${notes.length ? ` (${notes.join('; ')})` : ''}`,
      };
    if (cloud.deps.now() >= end) {
      const left = look
        ? [...look.live.map((m) => `${m.name} ${m.state}`), ...look.volumes.map((v) => `${v.kind} disk ${v.gb} GB ${v.state}`)]
        : ['unreadable'];
      return {
        ok: false,
        ms: cloud.deps.now() - started,
        detail: `STILL THERE after ${waitMs / 1000} s: ${left.join(', ')}${notes.length ? ` (${notes.join('; ')})` : ''}`,
      };
    }
    // the known machine first, then anything else live in the compartment
    const live = look?.live ?? [];
    for (const id of new Set([cloud.made?.id, ...live.map((m) => m.id)].filter(Boolean))) {
      if (asked.has(id) || going(live.find((m) => m.id === id)?.state ?? '')) continue;
      asked.add(id);
      await attempt('delete a machine', () => adapter.destroy(id));
    }
    // a disk with no machine left is deleted after a short grace (the provider usually does it with the machine)
    const stray = look && look.live.length === 0 ? look.volumes.filter((v) => v.state === 'AVAILABLE') : [];
    diskSince = stray.length ? (diskSince ?? cloud.deps.now()) : null;
    if (diskSince !== null && cloud.deps.now() - diskSince >= DISK_GRACE_MS)
      for (const v of stray)
        await attempt('delete a disk', () =>
          cloud.call('DELETE', 'iaas', `/20160918/${v.kind === 'boot' ? 'bootVolumes' : 'volumes'}/${encodeURIComponent(v.id)}`),
        );
    await cloud.deps.sleep(cloud.pollMs);
  }
}
