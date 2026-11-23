// Shared plumbing of the session-management tools (sessionRead.cjs, sessionControl.cjs): how a tool is registered for the
// calling chat, and which session a `session_id` may name, under the same family rules as the linked-session tools in
// sessions.cjs. The caller is always the chat that owns the call's segment, never one an argument names.
const { ToolError } = require('../contract/registry.cjs');
const { isDescendant, resolveMember } = require('../../session/orchestration/family.cjs');

const string = (description) => ({ type: 'string', description });

/**
 * @param {any} registry
 * @param {{ orchestrator: any, owner: (ctx: any) => string | null }} o
 */
function createKit(registry, { orchestrator, owner }) {
  /**
   * Register one tool. `act` tools run their own ownership rules (target()), `irreversible` ones also wait for the user's
   * confirmation card (the registry's approver), `observe` ones only read. `linked: false` marks a tool that never reads the
   * linked-session journal, so it works while that is unavailable.
   */
  const add = (name, description, properties, required, policy, handler, { linked = true } = {}) =>
    registry.register({
      name,
      description,
      schema: { type: 'object', properties, required, additionalProperties: false },
      policy,
      authorizesItself: policy === 'act',
      handler: async (args, ctx) => {
        const chatId = owner(ctx);
        if (!chatId) throw new ToolError('The caller does not own this chat segment', 'no_owner');
        if (linked && orchestrator.unavailable)
          throw new ToolError(`Linked sessions are unavailable: ${orchestrator.unavailable}`, orchestrator.unavailable);
        try {
          return await handler(args, chatId, ctx);
        } catch (error) {
          if (typeof error?.code === 'string') throw new ToolError(error.message, error.code);
          throw error;
        }
      },
    });

  /**
   * The session `raw` names for `caller`.
   * @param {string} caller
   * @param {unknown} raw a session id, its handle, "parent" or "self"
   * @param {object} [rule]
   * @param {boolean} [rule.self] "self" (and the caller's own id) is allowed
   * @param {string} [rule.selfMessage] what a refused "self" is told
   * @param {'family' | 'descendant' | 'child'} [rule.scope] who may be named: any linked session (default), a session the
   *   caller started directly or further down, or one it started directly
   * @param {string} [rule.verb] what the call does, for the refusal ("changed", "deleted")
   * @returns {{ id: string, isSelf: boolean }}
   */
  function target(
    caller,
    raw,
    { self = false, selfMessage = 'This tool does not apply to the calling session.', scope = 'family', verb = 'changed' } = {},
  ) {
    const wanted = String(raw).trim();
    if (!wanted || wanted.length > 300) throw new ToolError('session_id is required.', 'invalid_session');
    if (wanted.toLowerCase() === 'self' || wanted === caller) {
      if (!self) throw new ToolError(selfMessage, 'self_refused');
      return { id: caller, isSelf: true };
    }
    const { journal } = orchestrator;
    const id = resolveMember(journal, caller, wanted, (chatId) => orchestrator.archived(chatId));
    if (!id)
      throw new ToolError(
        `"${wanted}" isn't a session linked to this chat: use list_sessions {"linked": true} for the ids and names you can reach.`,
        'not_linked',
      );
    const who = self ? 'this session or ' : '';
    if (scope === 'descendant' && !isDescendant(journal, id, caller))
      throw new ToolError(`Only ${who}a session this chat started can be ${verb} from here.`, 'not_linked');
    if (scope === 'child' && journal.child(id)?.parentId !== caller)
      throw new ToolError(`Only ${who}a session this chat started directly can be ${verb} from here.`, 'not_linked');
    return { id, isSelf: false };
  }

  return { add, target, string };
}

module.exports = { createKit, string };
