// MoMo's routine tool (#2139, #2285) in the capability registry, the same on every harness: momo_routine_propose, for MoMo's main chat and its channels' chats only, while MoMo is allowed (Registry.servesChat, and again in the handler against the chat that owns the call's segment). It proposes a routine (routines.cjs propose): kept unapproved, it waits in Settings › MoMo › Routines, and only the user's Approve there lets it run (routinesIpc.cjs). So it asks for no card here; its result tells the model where the user approves it.
const { ToolError } = require('../capabilities/contract/registry.cjs');
const { routineRule, WEEKDAYS, RoutineError } = require('../../shared/momoRoutine.mjs');
const { rules } = require('../platform/scheduler.cjs');
const { SOURCE_IDS, sourcesText } = require('./sources/hub.cjs');
const { userError } = require('../../shared/userError.mjs');
const { isMomoConversationMeta } = require('../../shared/momoChat.mjs');

/** A refusal as the agent is told it: by the store's code (bad_args, full, unavailable), else failed. */
function toolError(/** @type {unknown} */ e) {
  if (e instanceof RoutineError) return new ToolError(e.message, e.code);
  const code = /** @type {any} */ (e)?.code;
  if (code === 'not_allowed' || code === 'unavailable') return new ToolError(userError(e), code);
  return new ToolError(`The routine could not be proposed: ${userError(e)}`, 'failed');
}

/** What the tool answers: where the proposal waits, and what the model does next. */
function proposedText(/** @type {any} */ r, /** @type {string[]} */ unconnected) {
  const reads = sourcesText(r.sources);
  const off = unconnected.length
    ? ` ${sourcesText(unconnected)} ${unconnected.length === 1 ? "isn't" : "aren't"} connected yet: the user connects ${unconnected.length === 1 ? 'it' : 'them'} in Settings › MoMo › Sources.`
    : '';
  return [
    `Proposed the routine “${r.name}” (${rules.describe(r.rrule)}${reads ? `; reads ${reads}` : ''}).`,
    'It waits in Settings › MoMo › Routines and runs only after the user approves it there.',
    `${off} Tell the user in a line; don't ask them to approve it in this chat.`.trim(),
  ].join(' ');
}

/**
 * Registers the tool; returns a function that removes it again. `chatMeta(chatId)`: the chat's meta (main writes MoMo's
 * tags), `owner(ctx)`: the chat a call comes from when it owns the call's segment, else null; `connected()`: the sources
 * connected now; `changed()`: tell the routines page.
 * @param {InstanceType<typeof import('../capabilities/contract/registry.cjs').Registry>} registry
 * @param {{ routines: { propose: (input: any) => Promise<any> }, allowed: () => boolean, chatMeta: (chatId: string) => any,
 *   owner?: (ctx: { chatId: string, segmentId: string }) => string | null, connected: () => string[], changed: () => void }} o
 */
function registerRoutineTools(registry, { routines, allowed, chatMeta, owner = () => null, connected, changed }) {
  const main = (/** @type {string} */ chatId) => allowed() === true && isMomoConversationMeta(chatMeta(chatId));
  const off = registry.register({
    name: 'momo_routine_propose',
    policy: 'act',
    // a proposal changes nothing that runs: the user's Approve in Settings is the approval
    authorizesItself: true,
    visibleTo: main,
    description:
      'Propose a MoMo routine: a task MoMo runs on its own on a schedule, with nobody watching (a morning briefing, a weekly check). It waits in Settings › MoMo › Routines until the user approves it there. Give a short name, the schedule (a time with optional days, or an RRULE), what to do each time, and the sources it reads.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A short name, at most 80 characters' },
        prompt: { type: 'string', description: 'What MoMo does each run, as an instruction to itself (at most 2000 characters)' },
        time: { type: 'string', description: 'The time of day, 24-hour HH:MM (with days, or every day)' },
        days: { type: 'array', items: { type: 'string', enum: [...WEEKDAYS] }, description: 'The days it runs (omit: every day)' },
        rrule: {
          type: 'string',
          description: 'Instead of time and days: an RRULE (at most hourly), e.g. FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9',
        },
        sources: { type: 'array', items: { type: 'string', enum: [...SOURCE_IDS] }, description: 'The sources it reads' },
      },
      required: ['name', 'prompt'],
    },
    handler: async (/** @type {any} */ args, /** @type {any} */ ctx) => {
      const chatId = owner(ctx);
      if (!chatId || !main(chatId)) throw new ToolError('MoMo’s routines can be proposed only in MoMo’s main chat', 'unavailable');
      const schedule = routineRule(args);
      if (!schedule.ok) throw new ToolError(schedule.error, 'bad_args');
      let routine;
      try {
        routine = await routines.propose({ name: args.name, prompt: args.prompt, rrule: schedule.rrule, sources: args.sources });
      } catch (e) {
        throw toolError(e);
      }
      changed();
      const on = new Set(connected());
      return proposedText(
        routine,
        (routine.sources ?? []).filter((/** @type {string} */ id) => !on.has(id)),
      );
    },
  });
  return off;
}

module.exports = { registerRoutineTools, proposedText };
