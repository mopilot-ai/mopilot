// Each harness's running processes for the stale-config check (electron/harness/routes.cjs): when each started, whether it is busy, restarting the idle ones that started before their config changed, and what the route turned off in MoPilot.
const { clock } = require('../platform/ports/clock.cjs');
const { parseKind } = require('../../shared/harnessKind.mjs');
const { noteIgnored } = require('../ignored.cjs');
const { processesOf } = require('./acp/launch.cjs');

/**
 * @typedef {{ startedAt: number, busy: boolean }} RouteProcess
 * @typedef {{ restarted: number, busy: number }} RestartResult
 * @typedef {{ list: () => Promise<RouteProcess[]>, restartIdle: (before: number) => Promise<RestartResult>, effects?: () => 'poolingOff'[] }} RouteProcesses
 */

const NONE = { restarted: 0, busy: 0 };

/**
 * Restart an idle Codex app-server (Restart to apply, the idle recycler in codexRecycle.cjs). Stopped on purpose:
 * whoever stopped it connects again, and every window hears it is back.
 */
async function restartCodexServer(s, c) {
  s.stop();
  await c.connect();
  c.onStatus?.({ kind: 'ready' });
}

/**
 * The Codex app-server: one process for every Codex chat. It restarts only while no turn or background
 * terminal runs; the windows then load again as after any restart (codex:status 'ready').
 * While config.toml sends Codex to an endpoint of its own, MoPilot's account pooling (the relay) is off.
 * `chatsBusy`: a Codex chat waits on the user or runs an active goal between its turns (a restart would pause it).
 * @param {{ server: () => any, codex: () => any, background: (codex: any) => Promise<number>, accounts?: () => any, chatsBusy?: () => boolean }} o
 * @returns {RouteProcesses}
 */
function codexProcesses({ server, codex, background, accounts = () => null, chatsBusy = () => false }) {
  const busy = () => (codex()?.running?.size ?? 0) > 0 || chatsBusy();
  return {
    effects: () => {
      const a = accounts();
      return a?.relaySkipped === true && (a.subscriptions?.()?.length ?? 0) > 1 ? ['poolingOff'] : [];
    },
    async list() {
      const s = server();
      return s?.proc && s.startedAt ? [{ startedAt: s.startedAt, busy: busy() }] : [];
    },
    async restartIdle(before) {
      const s = server();
      const c = codex();
      if (!s?.proc || !c || !(s.startedAt < before)) return NONE;
      if (busy() || (await background(c)) > 0) return { restarted: 0, busy: 1 };
      // a turn that started while the background terminals were counted keeps its process
      if (busy() || server() !== s || !s.proc) return { restarted: 0, busy: 1 };
      await restartCodexServer(s, c);
      return { restarted: 1, busy: 0 };
    },
  };
}

/**
 * Claude Code: one CLI process per chat. An idle one ends gracefully and starts again at its chat's next
 * turn, with the same guards as a credential change (electron/harness/claude/sessions.cjs restartIdle).
 * Like that change, it ends a CLI that carries a Remote Control link (the saved bridge is reattached at the next start).
 * @param {{ sessions: () => Map<string, any>, started: Map<string, number>, retire: (key: string) => Promise<unknown>, keepAlive: (tasks: any, sched: any, now: number) => boolean, now?: () => number }} o
 * @returns {RouteProcesses}
 */
function claudeProcesses({ sessions, started, retire, keepAlive, now = () => clock.now() }) {
  const idle = (s, t) =>
    !s.keep && !s.busy && !s.unpersisted && !s.perms?.size && !keepAlive(s.tasks, s.sched, t) && !s.chrome?.holdsPages();
  const live = () => {
    const map = sessions();
    // a process that ended no longer counts
    for (const key of [...started.keys()]) if (!map.has(key)) started.delete(key);
    return [...map].filter(([key]) => started.has(key));
  };
  return {
    async list() {
      const t = now();
      return live().map(([key, s]) => ({ startedAt: /** @type {number} */ (started.get(key)), busy: !idle(s, t) }));
    },
    async restartIdle(before) {
      const t = now();
      const old = live().filter(([key]) => /** @type {number} */ (started.get(key)) < before);
      const stop = old.filter(([, s]) => idle(s, t));
      await Promise.all(stop.map(([key]) => retire(key)));
      return { restarted: stop.length, busy: old.length - stop.length };
    },
  };
}

