// A basic harness's prewarm hook (electron/session/contract/prewarm.cjs, #1664): the harness's ACP process, spawned and
// initialized while a new chat's composer is open. The session stays on the send, because session/new writes a
// visible session into the harness's own history (opencode lists an empty "New session"), which an unused prewarm
// would leave behind.
const { clock } = require('../platform/ports/clock.cjs');
const { parseKind } = require('../../shared/harnessKind.mjs');
const { parseAcpKey } = require('../session/contract/route.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** How long a process only a prewarm started stays after its composer let it go: a chat opening on it right after a send keeps it. */
const GRACE_MS = 30_000;

/**
 * @param {object} o
 * @param {Pick<InstanceType<typeof import('./acp.cjs').AcpHost>, 'agent' | 'agents' | 'chats' | 'starting'>} o.host
 * @param {number} [o.graceMs]
 * @param {{ setTimeout: typeof setTimeout }} [o.timers]
 * @returns {import('../session/contract/prewarm.cjs').PrewarmHook}
 */
function acpPrewarm({ host, graceMs = GRACE_MS, timers = { setTimeout: clock.setTimeout } }) {
  /** 'opencode' for 'acp:opencode'; a kind that names no basic harness is an error, as everywhere else */
  const harnessOf = (kind) => {
    const basic = parseKind(kind)?.basic;
    if (!basic) throw new Error(`Not a basic harness: ${JSON.stringify(kind)}`);
    return basic;
  };
  /** harness -> prewarm entries (composers in any window) that count on its process now */
  const holders = new Map();
  const hold = (harness, n) => holders.set(harness, (holders.get(harness) ?? 0) + n);
  /** A composer still counts on it, a chat on the harness has it, or a send is opening a session on it. */
  const inUse = (harness) =>
    holders.get(harness) > 0 ||
    [...host.chats.values()].some((c) => c.harness === harness) ||
    [...host.starting.keys()].some((k) => parseAcpKey(k)?.harness === harness);

  /** the processes (their agents-map entries) a prewarm started, which a prewarm may end */
  const own = new Set();

  /** End the process a prewarm started, unless something uses it now or another process took its place. */
  async function endIdle(harness, entry) {
    if (host.agents.get(harness) !== entry || inUse(harness)) return;
    own.delete(entry);
    host.agents.delete(harness);
    (await entry).kill();
  }

  return {
    // one process per harness serves all its chats
    key: (spec) => harnessOf(spec.kind),
    async warm(spec) {
      const harness = harnessOf(spec.kind);
      const started = !host.agents.has(harness);
      await host.agent(harness);
      const entry = host.agents.get(harness);
      if (started) own.add(entry);
      hold(harness, 1);
      return { harness, started, entry };
    },
    // the process it started is still the harness's (it may have exited, and a chat started another)
    valid: (h) => host.agents.get(h.harness) === h.entry,
    dispose(h) {
      hold(h.harness, -1);
      // the last composer counting on a process a prewarm started lets it go; one chats already had is theirs
      if (holders.get(h.harness) > 0 || !own.has(h.entry)) return;
      timers
        .setTimeout(() => endIdle(h.harness, h.entry).catch((error) => noteIgnored("end a basic harness's unused prewarm", error)), graceMs)
        ?.unref?.();
    },
  };
}

module.exports = { acpPrewarm, GRACE_MS };
