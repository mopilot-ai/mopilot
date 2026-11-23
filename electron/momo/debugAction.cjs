// A MoMo tool for tests (#2139): momo_debug_action makes one change of a test source set to "ask" through MoMo's trust gate, so a fake harness's MoMo turn can raise MoMo's approval card and see what each answer does. main registers it only when SAGE_DEBUG_TOOLS=1 (the E2E runs), for MoMo chats only.
const { ToolError } = require('../capabilities/contract/registry.cjs');
const { LEVELS } = require('./sentinelRules.cjs');
const { recipientsOf } = require('./recipients.cjs');

const TOOL = 'momo_debug_action';
const SOURCE = 'debug';

/**
 * Registers the tool; returns a function that removes it again.
 * @param {InstanceType<typeof import('../capabilities/contract/registry.cjs').Registry>} registry
 * @param {{ trust: ReturnType<typeof import('./trustGate.cjs').createTrustGate>,
 *           sentinel: Pick<InstanceType<typeof import('./sentinel.cjs').Sentinel>, 'setSource'>,
 *           allowed: () => boolean, isMomoChat: (chatId: string) => boolean,
 *           owner: (ctx: { chatId: string, segmentId: string }) => string | null,
 *           harnessOf?: (chatId: string) => string | undefined }} o
 */
function registerMomoDebugAction(registry, { trust, sentinel, allowed, isMomoChat, owner, harnessOf = () => undefined }) {
  sentinel.setSource(SOURCE, { level: LEVELS.ASK, name: 'Test notes' });
  const visibleTo = (/** @type {string} */ chatId) => allowed() === true && isMomoChat(chatId) === true;
  /** @type {string[]} what each allowed call wrote, in order */
  const written = [];
  const off = registry.register({
    name: TOOL,
    policy: 'act',
    authorizesItself: true,
    visibleTo,
    description: 'Write a line to the test notes (tests only); `to` names who it reaches, and `send` makes it a send.',
    schema: {
      type: 'object',
      properties: { text: { type: 'string' }, to: {}, send: { type: 'boolean' } },
      required: ['text'],
    },
    handler: async (/** @type {{ text: string, to?: unknown, send?: boolean }} */ args, /** @type {any} */ ctx) => {
      const chatId = owner(ctx);
      if (!chatId || !visibleTo(chatId)) throw new ToolError(`${TOOL} is unavailable in this chat`, 'unavailable');
      // who it reaches, as MoMo's connector calls do (recipients.cjs): `send` makes it a send, `to` names its recipients
      const { reaches, recipients, unreadable } = recipientsOf(args.send ? 'debug_send' : TOOL, args, 'change');
      const call = {
        chatId,
        tool: TOOL,
        source: SOURCE,
        kind: /** @type {const} */ ('change'),
        args: args.to === undefined ? { text: args.text } : { text: args.text, to: args.to },
        ...(recipients.length || unreadable ? { egress: { recipients, ...(unreadable ? { unknown: true } : {}) } } : {}),
        ...(reaches ? { reaches } : {}),
        summary: `Write “${args.text}” to the test notes`,
        harness: harnessOf(chatId),
      };
      const r = await trust(
        call,
        async () => {
          written.push(args.text);
          return { result: 'done', receipt: 'saved' };
        },
        { signal: ctx.signal ?? null },
      );
      if (!r.ok) throw new ToolError(/** @type {string} */ (r.text), r.reason ?? 'failed');
      return `${r.text} Wrote: ${args.text}`;
    },
  });
  return { off, written };
}

module.exports = { registerMomoDebugAction, TOOL, SOURCE };