/**
 * A basic (ACP) harness: a process for all its chats, or one per chat. It restarts only while none of its chats is
 * prompting or opening; their sessions are closed first, so each chat loads its session again at its next turn.
 * @param {{ host: () => any, harness: string }} o the harness id, without 'acp:'
 * @returns {RouteProcesses}
 */
function acpProcesses({ host, harness }) {
  const running = async () => {
    const h = host();
    const found = [];
    for (const { map, slot, entry } of h ? processesOf(h, harness) : []) {
      // an agent that failed to start has no process (its chats already heard why)
      const agent = await entry.catch((error) => (noteIgnored('wait for an ACP agent to start', error), null));
      if (agent) found.push({ map, slot, entry, agent });
    }
    return { h, found };
  };
  const chatsOf = (h, agent) => [...(h?.chats ?? new Map())].filter(([, c]) => c.agent === agent);
  const busyChat = (c) => !!c.prompting || !c.sessionId;
  return {
    async list() {
      const h = host();
      const out = [];
      for (const { entry } of h ? processesOf(h, harness) : []) {
        // only an agent that has finished starting: the list never waits on one still starting (a settled
        // promise answers in a microtask, before the timer)
        const agent = await Promise.race([
          entry.catch((error) => (noteIgnored('read an ACP agent that failed to start', error), null)),
          new Promise((r) => clock.setTimeout(() => r(null), 0)),
        ]);
        if (agent?.startedAt) out.push({ startedAt: agent.startedAt, busy: chatsOf(h, agent).some(([, c]) => busyChat(c)) });
      }
      return out;
    },
    async restartIdle(before) {
      const { h, found } = await running();
      let restarted = 0;
      let busy = 0;
      for (const { map, slot, entry, agent } of found) {
        if (!agent.startedAt || !(agent.startedAt < before)) continue;
        const chats = chatsOf(h, agent);
        if (chats.some(([, c]) => busyChat(c))) {
          busy++;
          continue;
        }
        for (const [key] of chats) h.close(key);
        // the next use starts a fresh process; this one's exit finds no chat left to end
        if (map.get(slot) === entry) map.delete(slot);
        agent.kill();
        restarted++;
      }
      return restarted || busy ? { restarted, busy } : NONE;
    },
  };
}

/**
 * Whether any Codex chat waits on the user or runs an active goal (what the exit gate counts as stopping).
 * @param {{ sessions: () => any, controller: () => any }} o
 */
function codexChatsBusy({ sessions, controller }) {
  return () => {
    const store = sessions();
    for (const id of store?.all?.() ?? []) {
      let kind = null;
      try {
        kind = controller()?.ref(id)?.kind;
      } catch {
        // a chat the controller no longer knows has no Codex work
        continue;
      }
      if (parseKind(kind)?.family !== 'codex') continue;
      const s = store.get(id);
      // the adapter's own record of the goal, not a window's report of it (#2759)
      if (s?.turn === 'running' || s?.turn === 'awaitingUser' || store.goalStatus(id) === 'active') return true;
    }
    return false;
  };
}

/**
 * Each harness kind's processes, from its adapter: the Codex app-server, Claude Code's CLIs, an ACP harness's agent.
 * @param {{ server: () => any, codex: () => any, accounts: () => any, acpHost: () => any, claude: RouteProcesses, background: (codex: any) => Promise<number>, sessions?: () => any, controller?: () => any }} o
 * @returns {(kind: string) => RouteProcesses | null}
 */
function routeProcessesFor({ server, codex, accounts, acpHost, claude, background, sessions = () => null, controller = () => null }) {
  const chatsBusy = codexChatsBusy({ sessions, controller });
  /** @type {Map<string, RouteProcesses | null>} */
  const made = new Map();
  const make = (kind) => {
    const k = parseKind(kind);
    if (k?.family === 'codex') return codexProcesses({ server, codex, background, accounts, chatsBusy });
    if (k?.family === 'claude') return claude;
    if (k?.family === 'acp' && k.basic) return acpProcesses({ host: acpHost, harness: k.basic });
    return null;
  };
  return (kind) => {
    if (!made.has(kind)) made.set(kind, make(kind));
    return made.get(kind) ?? null;
  };
}

module.exports = { restartCodexServer, codexProcesses, claudeProcesses, acpProcesses, routeProcessesFor, codexChatsBusy };
