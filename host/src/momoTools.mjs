// MoMo's tools in this Host's own registry (M1 H2b, designs/momo-m1-home): MoMo's memory and open-loop tools, run by the Host itself and so with no app connected, offered to MoMo's chats and to no other, behind a gate that lets through only these (every other tool a MoMo chat asks for, the paired app's relayed ones included, is refused until the trust gate and its cards arrive with H3).
import { createRequire } from 'node:module';
import { ASK_TOOL, registerAskTool } from './momoAskTool.mjs';
import { NOTES_TOOL, registerNotesTool } from './momoNotesTool.mjs';

const require = createRequire(import.meta.url);
const { ToolError } = require('../../electron/capabilities/contract/registry.cjs');
const { momoTool } = require('../../electron/momo/contract/toolIsolation.cjs');
const { ownerOf } = require('../../electron/platform/segmentOwner.cjs');
const { registerMemoryTools } = require('../../electron/momo/memoryTools.cjs');
const { registerLoopTools } = require('../../electron/momo/loopTools.cjs');
const { createLoopActs } = require('../../electron/momo/loopActs.cjs');

/** The prefix of the chat the app's Codex tool sessions stand for until their thread is named: the Host has no such path. */
const PENDING = 'momo-pending:';

/** Whether a call changes what MoMo remembers: a save or a forget, or any act on a loop but listing them. @param {string} tool @param {any} args */
const writes = (tool, args) =>
  tool === 'momo_memory_save' ||
  tool === 'momo_memory_forget' ||
  tool === NOTES_TOOL ||
  // an unprompted run reads and never prompts the owner: asking is kept to the main chat the way a write is
  tool === ASK_TOOL ||
  (tool === 'momo_open_loops' && args?.action !== 'list');

/** The tools this Host runs for MoMo; the gate lets nothing else through. */
export const MOMO_TOOLS = Object.freeze([
  'momo_memory_search',
  'momo_memory_save',
  'momo_memory_forget',
  'momo_open_loops',
  NOTES_TOOL,
  ASK_TOOL,
]);

/**
 * A store as the home has it now: its methods run on the open store, or are refused while there is none (not granted, no home).
 * @param {{ stores: () => null | Record<string, any>, machine: () => string }} home @param {string} name
 * @returns {any}
 */
export const storeOf = (home, name) =>
  new Proxy(
    {},
    {
      get:
        (_target, key) =>
        (/** @type {unknown[]} */ ...args) => {
          const s = home.stores();
          if (!s) throw new ToolError(`MoMo is not available on ${home.machine()} right now`, 'unavailable');
          return s[name][key](...args);
        },
    },
  );

/**
 * @param {object} o
 * @param {InstanceType<typeof import('../../electron/capabilities/contract/registry.cjs').Registry>} o.registry the Host's registry (./tools.mjs)
 * @param {{ granted: () => boolean, machine: () => string, stores: () => null | { memory: any, loops: any }, chats: { isMomoChat: (chatId: string) => boolean, isMain: (chatId: string) => boolean, carriesMemory: (chatId: string) => boolean } | null, gate?: { run: (call: { chatId: string, tool: string, args: any, origin?: 'chat' | 'task' | 'unprompted' }, run: () => unknown) => Promise<unknown>, tools?: { has: (tool: string) => boolean } } | null }} o.home
 * @param {{ chats: { records: Map<string, any> } }} o.sessions
 * @returns {() => void} takes them out again
 */
export function registerMomoTools({ registry, home, sessions }) {
  const lazy = (/** @type {'memory' | 'loops'} */ name) => storeOf(home, name);
  const chats = /** @type {NonNullable<typeof home.chats>} */ (home.chats);
  // MoMo's tools are offered only while MoMo can run here: an account granted, a home made (opening its stores on first use)
  const allowed = () => home.granted() && !!home.stores();
  const owner = (/** @type {{ chatId: string, segmentId: string }} */ ctx) => ownerOf(sessions.chats.records, ctx);
  // a MoMo chat sees only MoMo's tools by their names, and a coding chat none of them: kept apart by the one predicate the veil, the
  // isolation and the tools' own visibility use (a chat's id, its record and the registry), never by its record alone, and a
  // Codex tool session's placeholder chat (the app's, which the Host has no path for) is kept apart and offered nothing
  const apart = (/** @type {string} */ chatId) => chats.isMomoChat(chatId) || chatId.startsWith(PENDING);
  // a data chat (a brief, a reading turn) is offered NO tool: it reads outside text and may not act or remember; only MoMo's own chats see MoMo's tools
  registry.setChatScope(
    (/** @type {string} */ name, /** @type {string} */ chatId) =>
      !chatId.startsWith(PENDING) && momoTool(name) && chats.carriesMemory(chatId),
    apart,
  );
  registry.setChatGate(async ({ chatId, tool, args }, run) => {
    if (!MOMO_TOOLS.includes(tool) && !home.gate?.tools?.has(tool))
      throw new ToolError(`${tool} isn't available to MoMo on ${home.machine()} yet, so it didn't run.`, 'unavailable');
    // what MoMo remembers changes only from its main chat, where the user's own words are (origin 'chat'): a background run is given words from outside (a page, a mail, a tool result) and a note it saved
    // on their say-so would reach every later chat, so a run reads and never writes (the memory rule, README). Whether outside content is in the main chat is the gate's to say: it turns that write into a card with the exact line
    const origin = chats.isMain(chatId) ? 'chat' : 'unprompted';
    if (writes(tool, args) && origin !== 'chat')
      throw new ToolError(
        "A run in the background can read what MoMo remembers but can't change it: tell the user what you found, and let them say what to keep.",
        'read_only',
      );
    // every call passes the trust gate (the gate lane's `home.gate`): it answers, refuses or asks a card first, and the call runs only if it lets it. With no gate NOTHING runs, a read included: the gate is what says a read may go without a card
    const gate = home.gate;
    if (!gate) throw new ToolError(`MoMo's gate is not available on ${home.machine()}, so this did not run.`, 'unavailable');
    return gate.run({ chatId, tool, args, origin }, run);
  });
  const offs = [
    registerMemoryTools(registry, { store: lazy('memory'), allowed, isMomoChat: chats.isMomoChat, owner }),
    registerNotesTool({ registry, home: /** @type {any} */ (home), owner }),
    registerAskTool({ registry, home: /** @type {any} */ (home), owner }),
    registerLoopTools(registry, {
      loops: lazy('loops'),
      act: createLoopActs({ loops: lazy('loops'), dismissed: () => undefined }),
      allowed,
      isMomoChat: chats.isMomoChat,
      owner,
    }),
  ];
  return () => {
    for (const off of offs.flat()) off();
  };
}
