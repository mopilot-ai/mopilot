// Auto model routing for a chat's turns. Harness Auto: before a turn reaches its harness, the local router (OpenSquilla's
// SquillaRouter) picks a tier and thinking level, which become the model and effort this turn runs on, never saved as the
// chat's own pick. Global Auto: before the turn starts, HM-Router's results may first move the chat to another harness
// through the ordinary pending switch. Whatever fails leaves the chat's own (Default) selection to run the turn. On an
// ACP agent, whose settings outlive the turn, the chat's next message sets its own model and effort back (acpRestore.cjs).
const { autoModeOf, costTierOf, COST_WEIGHT, effortFor, tierModels } = require('../../shared/autoRoute.mjs');
const { parseKind } = require('../../shared/harnessKind.mjs');
const { saveMeta } = require('../../shared/metaSave.mjs');
const { settleTier } = require('./sticky.cjs');
const { decideHarness } = require('./globalPolicy.cjs');
const { createAcpRestore } = require('./acpRestore.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** How long a turn waits for the router before it runs on the chat's own selection. */
const ROUTE_TIMEOUT_MS = 250;
/** How long a turn waits for Global Auto to read the harnesses before it starts where it is. */
const GLOBAL_TIMEOUT_MS = 500;
/** How long a harness's model list read for Global Auto is reused. */
const CATALOG_TTL_MS = 60_000;
/** What the router reads of a chat: its last few user requests and route decisions (OpenSquilla's input contract). */
const HISTORY_TURNS = 4;
const ROUTE_HISTORY = 5;
/** How much of a request or answer is kept for the next turn's features. */
const KEEP_CHARS = 8000;
/** How many chats Auto remembers; the least recently routed is forgotten first. */
const MEMORY_CHATS = 200;

const clip = (/** @type {string} */ s) => (s.length > KEEP_CHARS ? s.slice(0, KEEP_CHARS) : s);
const errorText = (/** @type {any} */ e) => String(e?.message ?? e);

/**
 * @param {object} o
 * @param {any} o.controller the ChatController: state, ref
 * @param {any} o.chats the ChatsStore: records, patchMeta
 * @param {{ catalogOf(id: string, kind?: string): Promise<{ id: string, efforts: string[], resolved?: string }[]>,
 *   switchHarness(id: string, o: { harness: string }): Promise<unknown>,
 *   settingsOf(id: string): { model?: string | null, effort?: string | null } | null }} o.settings
 * @param {() => Promise<{ route(input: any): Promise<any> } | null>} o.router the loaded router, or null where it can't run
 * @param {{ score(text: string, candidates: { kind: string, models: string[] }[], weight: number): any[] } | null} [o.scorer]
 * @param {{ kinds(): string[], fit(kind: string): Promise<boolean> } | null} [o.harnesses] the harnesses a chat could move to
 * @param {() => any} o.prefs
 * @param {(chatId: string) => void} o.changed the chat's saved config changed (every window reads it again)
 * @param {() => number} [o.now]
 * @param {number} [o.timeoutMs]
 * @param {number} [o.globalTimeoutMs]
 * @param {ReturnType<typeof createAcpRestore>} [o.acp] what has an ACP agent's values set back after an Auto turn
 */
function createAutoRoute({
  controller,
  chats,
  settings,
  router,
  scorer = null,
  harnesses = null,
  prefs,
  changed,
  now = Date.now,
  timeoutMs = ROUTE_TIMEOUT_MS,
  globalTimeoutMs = GLOBAL_TIMEOUT_MS,
  acp = createAcpRestore({ chats, controller, settings, changed }),
}) {
  /** @type {Map<string, any>} what Auto remembers of each chat since the app started, least recently routed first */
  const memory = new Map();
  /** @type {Map<string, { at: number, models: Promise<{ id: string, resolved?: string }[]> }>} Global Auto's recent model list reads, by chat and harness (a login is per chat) */
  const catalogs = new Map();
  const config = (/** @type {string} */ id) => chats.records.get(id)?.meta?.config ?? {};
  /** The chat's Auto mode: its saved one (null once turned off), else the one a new chat's first message carries. */
  const modeOf = (/** @type {string} */ id, /** @type {any} */ item) => {
    const saved = config(id);
    return autoModeOf('autoRoute' in saved ? saved : { autoRoute: item.opts.autoMode });
  };
  const mem = (/** @type {string} */ id) => {
    let m = memory.get(id);
    if (m) memory.delete(id);
    else m = { users: [], answer: '', usage: {}, routeHistory: [], applied: null, down: null, failed: false, failures: 0, started: null };
    memory.set(id, m);
    if (memory.size > MEMORY_CHATS) memory.delete(/** @type {string} */ (memory.keys().next().value));
    return m;
  };
  const show = (/** @type {string} */ id, /** @type {any} */ decision) => {
    try {
      controller.state.patch(id, { autoRoute: { ...decision, at: now() } });
    } catch (error) {
      noteIgnored('show the Auto decision', error);
    }
  };
  const routable = (/** @type {any} */ item) => !!item?.opts && !item.opts.compact && !item.opts.goalRestart;
  /** A deadline: `within(promise, fallback, what)` is the promise's value, or `fallback` once it passes or the promise fails. */
  const deadline = (/** @type {number} */ ms) => {
    /** @type {any} */
    let timer;
    const passed = new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    return {
      within: (/** @type {Promise<any>} */ promise, /** @type {any} */ fallback, /** @type {string} */ what) =>
        Promise.race([promise.catch((error) => (noteIgnored(what, error), fallback)), passed.then(() => fallback)]),
      done: () => clearTimeout(timer),
    };
  };

  /** The router's decision, or why there is none. */
  async function decide(/** @type {any} */ m, /** @type {string} */ text) {
    const r = await router();
    if (!r) throw new Error('The Auto router is not available on this Mac.');
    const input = {
      currentRequest: text,
      historyUser: m.users.slice(-HISTORY_TURNS),
      previousAnswer: m.answer,
      previousUsage: m.usage,
      routeHistory: m.routeHistory.slice(-ROUTE_HISTORY),
      activeTier: m.applied?.tier ?? null,
    };
    /** @type {any} */
    let timer;
    try {
      return await Promise.race([
        r.route(input),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('The Auto router took too long.')), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * ChatController beforeDispatch: an Auto chat's turn gets this turn's model and effort.
   * @param {{ chatId: string, kind: string, item: any }} delivery
   */
  async function beforeDispatch({ chatId, kind, item }) {
    if (kind !== 'turn' || !routable(item)) return;
    // a retried message starts from the chat's own selection, never from what Auto picked for the earlier attempt
    const retry = !!item.opts.autoRoute;
    if (retry) delete item.opts.model, delete item.opts.effort, delete item.opts.autoRoute;
    delete item.opts.autoRestore;
    const harness = controller.ref(chatId).kind;
    const family = parseKind(harness)?.family ?? harness;
    const explicit = { model: item.opts.model, effort: item.opts.effort };
    const pick = await route(chatId, item, family, retry);
    // on an agent, what an earlier Auto turn left goes back with this message, and this pick is written down
    if (family !== 'acp') return;
    const restore = acp.prepare(chatId, { pick, explicit });
    if (restore) item.opts.autoRestore = restore;
  }

  /**
   * This turn's model and effort, set on the message; undefined where the turn runs on the chat's own selection.
   * @param {string} chatId
   * @param {any} item
   * @param {string} family
   * @param {boolean} retry
   * @returns {Promise<{ model: string, effort: string | null } | undefined>}
   */
  async function route(chatId, item, family, retry) {
    const mode = modeOf(chatId, item);
    // a model or effort someone chose (a scheduled task, a Host send) wins
    if (!mode || item.opts.model || item.opts.effort) return;
    const m = mem(chatId);
    // the retry is routed as the same turn, not as one more request after it
    if (retry && m.before?.item === item.id) Object.assign(m, m.before.state);
    const text = String(item.text ?? '').trim();
    const fallback = (/** @type {string} */ reason) => {
      show(chatId, { mode, fallback: true, reason });
      return undefined;
    };
    let catalog = [];
    try {
      catalog = await settings.catalogOf(chatId);
    } catch (error) {
      return fallback(`The harness's models could not be read: ${errorText(error)}`);
    }
    const table = tierModels(catalog, prefs()?.autoRouteTiers?.[family]);
    if (!table) return fallback('This harness lists no models Auto can choose between.');
    if (!text) return fallback('Auto routes a written request; this message runs on the chat’s own model.');
    let decision;
    try {
      decision = await decide(m, text);
    } catch (error) {
      return fallback(errorText(error));
    }
    const settled = settleTier(m.applied ? { tier: m.applied.tier, down: m.down } : null, decision.tier, { failed: m.failed });
    const model = table[/** @type {'C0'} */ (settled.tier)];
    // the ladder only holds models the catalog lists
    const effort = effortFor(decision.thinking, /** @type {{ efforts: string[] }} */ (catalog.find((x) => x.id === model)).efforts);
    item.opts.model = model;
    if (effort) item.opts.effort = effort;
    item.opts.autoRoute = { tier: settled.tier, routerTier: decision.tier, thinking: decision.thinking, intent: decision.intent };
    m.before = {
      item: item.id,
      state: { users: m.users, routeHistory: m.routeHistory, applied: m.applied, down: m.down, failed: m.failed },
    };
    m.users = [...m.users, clip(text)].slice(-HISTORY_TURNS);
    m.routeHistory = [...m.routeHistory, { tier: settled.tier, difficulty: decision.difficulty, margin: decision.margin }].slice(
      -ROUTE_HISTORY,
    );
    m.applied = { model, effort, tier: settled.tier };
    m.down = settled.down;
    m.failed = false;
    m.started = now();
    const held = settled.held ? ` Stays on ${settled.tier} until a cheaper tier is asked for again.` : '';
    show(chatId, { mode, model, effort, tier: settled.tier, intent: decision.intent, reason: `${decision.reason ?? ''}${held}`.trim() });
    return { model, effort };
  }

  /**
   * ChatController onFinished: the answer and how the turn went feed the next decision.
   * @param {{ chatId: string, turnId?: string | null, text?: string | null, completed?: boolean }} completion
   */
  function finished({ chatId, turnId, text, completed }) {
    // a start the harness never took (its turn still has the pending id) is no turn: its retry is routed as the same one
    const taken = !String(turnId ?? '').startsWith('pending-');
    acp.afterTurn(chatId, taken);
    const m = memory.get(chatId);
    if (!m?.started || !taken) return;
    m.answer = clip(String(text ?? ''));
    m.usage = { duration_ms: Math.max(0, now() - m.started) };
    m.failed = completed === false;
    m.failures = m.failed ? m.failures + 1 : 0;
    m.started = null;
    m.before = null;
  }

  /**
   * A harness's models for scoring (an alias by the model it resolves to), reused for a minute; a read still running is
   * shared, never asked again, and a failed one is forgotten.
   */
  function modelsOf(/** @type {string} */ chatId, /** @type {string} */ kind) {
    const key = `${chatId}\n${kind}`;
    const held = catalogs.get(key);
    if (held && now() - held.at < CATALOG_TTL_MS) return held.models;
    const models = settings.catalogOf(chatId, kind);
    catalogs.set(key, { at: now(), models });
    models.catch(() => catalogs.get(key)?.models === models && catalogs.delete(key));
    if (catalogs.size > MEMORY_CHATS) catalogs.delete(/** @type {string} */ (catalogs.keys().next().value));
    return models;
  }

  /**
   * ChatController beforeStart: a Global Auto chat may first move to the harness HM-Router's results favor for this request.
   * Reading the harnesses is bounded: what has not answered in time is left out (or judged by its measured models).
   * @param {{ chatId: string, item: any, stale?: () => boolean }} start stale: the turn was stopped or replaced meanwhile
   */
  async function beforeStart({ chatId, item, stale = () => false }) {
    // what Auto set for this message's earlier attempt is no one's choice
    const chosen = !item.opts.autoRoute && (item.opts.model || item.opts.effort);
    if (!routable(item) || modeOf(chatId, item) !== 'global' || chosen) return;
    if (!scorer || !harnesses || controller.state.get(chatId)?.pendingSwitch) return;
    const text = String(item.text ?? '').trim();
    if (!text) return;
    const current = controller.ref(chatId).kind;
    const saved = config(chatId).autoRouteState ?? {};
    const turns = Number.isInteger(saved.turns) ? saved.turns : 0;
    const m = mem(chatId);
    const wait = deadline(globalTimeoutMs);
    const candidates = (
      await Promise.all(
        [...new Set([current, ...harnesses.kinds()])].map(async (kind) => {
          const fit = kind === current || (await wait.within(harnesses.fit(kind), false, `check ${kind} for Global Auto`));
          if (!fit) return null;
          const models = await wait.within(modelsOf(chatId, kind), [], `read ${kind}'s models for Global Auto`);
          return { kind, models: models.map((/** @type {any} */ x) => x.resolved ?? x.id) };
        }),
      ).finally(wait.done)
    ).filter((c) => c !== null);
    const scores = scorer.score(text, candidates, COST_WEIGHT[costTierOf(prefs())]);
    const verdict = decideHarness({
      turns,
      current,
      scores,
      lead: m.lead ?? null,
      lastSwitch: saved.switchedAt ?? null,
      failures: m.failures,
    });
    // a Stop while the harnesses were read: the chat stays where it is, and the turn counts for nothing
    if (stale()) return;
    m.lead = verdict.lead;
    let switchedAt = saved.switchedAt ?? null;
    if (verdict.target) {
      try {
        await settings.switchHarness(chatId, { harness: verdict.target });
        // a Stop while the switch was checked: the switch it recorded is taken back
        if (stale()) {
          if (controller.state.get(chatId)?.pendingSwitch?.harness === verdict.target)
            controller.state.patch(chatId, { pendingSwitch: null });
          return;
        }
        switchedAt = turns;
        // the next harness starts its own ladder and history
        Object.assign(m, { applied: null, down: null, failures: 0, lead: null });
      } catch (error) {
        noteIgnored('move a Global Auto chat to another harness', error);
      }
    }
    const next = { ...config(chatId), autoRouteState: { turns: turns + 1, switchedAt } };
    if (saveMeta(chats, chatId, { config: next })) changed(chatId);
    show(chatId, { mode: 'global', harness: verdict.target ?? current, reason: verdict.reason });
  }

  return { beforeDispatch, beforeStart, finished, forget: (/** @type {string} */ id) => memory.delete(id) };
}

module.exports = { createAutoRoute, ROUTE_TIMEOUT_MS, GLOBAL_TIMEOUT_MS, MEMORY_CHATS };
