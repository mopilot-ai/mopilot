// What the directory and host tools (directoryTools.cjs, hostActionTools.cjs, worktreeTools.cjs) share: registering a tool
// that answers for one chat on any harness, and putting a card (kind hostAsk) in front of the user.
const { ToolError } = require('../contract/registry.cjs');

/**
 * A function that registers tools for the chat each call comes from; a call from a segment no chat owns is refused.
 * @param {any} registry
 * @param {(ctx: any) => string | null} owner
 */
function toolAdder(registry, owner) {
  return (
    /** @type {string} */ name,
    /** @type {string} */ description,
    /** @type {Record<string, unknown>} */ properties,
    /** @type {string[]} */ required,
    /** @type {(args: any, caller: string, ctx: any) => unknown} */ handler,
  ) =>
    registry.register({
      name,
      description,
      schema: { type: 'object', properties, required, additionalProperties: false },
      // each tool asks the user itself where it changes something
      policy: 'act',
      authorizesItself: true,
      handler: async (/** @type {any} */ args, /** @type {any} */ ctx) => {
        const caller = owner(ctx);
        if (!caller) throw new ToolError('The caller does not own this chat segment', 'no_owner');
        return handler(args, caller, ctx);
      },
    });
}

/**
 * Puts a card to the user and answers whether they allowed it (`choice`: which button, for a card with several); a card
 * that went away unanswered (the call was stopped, the chat ended) or could not be shown is a no.
 * @param {(chatId: string, signal: AbortSignal | null, card: object) => Promise<any>} ask
 * @param {string} caller
 * @param {any} ctx
 * @param {{ title: string, message: string, details?: string[], choices: { id: string, label: string }[], destructive?: boolean }} card
 * @returns {Promise<{ allowed: boolean, choice: string | null }>}
 */
async function askUser(ask, caller, ctx, card) {
  const answer = await ask(caller, ctx.signal, card);
  const allowed = answer?.decision === 'allow';
  return { allowed, choice: allowed && typeof answer.choice === 'string' ? answer.choice : null };
}

/** A count with its noun: "1 worktree", "3 worktrees". */
const plural = (/** @type {number} */ n, /** @type {string} */ one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Bytes as a short size: "12 MB". */
function sizeText(/** @type {number} */ bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) (v /= 1024), i++;
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

module.exports = { toolAdder, askUser, plural, sizeText };
