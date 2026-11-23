// The phone's direct sessions with its Hosts (#2709, P3 and X3): which machines it holds an enrollment with, one live session each (opened on
// demand, closed when the app goes to the background, the Host leaves the relay or the enrollment is revoked), the cards each Host waits
// on, and an answer sent once per tap. Pure: the relay lane, the vault, the Mac channel and the card store are injected.
import { createPhoneHost, mintKey, REPLACED } from './phoneHost.mjs';
import { enrollDirect, DirectEnrollError } from './phoneDirectEnroll.mjs';
import { fromBase64 } from './envelope.mjs';
import { closedOf } from '../host/approvals.mjs';
import { agentsOf } from '../host/agentReadiness.mjs';
import { shownAgents } from '../host/machineLine.mjs';

/** How long a Host's report of its agents is used before it is asked again. */
export const AGENTS_MS = 60_000;
/** How soon a Host that could not say its agents is asked again. */
export const AGENTS_RETRY_MS = 10_000;
/** How long a Host must have been unreachable, while the Mac says the machine is up, before the phone enrols it again (a Host that is only reconnecting comes back sooner). */
export const HEAL_AFTER_MS = 15_000;
/** How soon after a repair another may be tried for the same machine. */
export const HEAL_RETRY_MS = 600_000;

/**
 * The phone's card store (mobile/src/remote/hostCards.ts), as this module uses it, and a card's state there.
 * @typedef {{ list: (hostKey?: string) => any[], setPending: (hostKey: string, listed: any[], closed?: any[]) => void, sending: (id: string, optionId: string) => void, settle: (id: string, state: any) => void }} CardStore
 * @typedef {{ kind: string, [k: string]: unknown }} CardState
 */

/**
 * The clock `watch` ticks on: the system's. A timer a Node process hands back is let go so a watch nobody stopped does not hold a test open;
 * the phone's own timers are numbers, with nothing to let go.
 * @param {(fn: () => void, ms: number) => any} [every]
 */
export function systemClock(every = (fn, ms) => setInterval(fn, ms)) {
  return {
    setInterval: (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
      const id = every(fn, ms);
      if (typeof id?.unref === 'function') id.unref();
      return id;
    },
    clearInterval: (/** @type {any} */ id) => clearInterval(id),
    now: () => Date.now(),
  };
}

/**
 * @param {object} o
 * @param {import('./crypto.mjs').Primitives} o.prim
 * @param {{ getHosts: () => Promise<Record<string, any>>, putHost: (id: string, r: object) => Promise<unknown>, removeHost: (id: string) => Promise<boolean>, getIdentity: () => Promise<{ ed: { pk: Uint8Array, sk: Uint8Array } }> }} o.vault
 * @param {() => { connect: () => Promise<unknown>, request: (m: any) => Promise<unknown>, send: (f: any) => Promise<unknown>, close: () => void, connected: () => boolean }} o.lane the phone's Host lane on the relay, made once and kept (its frames arrive through `frame`, peers through `peer`)
 * @param {(machineId: string, params: object) => Promise<any>} o.macEnroll `machines.enroll`
 * @param {(machineId: string) => Promise<unknown>} o.macForget `machines.forget`
 * @param {CardStore} o.cards
 * @param {string} o.relayUrl
 * @param {() => string} o.deviceName this phone's name
 * @param {() => void} o.changed told when a machine's set-up state or session changes
 * @param {(machineId: string, line: any) => void} [o.onEvent] a line a machine's Host sent that was not an answer (a chat's frames)
 * @param {(machineId: string) => void} [o.onSessionEnd] a machine's session ended (not replaced by a new connect): chats followed through it are out of date
 * @param {(machineId: string) => void} [o.onForget] direct access to a machine was given up: what the phone kept for it goes
 * @param {{ setInterval: (fn: () => void, ms: number) => any, clearInterval: (id: any) => void, now: () => number }} [o.timers] the clock `watch` ticks on (the global one by default)
 */
