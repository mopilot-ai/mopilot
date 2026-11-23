// The tool-less reading turn on a Host: one prompt in a fresh, isolated MoMo background chat on MoMo's own harness, with every approval waiting and no answer ever given, so a mail that tells the model to act cannot make anything happen: a tool call stops the turn and fails the reading (which the brief then lists). The chat is removed when the turn ends, whatever the way.
import { createRequire } from 'node:module';
import { subAgentOf } from '../../shared/host/stream2.mjs';

const require = createRequire(import.meta.url);
/** The harness's cheap model at low effort (the one MoMo's other background passes use), or the brain's own where it names none. */
const { cheapBrain } = require('../../electron/momo/cheapBrain.cjs');

/** The longest one reading turn may take before it is stopped. */
export const READ_TIMEOUT_MS = 120_000;
/** The chat tag of these chats: data only (shared/momoChat.mjs MOMO_DATA_TAGS). */
export const NOTICE_TAG = 'brief';

/** @param {string} harness `claude`, `codex` or `acp:<agent>`; a scheduled start names the agent without the `acp:` prefix */
const agentOf = (harness) => (harness.startsWith('acp:') ? harness.slice(4) : harness);

/**
 * @param {object} o
 * @param {{ main: () => { chatId: string, harness: string } | null, startBackground: (harness: string, tag: string) => string, workspace: string }} o.chats MoMo's chats (`home.chats`)
 * @param {{ startScheduled: (p: { chatId: string, task: any }) => unknown, asHost: (method: string, p: any) => unknown }} o.protocol
 * @param {import('node:events').EventEmitter} o.events the runtime's events (a turn's words and end are read there)
 * @param {(message: string) => void} [o.report]
 * @param {number} [o.timeoutMs]
 * @param {(chatId: string) => string[]} [o.toolsOf] the tools the reading chat is offered: none, or the reading is not made (a model that read outside text must have nothing to act with)
 * @param {(brain: { harness: string }) => Promise<{ model?: string, effort?: string }>} [o.cheap] the model and effort a reading runs on: the harness's cheapest, never the main chat's model
 * @returns {import('../../shared/momoNotice/types.d.ts').ReaderModel}
 */
export function createNoticeModel({
  chats,
  protocol,
  events,
  report = () => undefined,
  timeoutMs = READ_TIMEOUT_MS,
  cheap = cheapBrain,
  toolsOf = () => [],
}) {
  return {
    name: 'momo-background',
    async complete(prompt, signal) {
      const main = chats.main();
      if (!main) throw new Error('MoMo has no main chat, so there is no harness to read with.');
      const picked = await cheap({ harness: main.harness });
      const chatId = chats.startBackground(main.harness, NOTICE_TAG);
      // fail closed: a reading chat that is offered any tool is not read with
      const offered = toolsOf(chatId);
      if (offered.length) throw new Error(`The reading chat has tools (${offered.join(', ')}), so it was not asked.`);
      /** @type {any} */
      let resolve;
      /** @type {any} */
      let reject;
      const done = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      /** @param {Error} [error] @param {string} [text] */
      const settle = (error, text) => (error ? reject(error) : resolve(text));
      // a turn that ends while the start is still being answered must not be an unhandled rejection
      done.catch(() => undefined);
      let text = '';
      /** @param {any} e */
      const onEvent = (e) => {
        if (e.key !== chatId) return;
        if (e.kind === 'update' && !subAgentOf(e.update)) {
          const kind = e.update?.sessionUpdate;
          if (kind === 'agent_message_chunk') text += String(e.update.content?.text ?? '');
          // nothing is ever approved here: a call for a tool ends the reading
          else if (kind === 'tool_call') settle(new Error('The model asked for a tool; reading stopped.'));
        } else if (e.kind === 'turnEnd') {
          if (e.stopReason === 'end_turn' && !e.error) settle(undefined, text);
          else settle(new Error('The reading turn did not finish.'));
        }
      };
      events.on('event', onEvent);
      const timer = setTimeout(() => settle(new Error('The reading turn took too long.')), timeoutMs);
      const abort = () => settle(new Error('The reading was cancelled.'));
      signal?.addEventListener('abort', abort, { once: true });
      try {
        await protocol.startScheduled({
          chatId,
          task: {
            harness: agentOf(main.harness),
            prompt,
            cwd: chats.workspace,
            projectId: null,
            onApproval: 'wait',
            ...(picked.model ? { model: picked.model } : {}),
            ...(picked.effort ? { effort: picked.effort } : {}),
          },
        });
        return /** @type {string} */ (await done);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        events.off('event', onEvent);
        // the turn is stopped if it is still going, and the chat goes either way
        await Promise.resolve(protocol.asHost('chat.stop', { chatId })).catch(() => undefined);
        await Promise.resolve(protocol.asHost('chat.remove', { chatId })).catch((/** @type {Error} */ error) =>
          report(`A reading chat could not be removed: ${error.message}`),
        );
      }
    },
  };
}
