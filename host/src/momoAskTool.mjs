// MoMo's tool for asking the owner something with a few answers to tap (#5474 "asks first"): `momo_ask`. The question is a row in MoMo's chat; the owner's answer (an intent, host/src/momoGateIntents.mjs) is kept once, and the model, asking again, is given it once. A question never asks to act: that is an approval card, which the gate raises. Only MoMo's main chat asks (a background run reads and never prompts).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ToolError } = require('../../electron/capabilities/contract/registry.cjs');
const { momoListed } = require('../../electron/momo/contract/toolIsolation.cjs');

export const ASK_TOOL = 'momo_ask';

/**
 * @param {object} o
 * @param {InstanceType<typeof import('../../electron/capabilities/contract/registry.cjs').Registry>} o.registry
 * @param {{ service: (id: string) => any, granted: () => boolean, stores: () => unknown, machine: () => string, chats: { isMomoChat: (chatId: string) => boolean }, gate?: { taintFor: (chatId: string) => { tainted: () => boolean } } | null }} o.home
 * @param {(ctx: { chatId: string, segmentId: string }) => string | null} o.owner the chat a call comes from, when that chat owns the call's segment
 * @returns {() => void} takes it out again
 */
export function registerAskTool({ registry, home, owner }) {
  const allowed = () => home.granted() && !!home.stores();
  const listed = momoListed((/** @type {string} */ chatId) => allowed() && home.chats.isMomoChat(chatId), allowed);
  return registry.register({
    name: ASK_TOOL,
    policy: 'observe',
    visibleTo: listed,
    description:
      'Ask the owner one question with 2 to 6 short answers to tap, when you need their choice before going on. Never to ask permission to act (that is an approval). After asking, wait: ask the same question again later to be given their answer.',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The question, one short sentence' },
        body: { type: 'string', description: 'A line of context, optional' },
        options: { type: 'array', items: { type: 'string' }, description: 'The answers to tap, 2 to 6, each short and different' },
      },
      required: ['title', 'options'],
    },
    handler: async (/** @type {any} */ args, /** @type {any} */ ctx) => {
      const chatId = owner(ctx);
      if (!chatId) throw new ToolError("MoMo's questions are unavailable in this chat", 'unavailable');
      // a chat that read outside content could be asked by that content to put its own words in front of the owner or to fill the waiting places: there MoMo says in the chat what it needs
      // no gate, or a chat that read outside content: no question card (an unknown chat or a missing gate counts as tainted, as everywhere else)
      if (!home.gate || home.gate.taintFor(chatId).tainted())
        throw new ToolError(
          'You cannot ask the owner a question card in this chat, because it has read outside content. Say in the chat what you need them to answer.',
          'unavailable',
        );
      const asked = await home.service('questions').ask({ chatId, title: args.title, body: args.body, options: args.options });
      if (asked.state === 'away') throw new ToolError(`MoMo can't ask on ${home.machine()} right now.`, 'unavailable');
      if (asked.state === 'invalid') throw new ToolError('A question needs a short title and 2 to 6 different, short answers.', 'invalid');
      if (asked.state === 'full')
        throw new ToolError('The owner has too many questions waiting: do not ask more until they answer some.', 'invalid');
      if (asked.state === 'answered')
        return `The owner answered "${asked.label}" to "${asked.question.title}". Go on from that; do not ask again.`;
      throw new ToolError(
        `The owner has been asked "${asked.question.title}". Do not choose for them and do not ask again now: when they have answered, ask the same question again to be given the answer.`,
        'question_pending',
      );
    },
  });
}
