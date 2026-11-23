// Action memory's recorder (#3571, G4): the browser_* tools a chat's turn ran, on any harness, as replayable steps. Each
// acting call's targets are anchored just before it runs (routineAnchor.cjs) and its steps kept once it succeeded. When
// the turn ends completed (ChatController onFinished), its steps become the chat's last turn, which routine_save keeps;
// a stopped, crashed or failed turn keeps nothing. A run of a routine never changes it: it reads and hands back a plan.
const { noteIgnored } = require('../../ignored.cjs');
const { browserAdapter } = require('./routineAnchor.cjs');
const { desktopAdapter } = require('./routineDesktop.cjs');
const { elementAt } = require('../tools/appScopedUtil.cjs');
const P = require('../contract/desktopPolicy.cjs');

/** Where a coordinate in a desktop screenshot lands among its window's elements (tools/appScopedUtil.cjs). */
const DESKTOP_GEOMETRY = { elementAt, toPoints: P.toPoints };
const {
  stepsOfCall,
  callsOf,
  targetKey,
  baseOf,
  prefixOf,
  DATA_READS,
  PARTIAL,
  failedStep,
  reportedFailure,
} = require('./routineSteps.cjs');
const { MAX_STEPS } = require('./routineStore.cjs');
const { scrub } = require('../../../shared/scrub.cjs');

/** The browser tools a recording reads (and the chrome_* tools that run them); the rest only look and are never wrapped. */
const RECORDED = new Set([
  'browser_navigate',
  'browser_tabs_create',
  'browser_tabs_select',
  'browser_tabs_close',
  'browser_request_signin',
  'browser_request_credentials',
  'browser_computer',
  'browser_form_input',
  'browser_javascript_exec',
  'browser_handle_dialog',
  'browser_file_upload',
  'browser_batch',
  'browser_script',
  'browser_get_page_text',
  'browser_read_page',
]);

/** How many of a chat's recent turns with steps stay saveable together: a task the user led message by message. */
const MAX_PARTS = 5;
/** A turn this small (a page read) offers nothing worth saving; routine_save can still keep it. */
const MIN_OFFER_STEPS = 3;
/** How much of a message a routine keeps to match later ones against. */
const MAX_PROMPT = 4000;

/** @typedef {{ steps: any[], failed: boolean, overflow: boolean, ran: boolean, prompt?: string | null }} Turn ran: a routine ran in the turn */

class RoutineRecorder {
  /**
   * @param {{ store: InstanceType<typeof import('./routineStore.cjs').RoutineStore> }} o
   */
  constructor(o) {
    this.o = o;
    /** @type {Map<string, any>} per family (browser_, chrome_, desktop_): its adapter (routineAnchor.cjs, routineDesktop.cjs) */
    this.adapters = new Map();
    /** @type {Map<string, Turn>} chat id -> the turn running now */
    this.turns = new Map();
    /** @type {Map<string, { steps: any[], prompt: string | null }[]>} chat id -> its recent completed turns with steps, oldest first */
    this.last = new Map();
    /** @type {Map<string, string>} chat id -> the message that started its turn */
    this.prompts = new Map();
    /** @type {Set<string>} chats a routine is replaying in: its steps are added by the replay itself */
    this.replaying = new Set();
  }

