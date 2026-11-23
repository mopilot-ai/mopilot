// Action memory's tools (#3571, G4), the same on every harness's tool channel (Claude Code, Codex, ACP): routine_save
// keeps the chat's browser and app steps since its last save as a routine, routine_run replays one (routineReplay.cjs) and
// routine_list says what is saved. Deleting is the user's, from Settings, never a model's.
const { ToolError } = require('../contract/registry.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { parameterize, describeStep, prefixOf, partOf, partsOf } = require('./routineSteps.cjs');
const { replay, replayReport } = require('./routineReplay.cjs');

const ROUTINE_TOOL_NAMES = ['routine_save', 'routine_run', 'routine_list'];

/**
 * Saves a chat's browser and app steps since its last save as a routine: routine_save, and the "Save as routine" line after a
 * turn (app/ipc/routines.cjs). Refused when that turn left nothing to save.
 * @param {{ store: InstanceType<typeof import('./routineStore.cjs').RoutineStore>, recorder: InstanceType<typeof import('./routineRecorder.cjs').RoutineRecorder>,
 *           unrecorded?: (chatId: string) => string | null }} o unrecorded: the controller that drove one of the chat's surfaces
 *   outside MoPilot's tools (the Codex Browser plugin, Claude in Chrome, Codex Computer Use), by name, else null
 * @param {string} chatId
 * @param {{ name: unknown, description?: unknown, turns?: number }} what turns: how many of the chat's recent turns with steps; all kept when left out
 */
function saveLastTurn({ store, recorder, unrecorded = () => null }, chatId, what) {
  // the schema doesn't check a number's range on every channel
  if (what.turns !== undefined && !(Number.isInteger(what.turns) && what.turns >= 1))
    throw new ToolError('turns is a whole number from 1', 'bad_args');
  const last = recorder.lastTurn(chatId, what.turns);
  if (!last?.steps.length) {
    // a harness's own browser or computer control (its calls never reach the Registry) is said by name
    const other = unrecorded(chatId);
    throw new ToolError(
      other
        ? `Nothing to save: this chat's steps ran through ${other}, which MoPilot can't record.`
        : "Nothing to save: this chat's last turn had no browser or app steps that finished, or it was stopped or failed.",
      'nothing_to_save',
    );
  }
  const { steps, params } = parameterize(last.steps);
  const saved = store.save({
    // a routine with a desktop step is a desktop one (Settings and routine_list tell them apart)
    kind: steps.some((s) => prefixOf(s.tool) === 'desktop_') ? 'desktop' : 'browser',
    name: /** @type {string} */ (what.name),
    description: /** @type {string} */ (what.description),
    steps,
    params,
    prompts: last.prompts,
  });
  recorder.saved(chatId);
  return saved;
}

/** A routine as the model reads it: what it does, its parameters with their recorded values, and its steps. */
function summary(r) {
  const params = r.params.length ? r.params.map((p) => `${p.name} (recorded: ${JSON.stringify(p.example)})`).join(', ') : 'none';
  return `- ${r.name} [${r.id}]${r.description ? `: ${r.description}` : ''}\n  ${r.steps.length} steps; parameters: ${params}; run ${r.runs} time(s)`;
}

/** How a surface is named when it isn't up yet. */
const SURFACE_NAMES = { browser_: 'The built-in browser', chrome_: 'Your Chrome', desktop_: 'Computer use' };

/**
 * @param {object} o
 * @param {InstanceType<typeof import('./routineStore.cjs').RoutineStore>} o.store
 * @param {InstanceType<typeof import('./routineRecorder.cjs').RoutineRecorder>} o.recorder
 * @param {(chatId: string) => boolean} o.tainted whether the chat's turn read something that tried to instruct the agent
 * @param {(prefix: string) => any} o.adapters a surface's adapter (browser_: the in-app browser, chrome_: the user's Chrome,
 *   desktop_: computer use's app-scoped tools), or null before its tools registered
 * @param {(chatId: string, segmentId: string, tool: string, args: any, o: { signal: AbortSignal }) => Promise<any>} o.invoke Registry.invoke
 * @param {(ctx: { chatId: string, segmentId: string }) => boolean} o.current whether the call's segment is the chat's current one
 * @param {(chatId: string) => string | null} [o.unrecorded] the controller outside MoPilot's tools that drove the chat's surface
 * @param {() => string | null} [o.skillsProblem] why new chats can't see the routines as skills, or null
 * @param {() => true | string} [o.enabled]
 */
function createRoutineTools({
  store,
  recorder,
  adapters,
  invoke,
  current,
  unrecorded = () => null,
  skillsProblem = () => null,
  enabled = () => true,
  tainted,
}) {
  /** @type {Set<string>} chats a routine is replaying in now: one at a time per chat */
  const running = new Set();
  const live = () => {
    const on = enabled();
    if (on !== true) throw new ToolError(on, 'unavailable');
  };
  const hasRoutines = () => {
    try {
      return store.list().length > 0;
    } catch (error) {
      // an unreadable store just leaves it deferred
      noteIgnored('see whether there are routines to load routine_run for', error);
      return false;
    }
  };
  /** A routine's steps run on surfaces that are up: refused when one isn't. */
  const surfacesUp = (/** @type {any[]} */ steps) => {
    for (const prefix of new Set(steps.map((s) => prefixOf(s.tool))))
      if (!adapters(prefix)?.up()) throw new ToolError(`${SURFACE_NAMES[prefix]} isn't available yet`, 'unavailable');
  };

  return [
    {
      name: 'routine_save',
      description:
        "Save this chat's browser and app steps since the last save as a routine the user can run again, when the user asks: a task that took several messages is kept whole, each message's steps a part. Typed values become parameters.",
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A short name, such as "Order coffee beans".' },
          description: {
            type: 'string',
            description: 'What the whole task was, in one sentence, so a later chat knows when this applies.',
          },
          turns: {
            type: 'integer',
            minimum: 1,
            description:
              'Leave this out unless earlier messages in this chat were a different task. Then: how many of the recent turns with steps belong to this task.',
          },
        },
        required: ['name'],
      },
      policy: 'act',
      // saving keeps the user's own steps in the user's own store; it acts on nothing outside the app
      authorizesItself: true,
      handler: async (/** @type {any} */ args, /** @type {any} */ ctx) => {
        live();
        const r = saveLastTurn({ store, recorder, unrecorded }, ctx.chatId, args);
        const lines = r.steps.map((s, i) => `${i + 1}. ${describeStep(s)}`).join('\n');
        return `Saved routine ${JSON.stringify(r.name)} [${r.id}] with ${r.steps.length} steps:\n${lines}\nParameters: ${
          r.params.map((p) => p.name).join(', ') || 'none'
        }.`;
      },
    },
    {
      name: 'routine_run',
      // a chat loads it up front once there is a routine to run: its schema is about 170 tokens a request, and a ToolSearch to
      // load it is a whole request (some 47k tokens in the G4 bench). With no routine it stays deferred and costs nothing.
      upFront: hasRoutines,
      description:
        'Read what a saved routine read: its page reads run again and change nothing, and you get what they found and the recorded steps left, for you to do yourself. A routine never acts.',
      schema: {
        type: 'object',
        properties: {
          routine: { type: 'string', description: 'The routine name or id (routine_list).' },
          params: { type: 'object', description: 'Values for its parameters; the rest use what was recorded.' },
          part: { type: 'integer', minimum: 1, description: 'The part to run, for a routine saved from several messages. Default 1.' },
        },
        required: ['routine'],
      },
      policy: 'act',
      // every step is a tool call of its own, which asks the user as a model step would
      authorizesItself: true,
      handler: async (/** @type {any} */ args, /** @type {any} */ ctx) => {
        live();
        const routine = store.get(String(args.routine));
        if (!routine) throw new ToolError(`No routine named ${JSON.stringify(args.routine)}. Call routine_list.`, 'not_found');
        if (running.has(ctx.chatId)) throw new ToolError('A routine is already running in this chat. Wait for it to finish.', 'busy');
        const part = args.part ?? 1;
        const parts = partsOf(routine.steps);
        if (!Number.isInteger(part) || part < 1 || part > parts) throw new ToolError(`${routine.name} has ${parts} part(s)`, 'bad_args');
        // a run does one part: the user's next message decides the next
        const view = { ...routine, steps: routine.steps.filter((s) => partOf(s) === part) };
        const next = routine.steps.filter((s) => partOf(s) === part + 1);
        surfacesUp(view.steps);
        const call = (/** @type {string} */ tool, /** @type {any} */ a, /** @type {{ lookOnly?: { origins: string[] } }} */ o = {}) =>
          invoke(ctx.chatId, ctx.segmentId, tool, a, { signal: ctx.signal, ...o });
        const wasCurrent = current(ctx);
        running.add(ctx.chatId);
        recorder.replayStarted(ctx.chatId);
        /** @type {import('./routineReplay.cjs').ReplayResult | null} */
        let r = null;
        try {
          r = await replay({
            routine: view,
            // the schema holds params to an object
            values: args.params ?? {},
            invoke: call,
            signal: ctx.signal,
            // a switch makes another segment current: only a segment that was current at the start can lose it (a
            // sub-agent thread, or a chat main keeps no record of, never was)
            current: () => !wasCurrent || current(ctx),
            tainted: () => tainted(ctx.chatId),
          });
        } finally {
          running.delete(ctx.chatId);
          recorder.replayEnded(ctx.chatId, { failed: !r || r.status === 'stopped' });
        }
        try {
          store.update(routine.id, routine.rev, { ran: true, handedOff: r.status === 'handoff' });
        } catch (error) {
          // a count that can't be saved never fails the run itself
          noteIgnored("count a routine's run", error);
        }
        if (r.status === 'stopped') throw new ToolError(replayReport(view, r)[0].text, 'aborted');
        return replayReport(view, r, { part, parts, next, values: args.params ?? {} });
      },
    },
    {
      name: 'routine_list',
      description: "List the user's saved routines: name, id, what each does and its parameters.",
      schema: { type: 'object', properties: {} },
      policy: 'observe',
      handler: async () => {
        live();
        const all = store.list();
        if (!all.length) return 'No routines are saved yet.';
        const problem = skillsProblem();
        return `Saved routines:\n${all.map(summary).join('\n')}${problem ? `\nNew chats don't list these as skills: ${problem}` : ''}`;
      },
    },
  ];
}

/**
 * Registers the routine tools; returns a function that unregisters them.
 * @param {{ register: (tool: any) => () => void }} registry
 * @param {Parameters<typeof createRoutineTools>[0]} deps
 */
function registerRoutineTools(registry, deps) {
  const offs = createRoutineTools(deps).map((t) => registry.register(t));
  return () => offs.forEach((off) => off());
}

module.exports = { createRoutineTools, registerRoutineTools, saveLastTurn, ROUTINE_TOOL_NAMES };
