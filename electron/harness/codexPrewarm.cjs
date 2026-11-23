// Codex's prewarm hook (electron/session/contract/prewarm.cjs, #1664). It warms two things:
//   - the app-server and what its first turn reads once per process (initialize, config/read and model/list, the
//     user's MCP servers);
//   - the thread a new chat's first send would start, with that send's exact thread/start params.
// Codex writes nothing for a thread with no turn: no rollout, and it is not in thread/list. Windows never hear of the
// thread until a send takes it, since its notifications stay in main (codexEvents.cjs). An unused one is deleted.

const { ISOLATED_THREAD } = require('./codexIsolation.cjs');

/** A value with its object keys in order, so equal params read the same whatever order the window built them in. */
function sorted(v) {
  if (Array.isArray(v)) return v.map(sorted);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => [k, sorted(v[k])]),
  );
}

/**
 * @param {object} o
 * @param {InstanceType<typeof import('./codex.cjs').CodexAdapter>} o.adapter
 * @returns {import('../session/contract/prewarm.cjs').PrewarmHook}
 */
function codexPrewarm({ adapter }) {
  /** The app-server this handle's thread lives in is still the running one (each process gets its own initialize). */
  const same = (h) => !adapter.down && adapter.init === h.init;
  return {
    /** A thread starts with its params (folder, project, model, permission, tier) on the model provider in use. */
    key(spec) {
      const params = spec.params && typeof spec.params === 'object' ? spec.params : null;
      // a temporary chat's thread lives only in the app-server: it starts on send, as before
      if (params?.ephemeral) return null;
      // an isolated chat's (MoMo's) thread is never warmed or claimed: its mark is a symbol, which the key below would drop,
      // so a thread warmed without it could be taken for one that carries it, with Codex's own shell on (#2139)
      if (params?.[ISOLATED_THREAD]) return null;
      // and the servers the MCP gateway runs, whose own copies the thread starts with off (codexThreadContracts.cjs gatewayThreadOff)
      const managed = adapter.tools?.managedSig?.();
      return JSON.stringify(sorted([params, params ? adapter.provider() : null, ...(managed ? [managed] : [])]));
    },
    async warm(spec) {
      await adapter.initialize();
      await adapter.defaults();
      // thread/start reads them before it goes out (codexConnection.cjs request); a composer with no folder yet stops here
      if (adapter.tools) await adapter.userServers();
      const init = adapter.init;
      if (!spec.params) return { result: null, init };
      const result = await adapter.request('thread/start', spec.params, {
        // before thread/started is handled: it is kept from the windows and from the leases
        onAnswer: (r) => r?.thread?.id && adapter.prewarmed.add(r.thread.id),
      });
      if (!result?.thread?.id) throw new Error("Codex didn't start a thread");
      return { result, init };
    },
    // what it warmed lives in the running app-server
    valid: same,
    claim(h) {
      // the warmed process alone leaves the thread to thread/start (a take always names its params, so it rarely gets here)
      if (!h.result) return null;
      const thread = h.result.thread;
      adapter.prewarmed.delete(thread.id);
      // as CodexTurns.startThread does with its own: loaded here, so Sage holds it, and keeps it until its first message
      adapter.unrecorded.add(thread.id);
      adapter.hold(thread.id, thread);
      return h.result;
    },
    dispose(h) {
      const id = h.result?.thread?.id;
      if (!id) return;
      if (!same(h)) return void adapter.prewarmed.delete(id);
      // deleted, not unsubscribed: Codex keeps an unsubscribed thread loaded with its MCP servers running, and a thread
      // with no turn has nothing on disk to delete. Its thread/deleted stays in main and lets go of the id (codexEvents.cjs).
      return adapter.request('thread/delete', { threadId: id }).catch((error) => {
        adapter.prewarmed.delete(id);
        throw error;
      });
    },
  };
}

module.exports = { codexPrewarm, sorted };