export function createPhoneHosts({
  prim,
  vault,
  lane: makeLane,
  macEnroll,
  macForget,
  cards,
  relayUrl,
  deviceName,
  changed,
  onEvent,
  onSessionEnd,
  onForget,
  timers = systemClock(),
}) {
  /** @type {Record<string, any>} */
  let hosts = {};
  /** @type {Map<string, 'working' | 'failed' | 'update'>} */
  const setup = new Map();
  /** Whether the last read of a Host got an answer. @type {Map<string, boolean>} */
  const up = new Map();
  /** One live session at a time per machine. @type {Map<string, ReturnType<typeof createPhoneHost>>} */
  const sessions = new Map();
  /** The idempotency key of a tap, kept until the Host answered so a retry is the same request. @type {Map<string, string>} */
  const keys = new Map();
  /** A set-up that was given up on while it ran. @type {Map<string, number>} */
  const epochs = new Map();
  /** What each Host last reported of its agents, and when. @type {Map<string, { at: number, list: any[] | null, failure?: string }>} */
  const agents = new Map();
  /** The Hosts being asked for their agents now: one question at a time each. @type {Set<string>} */
  const asking = new Set();
  /** @type {ReturnType<typeof makeLane> | null} */
  let lane = null;
  /** The screens that want the cards read now and then (`watch`), the clock they share, and the Hosts being read or tried too lately. @type {Set<{ ms: number }>} */
  const watchers = new Set();
  /** @type {any} */
  let tick = null;
  /** @type {Set<string>} */
  const reading = new Set();
  /** When each Host that did not answer was last tried. @type {Map<string, number>} */
  const lastTry = new Map();
  /** Since when each Host has been found unreachable without an answer in between. @type {Map<string, number>} */
  const downSince = new Map();
  /** The machines the Mac says are up (its own path reaches them), and when each was last repaired. */
  let macUp = new Set();
  /** @type {Map<string, number>} */
  const healed = new Map();
  const RETRY_DOWN_MS = 5000;
  function retime() {
    if (tick !== null) timers.clearInterval(tick);
    tick = null;
    if (watchers.size === 0) return;
    tick = timers.setInterval(
      () => {
        for (const id of Object.keys(hosts)) {
          if (reading.has(id)) continue;
          const last = lastTry.get(id);
          // a Host found down is tried again after a pause, unless this watch has not tried it yet
          if (up.get(id) === false && last !== undefined && timers.now() - last < RETRY_DOWN_MS) continue;
          reading.add(id);
          lastTry.set(id, timers.now());
          void api.refresh(id).finally(() => reading.delete(id));
        }
      },
      Math.min(...[...watchers].map((w) => w.ms)),
    );
  }
  /** A best-effort step: whether it worked. @param {() => Promise<unknown>} step */
  async function tried(step) {
    try {
      await step();
      return true;
    } catch {
      return false;
    }
  }
  const theLane = () => (lane ??= makeLane());
  const byPair = (/** @type {string} */ pair) => Object.entries(hosts).find(([, h]) => h.pairId === pair);

  /** Sends a frame on the lane without waiting for the relay's receipt. @param {any} frame */
  const send = (frame) => {
    const l = theLane();
    if (!l.connected()) return false;
    void tried(() => l.send(frame));
    return true;
  };

  /** The session of a machine, made on first use with the phone's key. @param {string} machineId */
  async function sessionFor(machineId) {
    let s = sessions.get(machineId);
    if (s) return s;
    const { ed } = await vault.getIdentity();
    const h = hosts[machineId];
    s = createPhoneHost({
      prim,
      enrollment: { root: fromBase64(h.root), pairId: h.pairId, hostKey: h.hostKey },
      identity: ed,
      send,
      onEvent: (event) => onEvent?.(machineId, event),
      onState: (state, reason) => {
        const current = sessions.get(machineId) === s;
        if (state === 'closed' && current) sessions.delete(machineId);
        // a chat followed through the session hears of its end (a new connect replacing it is not one)
        if (state === 'closed' && current && reason !== REPLACED) onSessionEnd?.(machineId);
        changed();
      },
    });
    sessions.set(machineId, s);
    return s;
  }

  /** The machine's session, open: the lane first, then the session on it. @param {string} machineId */
  async function opened(machineId) {
    const s = await sessionFor(machineId);
    if (s.state !== 'open') {
      const l = theLane();
      if (!l.connected()) await l.connect();
      await s.connect();
    }
    return s;
  }

  /**
   * The agents the Host says it has (installed, signed in or not), read now and then: a report younger than AGENTS_MS stands, a Host that does
   * not answer keeps the last one. @param {string} machineId @param {ReturnType<typeof createPhoneHost>} s @param {string} name
   */
  async function readAgents(machineId, s, name) {
    const known = agents.get(machineId);
    if ((known && timers.now() - known.at < AGENTS_MS) || asking.has(machineId)) return;
    asking.add(machineId);
    try {
      const status = /** @type {{ harnesses?: any[] }} */ (await s.status());
      // the agents the Mac's own row shows: a missing one the user never runs and a test agent are left out
      const list = shownAgents(agentsOf(Array.isArray(status.harnesses) ? status.harnesses : [], name));
      agents.set(machineId, {
        at: timers.now(),
        list: list.map((a) => ({ id: a.id, label: a.label, state: a.state, reason: a.reason, via: null })),
      });
    } catch (error) {
      // the cards are what this read is for: a Host that cannot say its agents keeps the last report, says why, and is asked again soon
      agents.set(machineId, {
        at: timers.now() - AGENTS_MS + AGENTS_RETRY_MS,
        list: known?.list ?? null,
        failure: /** @type {Error} */ (error).message,
      });
    } finally {
      asking.delete(machineId);
      changed();
    }
  }

  /** Reads the Host's waiting cards over a session opened for it: whether it answered. @param {string} machineId */
  async function readHost(machineId) {
    const h = hosts[machineId];
    if (!h) return false;
    try {
      const s = await opened(machineId);
      up.set(machineId, true);
      downSince.delete(machineId);
      if (!s.supportsCards()) return changed(), false;
      const result = /** @type {{ cards?: any[] }} */ (await s.pending());
      // a reply with no list says nothing about the cards: they stay as they were (a list that is empty says none wait)
      if (Array.isArray(result?.cards)) cards.setPending(h.hostKey, result.cards, closedOf(result));
      // the cards are answered first: a Host slow to name its agents must not hold back the next read of its cards
      void readAgents(machineId, s, h.name);
      changed();
      return true;
    } catch {
      sessions.get(machineId)?.close('The Host could not be read.');
      up.set(machineId, false);
      if (!downSince.has(machineId)) downSince.set(machineId, timers.now());
      changed();
      // a Host that stays down while the Mac reaches the machine has lost its side of the link: the phone enrols it again by itself
      void api.heal(machineId);
      return false;
    }
  }

  /** The reads on their way, one per machine. @type {Map<string, Promise<boolean>>} */
  const reads = new Map();

  const api = {
    /** The agents a Host last reported, or null before it has. @param {string} machineId */
    agents: (machineId) => agents.get(machineId)?.list ?? null,
    /** Why the last read of a Host's agents failed, or null (the last report still stands). @param {string} machineId */
    agentsFailure: (machineId) => agents.get(machineId)?.failure ?? null,
    /** The machine's session, open (a chat's requests go on it). @param {string} machineId */
    session: (machineId) => opened(machineId),
    /** Reads the enrollments the vault holds. */
    async load() {
      hosts = await vault.getHosts();
      changed();
    },
    /** Whether this phone holds an enrollment with the machine. @param {string} machineId */
    enrolled: (machineId) => Object.prototype.hasOwnProperty.call(hosts, machineId),
    /** The enrolled machines, as the phone lists them. */
    records: () => Object.values(hosts).map((h) => ({ machineId: h.machineId, name: h.name, hostKey: h.hostKey })),
    /** True or false once a Host was read, null before. @param {string} machineId */
    reachable: (machineId) => up.get(machineId) ?? null,
    /** What the phone knows of its own link to a machine: read and answered ('up'), read and not answered ('down'), or not read yet or not enrolled ('unknown'). @param {string} machineId @returns {'up' | 'down' | 'unknown'} */
    link: (machineId) => (!api.enrolled(machineId) || !up.has(machineId) ? 'unknown' : up.get(machineId) ? 'up' : 'down'),
    /** The machines the Mac says are up now (a list of ids): the one fact the phone cannot learn from its own path. @param {string[]} ids */
    macSays(ids) {
      macUp = new Set(ids);
      for (const id of ids) void api.heal(id);
    },
    /**
     * Enrols a machine again when its Host cannot be opened and the Mac nonetheless reaches the machine: a Host that lost its relay enrollment
     * (reset, reinstalled) answers nothing on the old one, however healthy the stored record looks. Only after the Host has been down a while,
     * and not again for a while after a try. Says whether a repair was started.
     * @param {string} machineId
     */
    async heal(machineId) {
      const since = downSince.get(machineId);
      if (!hosts[machineId] || up.get(machineId) !== false || since === undefined || !macUp.has(machineId)) return false;
      const now = timers.now();
      if (now - since < HEAL_AFTER_MS || setup.get(machineId) === 'working') return false;
      const last = healed.get(machineId);
      if (last !== undefined && now - last < HEAL_RETRY_MS) return false;
      healed.set(machineId, now);
      void api.setUp(machineId);
      return true;
    },
    /** @param {string} machineId */
    setupState: (machineId) => setup.get(machineId) ?? 'idle',
    /** The machine's Host key, the first part of every card's identity here. @param {string} machineId */
    hostKeyOf: (machineId) => hosts[machineId]?.hostKey ?? null,
    /** A frame the relay delivered on the Host lane. @param {any} frame */
    handleFrame(frame) {
      const found = byPair(frame?.pair);
      if (found) sessions.get(found[0])?.handleFrame(frame);
    },
    /** The relay says a Host came or went: a session of a Host that left is over. @param {{ ev?: string, pair?: string, online?: boolean }} event */
    handleEvent(event) {
      if (event?.ev !== 'peer' || event.online !== false) return;
      const found = byPair(/** @type {string} */ (event.pair));
      if (found) sessions.get(found[0])?.close('The machine left the relay.');
    },
    /** Sets direct access up through the Mac (it must be online once). @param {string} machineId */
    async setUp(machineId) {
      if (setup.get(machineId) === 'working') return;
      const mine = (epochs.get(machineId) ?? 0) + 1;
      epochs.set(machineId, mine);
      setup.set(machineId, 'working');
      changed();
      try {
        const l = theLane();
        if (!l.connected()) await l.connect();
        const identity = await vault.getIdentity();
        const previous = hosts[machineId];
        await enrollDirect({
          prim,
          identity,
          machineId,
          name: deviceName(),
          relayUrl,
          lane: { register: (h) => l.request({ t: 'host.register', ...h }), revoke: (host) => l.request({ t: 'host.revoke', host }) },
          enroll: (params) => macEnroll(machineId, params),
          forget: () => macForget(machineId),
          save: async (record) => {
            await vault.putHost(machineId, record);
            hosts = { ...hosts, [machineId]: record };
          },
          current: () => epochs.get(machineId) === mine,
        });
        setup.delete(machineId);
        // a record that is replaced is not kept: what was read through the old enrollment says nothing of the new one, and its relay credential goes
        sessions.get(machineId)?.close('Direct access was set up again.');
        up.delete(machineId);
        downSince.delete(machineId);
        agents.delete(machineId);
        if (previous && previous.hostId !== hosts[machineId]?.hostId)
          await tried(() => l.request({ t: 'host.revoke', host: previous.hostId }));
      } catch (error) {
        const code = error instanceof DirectEnrollError ? error.code : 'failed';
        // a set-up the person gave up leaves nothing to show
        if (code === 'cancelled') setup.delete(machineId);
        else setup.set(machineId, code === 'update' ? 'update' : 'failed');
      }
      changed();
    },
    /** Gives direct access up: the relay credential goes, the Mac is told, the record goes. Says whether the relay and the Mac both took it (the record goes either way). @param {string} machineId */
    async forget(machineId) {
      epochs.set(machineId, (epochs.get(machineId) ?? 0) + 1);
      const h = hosts[machineId];
      sessions.get(machineId)?.close('Direct access was removed.');
      setup.delete(machineId);
      agents.delete(machineId);
      let complete = true;
      if (h) {
        const l = theLane();
        if (!l.connected()) await tried(() => l.connect());
        complete = (await tried(() => l.request({ t: 'host.revoke', host: h.hostId }))) && (await tried(() => macForget(machineId)));
        await vault.removeHost(machineId);
        const { [machineId]: _gone, ...rest } = hosts;
        hosts = rest;
      }
      onForget?.(machineId);
      changed();
      return { complete };
    },
    /**
     * Reads the Host's waiting cards (the latest list wins) over a session opened for it. A Host that cannot be reached leaves the cards as
     * they were: nothing is queued, and the card stays answerable.
     * @param {string} machineId
     */
    refresh(machineId) {
      // a read already on its way is the answer: a second one would open the session again over it, and the first would read the Host as down
      const going = reads.get(machineId);
      if (going) return going;
      const read = readHost(machineId).finally(() => reads.delete(machineId));
      reads.set(machineId, read);
      return read;
    },
    /** Whether the Host speaks what a card needs ("Update <machine>" when not). @param {string} machineId */
    supportsCards: (machineId) => sessions.get(machineId)?.supportsCards() ?? false,
    /**
     * One tap: the key is minted once for the card and reused by every retry; the Host's reply or refusal settles the card.
     * @param {string} machineId @param {string} machineName @param {string} cardId @param {string} optionId
     * @param {(error: any, machine: string, optionId: string) => CardState} failure
     * @param {(kind: 'allow' | 'deny' | 'other') => CardState} answered
     * @param {object} [form] a question's answer, `{ action, content }`, sent instead of an option
     */
    async answer(machineId, machineName, cardId, optionId, failure, answered, form) {
      const shown = cards.list().find((c) => c.id === cardId);
      const h = hosts[machineId];
      if (!shown || !h) return;
      let key = keys.get(cardId);
      if (!key) keys.set(cardId, (key = mintKey(prim)));
      cards.sending(cardId, optionId);
      try {
        const s = await opened(machineId);
        await s.answer({
          chatId: shown.card.chatId,
          epoch: shown.card.epoch,
          requestId: shown.card.requestId,
          ...(form ? { form } : { optionId }),
          key,
        });
        const kind = shown.card.options.find((o) => o.optionId === optionId)?.kind ?? 'other';
        cards.settle(cardId, answered(kind));
        keys.delete(cardId);
      } catch (error) {
        const state = failure(error, machineName, optionId);
        // a closed card is settled for good; one that could not be reached keeps its key for the retry
        if (state.kind === 'closed') keys.delete(cardId);
        cards.settle(cardId, state);
      }
    },
    /**
     * Reads every enrolled Host's waiting cards every `ms` while a screen that shows them is open, so a card another client answered turns to its
     * receipt within that time. Several screens may watch: the shortest wish rules. A Host that did not answer is tried again after a pause,
     * and a read still on its way is never doubled. Returns the stop.
     * @param {number} ms
     */
    watch(ms) {
      const mine = { ms };
      watchers.add(mine);
      retime();
      return () => {
        watchers.delete(mine);
        retime();
      };
    },
    /** The app went to the background: every session ends and the lane closes; nothing is queued. */
    background() {
      for (const s of [...sessions.values()]) s.close('The app went to the background.');
      lane?.close();
      lane = null;
    },
  };
  return api;
}
