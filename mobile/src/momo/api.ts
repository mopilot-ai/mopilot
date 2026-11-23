// The MoMo requests the tab makes, each result checked, plus the owner key that retires a read when the account or computer changes.
import type { MobileRuntime } from '../contracts';
import { momoAllowed, momoBrainSet, parseBrain, parseDocs, parseFacts, parseRoutines, parseSources } from './contract';
import { parsePaused, parseState } from './stateContract';
import { parseTasks, TASKS_METHOD } from './tasksContract';
import { parseSuggestions, SUGGESTIONS_METHOD, SUGGESTION_ACT_METHOD, type SuggestionAction } from './suggestionsContract';
import { MARK_METHOD, parseMarked, parseTaskPanel, type PanelMark } from './taskPanelContract';
import { parseBrainChoice, parseChanges, parsePast, parsePrefs, type BrainChoice, type QuietHours } from './pageContract';

export const ownerKey = (runtime: MobileRuntime) => {
  const s = runtime.snapshot();
  return JSON.stringify([s.user?.id, s.selectedPair, s.generation]);
};

/** What to show for a failure: its message, else the value as text. */
export const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

let sent = 0;
const sendId = () => `${Date.now().toString(36)}-${(sent++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function createMomoApi(runtime: MobileRuntime, channelId: string | null = null) {
  /** a channel's chat (A2) is named in the chat calls; MoMo's main chat is the default */
  const channel = channelId ? { channelId } : {};
  const call = (method: string, params: Record<string, unknown> = {}) => runtime.request(method, params);
  // a message sent again after a failure keeps its id, so the Mac can tell it is the same send
  let last: { text: string; id: string } | null = null;
  return {
    allowed: async () => momoAllowed(await call('machine.hello')),
    /** Sends on MoMo's main chat, which the Mac picks. */
    async send(text: string) {
      const id = last?.text === text ? last.id : sendId();
      last = { text, id };
      await call('momo.chat.send', { id, text, followUp: 'queue' });
      last = null;
    },
    stop: () => call('momo.chat.stop', channel),
    answer: (cardId: string | number, rev: number, key: string) => call('momo.card.answer', { cardId, rev, key, ...channel }),
    brain: async () => parseBrain(await call('momo.brain.get')),
    brainSet: async () => momoBrainSet(await call('machine.hello')),
    /** effort: a level the model offers, null for its default; left out, MoMo keeps the effort it has. */
    setBrain: (brain: {
      harness: string;
      account: string | null;
      model: string | null;
      modelLabel: string | null;
      effort?: string | null;
    }) => call('momo.brain.set', { brain }),
    facts: async (query: string) => parseFacts(await call(query ? 'momo.memory.search' : 'momo.memory.list', query ? { query } : {})),
    editFact: (factId: string, text: string) => call('momo.memory.edit', { factId, text }),
    forgetFact: (factId: string) => call('momo.memory.forget', { factId }),
    docs: async () => parseDocs(await call('momo.memory.docs')),
    sources: async () => parseSources(await call('momo.sources.status')),
    routines: async () => parseRoutines(await call('momo.routines.list')),
    routine: (action: 'pause' | 'resume' | 'run', id: string) => call(`momo.routines.${action}`, { id }),
    approve: (id: string, seen: number) => call('momo.routines.approve', { id, seen }),
    /** The methods the Mac lists in its hello, or null when it lists none (an older Mac): a newer row shows only when its method is there. */
    async methods(): Promise<Set<string> | null> {
      const listed = ((await call('machine.hello')) as { capabilities?: { methods?: unknown } } | null)?.capabilities?.methods;
      return Array.isArray(listed) ? new Set(listed.filter((m): m is string => typeof m === 'string')) : null;
    },
    state: async () => parseState(await call('momo.state.get')),
    /** One field per call, as the Mac takes it; the answer is MoMo's settings after the change. */
    setPaused: async (paused: boolean) => parsePaused(await call('momo.prefs.set', { paused })),
    prefs: async () => parsePrefs(await call('momo.prefs.get')),
    /** One setting per call; the answer is the settings after it. */
    setPref: async (pref: { proactivity: string } | { quietHours: QuietHours }) => parsePrefs(await call('momo.prefs.set', pref)),
    changes: async () => parseChanges(await call('momo.memory.changes')),
    undo: (changeId: string) => call('momo.memory.undo', { changeId }),
    past: async () => parsePast(await call('momo.memory.past')),
    writeAboutYou: (text: string) => call('momo.memory.writeDoc', { doc: 'aboutYou', text }),
    editRoutine: (id: string, edit: { name?: string; prompt?: string }) => call('momo.routines.edit', { id, edit }),
    /** Delete a routine, or decline a suggested one: the same path, as on the Mac. */
    deleteRoutine: (id: string) => call('momo.routines.delete', { id }),
    brainChoice: async () => parseBrainChoice(await call('momo.brain.get')),
    /** The same brain with another effort; the rest of it is sent as it is. */
    setEffort: (brain: BrainChoice, effort: string) => call('momo.brain.set', { brain: { ...brain, effort } }),
    /** The Mac's Tasks list: the cards, loops and runs it derives; a task is done through its source (loopAct, a card's answer). */
    tasks: async () => {
      const reply = await call(TASKS_METHOD);
      // a Mac with the four-tab panel on says `v: 2`: its rows are the panel's, not the classic list's
      const panel = parseTaskPanel(reply);
      return { tasks: panel ? [] : parseTasks(reply), panel };
    },
    /** The user's mark on a routine run, or (with the token it gave) the Undo of one; the token to undo it with, when there is one. */
    markTask: async (taskId: string, mark: PanelMark, undoToken?: string) =>
      parseMarked(await call(MARK_METHOD, { taskId, mark, ...(undoToken ? { undoToken } : {}) })),
    /** What MoMo suggested for Up next (A7), and the user's own Add, Start or Hide on one: Start sends its first step to MoMo's chat on the Mac. */
    suggestions: async () => parseSuggestions(await call(SUGGESTIONS_METHOD)),
    actSuggestion: (id: string, action: SuggestionAction) => call(SUGGESTION_ACT_METHOD, { id, action }),
    /** Try again on the morning brief that could not start: the Mac writes it now. */
    runBrief: () => call('momo.brief.runNow'),
    loopAct: (loopId: string, action: 'done' | 'snooze' | 'dismiss' | 'reopen') =>
      call('momo.loops.act', action === 'snooze' ? { loopId, action, snooze: 'day' } : { loopId, action }),
  };
}
export type MomoApi = ReturnType<typeof createMomoApi>;
