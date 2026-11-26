// The user's own MCP servers in MoPilot's chats on a basic harness (#1575): loaded by default, as Claude Code and the
// Codex app load theirs; turned off, all or some, for MoPilot's chats only (prefs acpMcp) through the harness's own
// layered config (its quirk's mcp), never by editing the user's files. A process reads it when it starts: an idle one
// restarts now, and a busy one when its last turn ends, so no turn is cut off. A server the MCP gateway runs in its
// place (#2999 C4, `managed`) is off too, whatever the choice: the gateway's copy is the one under the user's rules.
const { processesOf } = require('./launch.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/**
 * prefs.acpMcp[harness] as a choice: whether the harness's own servers load, and the ones turned off.
 * @param {any} prefs
 * @param {string} harness
 */
function choiceOf(prefs, harness) {
  const c = prefs?.acpMcp?.[harness];
  const off = Array.isArray(c?.off) ? [...new Set(c.off.filter((n) => typeof n === 'string' && n))].sort() : [];
  return { load: c?.load !== false, off };
}

/**
 * The listed servers a choice turns off: all of them when the harness's own servers don't load; and every one `managed`.
 * @param {{ load: boolean, off: string[] }} choice @param {{ name: string, config?: unknown }[]} servers @param {(entry: unknown) => boolean} [managed]
 */
const offNames = (choice, servers, managed = () => false) =>
  servers.filter((s) => !choice.load || choice.off.includes(s.name) || managed(s.config)).map((s) => s.name);

class OwnMcp {
  /** harness → the servers its running process was started with turned off (JSON), as envFor gave them */
  started = new Map();
  /** harnesses whose process restarts once its turns end */
  pending = new Set();
  /** the choices (and the gateway's servers) changed() last acted on (JSON) */
  choices = '';
  /** @type {((entry: unknown) => boolean) | null} whether the MCP gateway runs a server in its place (set by app/gatewayWiring.cjs) */
  managed = null;
  /** @type {string | undefined} the gateway's managed keys (JSON) changed() last saw */
  gateway = undefined;
  /**
   * @param {{ quirksOf: (h: string) => any, prefs: () => any, env: () => Record<string, string | undefined> }} o
   */
  constructor(o) {
    this.o = o;
    /** @type {any} the AcpHost, once attached */
    this.host = null;
  }

  /** Follow a host: its processes start with envFor, and a pending restart waits for its turns to end. */
  attach(host) {
    this.host = host;
    host.on('event', (e) => {
      // a chat's key is acp:<harness>:<id>
      const harness = String(e.key).split(':')[1];
      // a turn that ended, a session that opened or closed: a restart waiting on the harness may go now
      if (this.pending.has(harness)) this.apply(harness);
    });
  }

  /** The servers the harness's global settings list; none when it can't list them or they can't be read. */
  servers(harness, env = this.o.env()) {
    const mcp = this.o.quirksOf(harness)?.mcp;
    try {
      return mcp ? mcp.servers(env) : [];
    } catch (error) {
      // the overlay is optional: a harness whose servers can't be listed starts as it is
      noteIgnored("list a harness's own MCP servers", error);
      return [];
    }
  }

  /** The env layer a harness's process starts with (AcpHost mcpEnv); it is what that process runs with until it restarts. */
  envFor(harness, env) {
    const mcp = this.o.quirksOf(harness)?.mcp;
    if (!mcp) return {};
    const off = offNames(choiceOf(this.o.prefs(), harness), this.servers(harness, env), this.isManaged);
    this.started.set(harness, JSON.stringify(off));
    return off.length ? mcp.off(off) : {};
  }

  /** What Settings and the chat's note show for a harness. */
  status(harness, readOnly = false) {
    // a restart that waited on a session still opening, or on a start that failed, goes once nothing is working
    if (!readOnly && this.pending.has(harness)) this.apply(harness);
    const q = this.o.quirksOf(harness);
    const choice = choiceOf(this.o.prefs(), harness);
    // a server's entry (its command, arguments, URL) stays in main: Settings is told only whether the gateway runs it
    const servers = this.servers(harness).map(({ config, ...s }) => ({
      ...s,
      off: !choice.load || choice.off.includes(s.name),
      managed: this.isManaged(config),
    }));
    return { harness, label: q?.label ?? harness, supported: !!q?.mcp, load: choice.load, servers, pending: this.pending.has(harness) };
  }

  /** Whether the gateway runs a server entry in the harness's place. */
  isManaged = (/** @type {unknown} */ entry) => this.managed?.(entry) === true;

  /**
   * Prefs changed, or the gateway's servers did (`gateway`: its managed keys, JSON): each running process started with
   * other servers turned off restarts, now or after its turns.
   * @param {string} [gateway]
   */
  changed(gateway = this.gateway) {
    this.gateway = gateway;
    // most pref changes are other settings: only a new choice is worth reading the harnesses' settings again
    const choices = JSON.stringify([this.o.prefs()?.acpMcp ?? {}, gateway ?? null]);
    if (choices === this.choices) return;
    this.choices = choices;
    for (const harness of [...this.started.keys()]) {
      if (!processesOf(this.host, harness).length) {
        this.started.delete(harness);
        this.pending.delete(harness);
        continue;
      }
      const want = JSON.stringify(offNames(choiceOf(this.o.prefs(), harness), this.servers(harness), this.isManaged));
      if (want !== this.started.get(harness)) this.apply(harness);
      else this.pending.delete(harness);
    }
  }

  /** Whether a chat on the harness is working: a turn running, one being sent, or its session still opening. */
  busy(harness) {
    const host = this.host;
    for (const [key, chat] of host.chats) {
      // a chat kept apart (MoMo's) runs on a process of its own, which this restart doesn't touch
      if (chat.harness !== harness || chat.isolated) continue;
      if (chat.prompting || !chat.sessionId || host.starting.has(key)) return true;
    }
    return false;
  }

  /**
   * Restart the harness's process so it reads the current choice: its chats' sessions are let go (each reopens on its
   * next message, from its transcript) and the process stops. One that is working waits for its turns to end.
   */
  apply(harness) {
    const host = this.host;
    const running = processesOf(host, harness);
    if (!running.length) return void this.pending.delete(harness);
    if (this.busy(harness)) return void this.pending.add(harness);
    this.pending.delete(harness);
    this.started.delete(harness);
    for (const { map, slot } of running) map.delete(slot);
    for (const [key, chat] of [...host.chats]) if (chat.harness === harness && !chat.isolated) host.close(key);
    // one that failed to start has nothing to stop; its failure was the start's to report
    for (const { entry } of running)
      entry.then(
        (agent) => agent.kill(),
        (error) => noteIgnored("restart a harness's process", error),
      );
  }
}

module.exports = { OwnMcp, choiceOf, offNames };