  #turn(/** @type {string} */ chatId) {
    let t = this.turns.get(chatId);
    if (!t)
      this.turns.set(chatId, (t = { steps: [], failed: false, overflow: false, ran: false, prompt: this.prompts.get(chatId) ?? null }));
    return t;
  }

  #add(/** @type {string} */ chatId, /** @type {any[]} */ steps, recovers = true) {
    const t = this.#turn(chatId);
    if (recovers) t.failed = false;
    if (t.steps.length + steps.length > MAX_STEPS) t.overflow = true;
    else t.steps.push(...steps);
  }

  /**
   * A call that runs several actions failed: what it did first is part of the task and can't be told from the call, so a
   * replay stops here. Leaving it out replayed the next step on a form never filled (G4 matrix: customers told the wrong
   * issue keys).
   */
  #partlyDone(/** @type {string} */ chatId, /** @type {string} */ tool) {
    if (PARTIAL.has(baseOf(tool))) this.#add(chatId, [failedStep(tool)], false);
  }

  /**
   * A tool definition whose handler records its calls (a browser tool a recording reads), or the tool as it is.
   * @template {{ name: string, handler: (args: any, ctx: any) => any }} T
   * @param {T} tool
   * @returns {T}
   */
  wrap(tool) {
    // every desktop_* tool: one a replay can't run is still kept, as a step it hands off at
    if (!RECORDED.has(baseOf(tool.name)) && prefixOf(tool.name) !== 'desktop_') return tool;
    const handler = tool.handler;
    return {
      ...tool,
      handler: async (args, ctx) => {
        const chatId = ctx?.chatId;
        const family = this.adapter(prefixOf(tool.name));
        if (!chatId || !family?.up() || this.replaying.has(chatId)) return handler(args, ctx);
        const looks = DATA_READS.has(baseOf(tool.name));
        const targets = callsOf(tool.name, args).some((c) => targetKey(c.args));
        let before = { anchors: new Map(), url: null };
        try {
          before = targets ? await family.anchorsBefore(chatId, tool.name, args) : { anchors: new Map(), url: family.url(chatId) };
        } catch (error) {
          // recording must never keep a call from running: its step is kept unanchored
          noteIgnored('anchor a browser step for action memory', error);
        }
        let out;
        try {
          out = await handler(args, ctx);
        } catch (error) {
          // a read that failed changed nothing, so the turn's work stands; and one that worked doesn't undo a failed action
          if (!looks) this.#turn(chatId).failed = true;
          this.#partlyDone(chatId, tool.name);
          throw error;
        }
        if (PARTIAL.has(baseOf(tool.name)) && reportedFailure(out)) {
          this.#turn(chatId).failed = true;
          this.#partlyDone(chatId, tool.name);
          return out;
        }
        this.#add(chatId, stepsOfCall(tool.name, args, before.anchors, before.url), !looks);
        return out;
      },
    };
  }

  /** The user's message that starts a chat's next turn, without any secret in it, or null for input no user wrote. */
  turnStarting(/** @type {string} */ chatId, /** @type {string | null} */ text) {
    if (text?.trim()) this.prompts.set(chatId, scrub(text).slice(0, MAX_PROMPT));
    else this.prompts.delete(chatId);
  }

  /** A family's adapter (browser_, chrome_, desktop_): how its targets are anchored and found again; null before it registered. */
  adapter(prefix = 'browser_') {
    return this.adapters.get(prefix) ?? null;
  }

  /**
   * A registry whose register() records the tools it is given, where each family registers: app/browserTools.cjs for
   * browser_* and chrome_* (`source`: the chats' tabs those tools drive, or a function giving them), app/agentTools.cjs
   * for desktop_* (`source`: a function giving the app-scoped control).
   * @param {{ register: (tool: any) => () => void }} registry
   * @param {any} source
   * @param {'browser_' | 'chrome_' | 'desktop_'} [prefix] the family the tools are in
   */
  recording(registry, source, prefix = 'browser_') {
    this.adapters.set(prefix, prefix === 'desktop_' ? desktopAdapter(source, DESKTOP_GEOMETRY) : browserAdapter(source));
    return new Proxy(registry, {
      get: (target, prop) => {
        if (prop === 'register') return (/** @type {any} */ tool) => target.register(this.wrap(tool));
        const v = /** @type {any} */ (target)[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  }

  /** A routine starts reading in a chat's turn: its reads are not the turn's own steps, and the turn is no new task to save. */
  replayStarted(/** @type {string} */ chatId) {
    this.#turn(chatId).ran = true;
    this.replaying.add(chatId);
  }

  /** The reading ended; the model's own calls are recorded again. A run that didn't finish leaves the turn unverified. */
  replayEnded(/** @type {string} */ chatId, /** @type {{ failed?: boolean }} */ how) {
    this.replaying.delete(chatId);
    if (how.failed) this.#turn(chatId).failed = true;
  }

  /**
   * What the chat's recent completed turns left to save, each step marked with its part (its turn, from 1): all of
   * them, or its last `turns`. Null when nothing is kept.
   * @param {string} chatId @param {number} [turns]
   */
  lastTurn(chatId, turns) {
    const kept = this.last.get(chatId);
    if (!kept) return null;
    const chosen = turns ? kept.slice(-turns) : kept;
    return {
      steps: chosen.flatMap((turn, i) => turn.steps.map((s) => ({ ...s, part: i + 1 }))),
      prompts: chosen.map((turn) => turn.prompt),
    };
  }

  /** What was kept is a routine now: the chat's next task starts its own. */
  saved(/** @type {string} */ chatId) {
    this.last.delete(chatId);
  }

  /**
   * The chat's turn ended; `completed`: it finished, with no Stop, crash or error (ChatController onFinished). A
   * completed turn's steps become its last turn. Returns whether the turn left something to offer to save.
   * @param {string} chatId
   * @param {boolean} completed
   */
  turnFinished(chatId, completed) {
    const t = this.turns.get(chatId);
    this.turns.delete(chatId);
    this.prompts.delete(chatId);
    this.replaying.delete(chatId);
    const ok = !!t && completed && !t.failed && !t.overflow;
    if (!ok || !t) {
      // a turn with no browser steps leaves the chat's earlier last turn as it was
      if (t) this.last.delete(chatId);
      return { offer: false };
    }
    // a routine's own run is no new task to save
    if (t.ran) {
      this.last.delete(chatId);
      return { offer: false };
    }
    // a turn that only looked adds no part, and leaves the chat's earlier turns saveable
    if (!t.steps.length) return { offer: false };
    const kept = [...(this.last.get(chatId) ?? []), { steps: t.steps, prompt: t.prompt ?? null }].slice(-MAX_PARTS);
    const count = () => kept.reduce((n, turn) => n + turn.steps.length, 0);
    while (count() > MAX_STEPS) kept.shift();
    this.last.set(chatId, kept);
    return { offer: count() >= MIN_OFFER_STEPS };
  }

  /** The chat was deleted or unloaded: nothing of it is kept. */
  forget(/** @type {string} */ chatId) {
    this.turns.delete(chatId);
    this.last.delete(chatId);
    this.prompts.delete(chatId);
    this.replaying.delete(chatId);
  }
}

module.exports = { RoutineRecorder, RECORDED, MAX_PARTS, MIN_OFFER_STEPS };
