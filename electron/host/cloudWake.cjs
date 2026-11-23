// Wake a stopped cloud machine before a message goes to it (Remote Run C2): a message typed while the machine sleeps waits in the outbox as one for an offline machine does; this asks the provider to resume the machine (once, however many clients ask), waits for its Host to dial out, and the outbox drains by itself when the row turns online, so the message is delivered once. A machine the provider says is gone is said to be gone (C4), never guessed from a timeout.
const { clock } = require('../platform/ports/clock.cjs');
const { noteIgnored } = require('../ignored.cjs');

const WAKE_MS = 300_000;
const POLL_MS = 3000;
/** After a failed wake, this long before another is tried for the same machine, so a drain that finds the machine offline does not call the provider again and again. */
const COOLDOWN_MS = 30_000;

/**
 * @param {object} o
 * @param {(hostId: string) => { status?: string, cloud?: { provider: string, id: string, region: string } | null } | undefined} o.rowOf
 * @param {(provider: string, region: string) => import('../../shared/cloud/adapter.mjs').CloudAdapter} o.adapterOf
 * @param {(hostId: string) => Promise<unknown> | unknown} [o.check] asks the registry to look at the machine now
 * @param {(hostId: string, state: { state: 'waking' | 'online' | 'gone' | 'failed', reason?: string }) => void} [o.onState] the machine line: "Waking…", "Deleted at the provider", the failure's words
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {() => number} [o.now]
 */
function createCloudWake({
  rowOf,
  adapterOf,
  check = () => undefined,
  onState = () => undefined,
  sleep = (ms) => new Promise((r) => clock.setTimeout(r, ms)),
  now = () => clock.now(),
}) {
  /** @type {Map<string, Promise<{ state: string }>>} */
  const inflight = new Map();
  /** @type {Map<string, number>} */
  const failedAt = new Map();

  /** @param {string} hostId */
  async function run(hostId) {
    const row = rowOf(hostId);
    const cloud = row?.cloud;
    if (!cloud) return { state: 'not-cloud' };
    if (row.status === 'online') return { state: 'online' };
    const until = now() + WAKE_MS;
    onState(hostId, { state: 'waking' });
    try {
      // the adapter is made inside: a key that was removed ends the wake as a failure, never a rejection
      const adapter = adapterOf(cloud.provider, cloud.region);
      for (;;) {
        if (rowOf(hostId)?.status === 'online') break;
        const state = await adapter.status(cloud.id);
        if (state === 'gone') {
          onState(hostId, { state: 'gone' });
          return { state: 'gone' };
        }
        if (state === 'stopped') {
          try {
            await adapter.resume(cloud.id);
          } catch (error) {
            // a stop still finishing: the provider says so, and it is asked again
            if (/** @type {any} */ (error)?.code === 'gone') {
              onState(hostId, { state: 'gone' });
              return { state: 'gone' };
            }
            if (!(/** @type {any} */ (error)?.retryable)) throw error;
          }
        } else await check(hostId);
        if (now() >= until) throw Object.assign(new Error('The machine started but its Host did not answer.'), { code: 'no_answer' });
        await sleep(POLL_MS);
      }
    } catch (error) {
      failedAt.set(hostId, now());
      const reason = error instanceof Error && error.message ? error.message : 'The provider could not wake the machine.';
      onState(hostId, { state: 'failed', reason });
      noteIgnored('wake a cloud machine', error);
      return { state: 'failed', reason };
    }
    onState(hostId, { state: 'online' });
    return { state: 'online' };
  }

  return {
    /**
     * Wake the machine if it sleeps; every caller for the same machine shares one attempt, so `resume` is called once. Never rejects: the answer says how it ended, and a message stays queued either way.
     * @param {string} hostId
     */
    wake(hostId) {
      const running = inflight.get(hostId);
      if (running) return running;
      const at = failedAt.get(hostId);
      if (at !== undefined && now() - at < COOLDOWN_MS) return Promise.resolve({ state: 'failed' });
      const attempt = run(hostId).finally(() => void inflight.delete(hostId));
      inflight.set(hostId, attempt);
      return attempt;
    },
  };
}

module.exports = { createCloudWake, WAKE_MS, POLL_MS, COOLDOWN_MS };
