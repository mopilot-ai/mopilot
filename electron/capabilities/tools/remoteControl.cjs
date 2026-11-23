// The Remote Control tool, as Claude Desktop's ccd_session_mgmt set_remote_control: turn the link between a session and the
// user's claude.ai account on or off. The link is Claude Code's own (the Agent SDK's enableRemoteControl), so a chat on
// Codex or an admitted ACP harness is told plainly that it cannot have one, never that it worked. The calling chat is
// always the session that changes.
const { ToolError } = require('../contract/registry.cjs');

/** What the model is told for a chat that is not on Claude Code, with what to do next. */
const UNSUPPORTED = {
  codex:
    "Remote Control is Claude Code's link to claude.ai, and this chat runs on Codex, which has no per-chat equivalent here (its remote control links the whole app server to a paired phone). Nothing changed. Tell the user.",
  acp: "Remote Control is Claude Code's link to claude.ai, and this chat runs on another harness that has no equivalent. Nothing changed. Tell the user.",
};
const NOT_RUNNING =
  "That session's Claude Code process isn't running, so it can't be linked now. Nothing changed. Remote Control can be turned on once the session has run a turn.";
const ON =
  "Remote Control is on: the user can follow and steer this session from claude.ai/code or the Claude app. The link is in the composer's Remote Control badge; don't repeat it.";
const NOT_SELF =
  'This tool changes the session you are in: use session_id "self" or leave it out. Nothing changed. Another session\'s Remote Control is the user\'s to change from its own chat.';
const PENDING = {
  offline: 'Remote Control is not up yet: the network is down. It connects by itself when the network is back.',
  signin: 'Remote Control is not up yet: the user needs to sign in again. It connects by itself once they do (within a day).',
};
const OFF = 'Remote Control is off, and this session will not be linked again on its own.';

/**
 * @param {any} registry
 * @param {object} o
 * @param {(ctx: any) => string | null} o.owner the chat a call came from
 * @param {(chatId: string) => { kind: string, key: string }} o.refOf the harness and native session of a chat
 * @param {{ control: (key: string, method: string, arg: any) => Promise<any> }} o.claude Claude Code's session API
 * @returns {() => void} removes the tool
 */
function registerRemoteControlTool(registry, { owner, refOf, claude }) {
  return registry.register({
    name: 'set_remote_control',
    description:
      'Turn Remote Control on or off for this session: the composer\'s Remote Control switch, which links a Claude Code session to the user\'s claude.ai account so they can follow and steer it from claude.ai/code or the Claude app. Only when the user asks. Returns the state afterwards ("on", "off"); never the page address, which the user has. An "on" for a link already up changes nothing; an "off" also stops the link from coming back on its own. Needs a Claude Code session that is running and a claude.ai subscription login that the organization allows; on any other harness it says so and changes nothing.',
    schema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Only "self" (the default): this session. Another session is changed from its own chat.',
        },
        enabled: { type: 'boolean', description: 'true turns Remote Control on, false turns it off.' },
      },
      required: ['enabled'],
      additionalProperties: false,
    },
    policy: 'act',
    handler: async (args, ctx) => {
      const caller = owner(ctx);
      if (!caller) throw new ToolError('The caller does not own this chat segment', 'no_owner');
      const named = String(args.session_id ?? '')
        .trim()
        .toLowerCase();
      if (named && named !== 'self') throw new ToolError(NOT_SELF, 'not_self');
      const ref = refOf(caller);
      if (ref.kind !== 'claude') throw new ToolError(UNSUPPORTED[ref.kind] ?? UNSUPPORTED.acp, 'unsupported_harness');
      const on = args.enabled === true;
      let view;
      try {
        view = await claude.control(ref.key, 'remoteControl', { on });
      } catch (error) {
        throw new ToolError(
          `Remote Control could not be turned ${on ? 'on' : 'off'}: ${error?.message || error}. It may still be ${on ? 'off' : 'on'}. Tell the user.`,
          'failed',
        );
      }
      if (!view) throw new ToolError(NOT_RUNNING, 'not_running');
      if (view.state === 'unavailable') throw new ToolError(`${view.error} Nothing changed. Tell the user.`, 'unavailable');
      // a link that is wanted but waits for the network or a sign-in is recorded: it comes up by itself
      if (on && (view.state === 'offline' || view.state === 'signin'))
        return { remote_control: view.state, said: `${PENDING[view.state]} Tell the user; nothing more to do.` };
      if (on && view.state !== 'on')
        throw new ToolError(`Remote Control did not connect: ${view.error ?? 'no answer'}. It is off. Tell the user.`, 'failed');
      return { remote_control: on ? 'on' : 'off', said: on ? ON : OFF };
    },
  });
}

module.exports = { registerRemoteControlTool, UNSUPPORTED, NOT_RUNNING, NOT_SELF, ON, OFF };
