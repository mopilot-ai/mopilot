// MoMo's routine runs on a Host (M1 H3b, designs/momo-m1-home): the app's own routines service (electron/momo/routines.cjs, which takes everything by injection) over the Host's parts, so a routine fires, runs as a turn in a fresh isolated MoMo chat on the Host's own sign-in with every approval waiting, and its result is told to MoMo's main chat, with no app open. The scheduler (./momoScheduler.mjs) lists and runs its tasks through `source`.
import { createRequire } from 'node:module';
import { subAgentOf } from '../../shared/host/stream2.mjs';
import { readyOnOwnSignIn } from './schedules.mjs';

const require = createRequire(import.meta.url);
const { createMomoRoutines } = require('../../electron/momo/routines.cjs');
const { createRoutineReporter } = require('../../electron/momo/routineReport.cjs');

/** The agent id a harness names for a scheduled start: `claude`, `codex` or the ACP agent's own id. @param {string} harness */
const agentOf = (harness) => (harness.startsWith('acp:') ? harness.slice(4) : harness);

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./momoHome.mjs').createMomoHome>} o.home
 * @param {{ startScheduled: (p: { chatId: string, task: any }) => unknown, asHost: (method: string, p: any) => unknown }} o.protocol
 * @param {import('node:events').EventEmitter} o.events the runtime's events (a run's turn ends there)
 * @param {{ has: (id: string) => boolean, get: (id: string) => any }} o.state the sessions' state
 * @param {() => Promise<{ id: string, detected: boolean, signedIn: boolean }[]>} o.harnesses
 * @param {(message: string) => void} o.report
 * @param {() => number} [o.now]
 */
export function createMomoRuns({ home, protocol, events, state, harnesses, report, now = Date.now }) {
  const ready = readyOnOwnSignIn(harnesses);
  /** The harness of each run's chat until its first turn ends: the first message starts the chat, the rest are sent to it. @type {Map<string, string>} */
  const harnessOf = new Map();
  /** The turns that matter, by turn id: a run's (with the words it has said so far) and the one answering a told result. @type {Map<string, { chatId: string, text: string, run: boolean }>} */
  const turns = new Map();
  const chats = () => /** @type {NonNullable<typeof home.chats>} */ (home.chats);
  const workspace = () => chats().workspace;
  /** Chats told a result and waiting for the turn that answers it to start (null) or end (its turn id). @type {Map<string, string | null>} */
  const listening = new Map();

  /** Told to MoMo's main chat as a message no human wrote: it starts a turn there, in the workspace. @param {string} chatId */
  const sendTo = async (chatId, /** @type {any} */ rawItem) => {
    const item = /** @type {{ text: string }} */ (rawItem);
    const harness = harnessOf.get(chatId);
    if (harness) {
      await protocol.startScheduled({
        chatId,
        task: { harness: agentOf(harness), prompt: item.text, cwd: workspace(), projectId: null, onApproval: 'wait' },
      });
    } else {
      // a routine's result is words from outside: from now on, for as long as they are in this chat's context, nothing said in it changes what MoMo remembers
      listening.set(chatId, null);
      const was = await chats().taint(chatId);
      try {
        await protocol.asHost('chat.send', { chatId, text: item.text, cwd: workspace() });
      } catch (error) {
        listening.delete(chatId);
        await chats().untaint(chatId, was);
        throw error;
      }
    }
    return { started: true };
  };

  const build = () =>
    createMomoRoutines({
      // the store as the home has it now: a service that outlives the stores being opened new (a home asked for again, a grant that lapsed and came back) keeps the runs it has under way
      get routines() {
        return /** @type {any} */ (home.stores())?.routines;
      },
      report: createRoutineReporter({
        allowed: () => !!home.stores(),
        held: () => home.prefs.get().paused,
        mainChatId: async () => home.chats?.main()?.chatId ?? null,
        send: sendTo,
      }),
      allowed: () => !!home.stores(),
      now,
      prefs: () => home.prefs.forRoutines(),
      // MoMo's one brain is its main chat's harness
      mainBrain: () => {
        const harness = home.chats?.main()?.harness;
        return harness ? { harness } : null;
      },
      usable: async (/** @type {string} */ kind) => (await ready(agentOf(kind))).ok,
      startChat: async (/** @type {{ harness: string }} */ brain, /** @type {{ momo: string }} */ meta) => {
        const chatId = /** @type {NonNullable<typeof home.chats>} */ (home.chats).startBackground(brain.harness, meta.momo);
        harnessOf.set(chatId, brain.harness);
        return chatId;
      },
      discardChat: (/** @type {string} */ chatId) => protocol.asHost('chat.remove', { chatId }),
      stopChat: (/** @type {string} */ chatId) => protocol.asHost('chat.stop', { chatId }),
      send: sendTo,
      // the Host has no windows to show an input in: the first message is its own text, and an unattended run's approvals wait (`onApproval`)
      sessions: { has: (id) => state.has(id), get: (id) => state.get(id), patch: () => undefined },
    });

  /** The routines service, made once; none while the home has no stores. @type {any} */
  let made = null;
  const service = () => (home.stores() ? (made ??= build()) : null);

  // a run's turn ends: its last words are MoMo's report, a turn that did not end well is told as not finished
  events.on('event', (/** @type {any} */ e) => {
    // a turn is found by its id: only its start names the chat. A run's turn, or the turn that answers a told result (the first to start after it was sent)
    if (e.kind === 'turnStart') {
      if (harnessOf.has(e.key)) turns.set(e.turnId, { chatId: e.key, text: '', run: true });
      else if (listening.get(e.key) === null) {
        listening.set(e.key, e.turnId);
        turns.set(e.turnId, { chatId: e.key, text: '', run: false });
      }
    }
    const turn = turns.get(e.turnId);
    if (!turn) return;
    if (e.kind === 'update' && e.update?.sessionUpdate === 'agent_message_chunk' && !subAgentOf(e.update)) {
      if (turn.run) turn.text += String(e.update.content?.text ?? '');
    } else if (e.kind === 'turnEnd') {
      turns.delete(e.turnId);
      // the turn that answers the words from outside is over; the words stay in the chat's context, so the taint stays
      if (!turn.run) {
        listening.delete(turn.chatId);
        return;
      }
      harnessOf.delete(turn.chatId);
      const completed = e.stopReason === 'end_turn' && !e.error;
      service()
        ?.finished({ chatId: turn.chatId, text: turn.text, completed })
        .catch((/** @type {Error} */ error) => report(`A MoMo run's end could not be told: ${error.message}`));
    }
  });

  return {
    /** What the scheduler lists and runs (./momoScheduler.mjs). */
    source: {
      list: async () => (await service()?.list()) ?? [],
      run: (/** @type {any} */ task) => service()?.run(task),
      failed: (/** @type {any} */ task, /** @type {unknown} */ error) => service()?.failed(task, error),
      // runs a stop cut off: the routines service ends the ones it finds without an owner, and MoMo's chat is told
      interrupted: () => service()?.check(),
    },
  };
}
