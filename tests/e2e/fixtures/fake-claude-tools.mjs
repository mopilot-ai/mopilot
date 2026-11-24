// Permission decisions and SDK MCP tool calls for the scripted Claude fixture, and the wrap-up a linked sessions' wake-up
// quoting ORCHWRAP-<name> reports makes (cuj-orchestrator-chat).
import { randomUUID } from 'node:crypto';

export function createFakeClaudeTools({ version: VERSION, sessionId, allowedTools, askSdk, send, log, record, resolvedModel, state }) {
  // The SDK correlates replies by server and inner ID, even after a caller interrupts its await.
  let nextMcpId = 1;
  /** Whether a tool may run: the permission mode and --allowedTools first, then canUseTool. */
  async function permit(toolName, input, mcpServer) {
    if (state.permissionMode === 'bypassPermissions' || allowedTools.includes(toolName) || toolName === 'Skill') return 'allow';
    if (state.permissionMode === 'acceptEdits' && ['Edit', 'Write'].includes(toolName)) return 'allow';
    if (state.permissionMode === 'dontAsk') return 'deny';
    const r = await askSdk({
      subtype: 'can_use_tool',
      tool_name: toolName,
      input,
      tool_use_id: `toolu_fake_${randomUUID().slice(0, 8)}`,
      permission_suggestions: [],
      mcp_server: mcpServer,
    });
    return r?.response?.behavior ?? 'deny';
  }

  async function callSdkMcp(word) {
    const out = [];
    for (const name of state.sdkServers.filter((n) => /^sage_[0-9a-f]{12}$/.test(n))) {
      const mcp = async (method, params) =>
        (await askSdk({ subtype: 'mcp_message', server_name: name, message: { jsonrpc: '2.0', id: nextMcpId++, method, params } }))
          ?.response?.mcp_response;
      await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: VERSION } });
      const listed = await mcp('tools/list', {});
      const tool = listed?.result?.tools?.find((t) => t.name === 'sage_debug_echo');
      const alwaysLoad = tool?._meta?.['anthropic/alwaysLoad'] === true;
      const toolName = `mcp__${name}__sage_debug_echo`;
      const permission = tool ? await permit(toolName, { text: word }, { name, source: 'sdk' }) : 'missing';
      let text = permission;
      if (permission === 'allow') {
        const res = await mcp('tools/call', {
          name: 'sage_debug_echo',
          arguments: { text: word },
          _meta: { 'claudecode/toolUseId': `toolu_fake_${randomUUID().slice(0, 8)}` },
        });
        text = res?.result?.content?.map((c) => c.text).join(' ') ?? res?.error?.message;
      }
      log({ kind: 'mcp', server: name, tools: listed?.result?.tools?.map((t) => t.name) ?? [], alwaysLoad, permission, text });
      out.push(` [mcp: ${text}]`);
    }
    return out.join('');
  }

  /**
   * Calls a tool of the sage_<nonce> servers, or of the one server a full mcp__<server>__<tool> name gives; the reply text,
   * images as <image>. `step`: the call is a tool_use and tool_result of the turn (CUSTEPS); `cut` resolves when the turn
   * is interrupted, which abandons the call in flight.
   * @param {string | null} [parent]
   */
  async function callSdkTool(tool, args, parent = null, { step = false, cut = /** @type {Promise<unknown> | null} */ (null) } = {}) {
    const out = [];
    // mcp__<server>__<tool>: one named server (a host server such as mopilot_browser); else each sage_<nonce> server
    const full = /^mcp__(.+?)__(.+)$/.exec(tool);
    const toolName = full ? full[2] : tool;
    const servers = full ? state.sdkServers.filter((n) => n === full[1]) : state.sdkServers.filter((n) => /^sage_[0-9a-f]{12}$/.test(n));
    for (const name of servers) {
      const mcp = async (method, params) =>
        (await askSdk({ subtype: 'mcp_message', server_name: name, message: { jsonrpc: '2.0', id: nextMcpId++, method, params } }))
          ?.response?.mcp_response;
      await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: VERSION } });
      const toolId = `toolu_fake_${randomUUID().slice(0, 8)}`;
      // a sub-agent's call: the CLI forwards its tool_use with the parent's id before the call arrives
      const use = {
        type: 'assistant',
        message: {
          id: `msg_fake_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
          type: 'message',
          role: 'assistant',
          model: resolvedModel(),
          content: [{ type: 'tool_use', id: toolId, name: `mcp__${name}__${toolName}`, input: args }],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        parent_tool_use_id: parent,
        session_id: sessionId,
        uuid: randomUUID(),
      };
      if (step && !parent) record('assistant', { message: use.message, uuid: use.uuid });
      if (parent || step) send(use);
      const permission = await permit(`mcp__${name}__${toolName}`, args, { name, source: 'sdk' });
      let text = permission;
      let blocks = [{ type: 'text', text: permission }];
      let isError = permission !== 'allow';
      if (permission === 'allow') {
        const call = mcp('tools/call', { name: toolName, arguments: args, _meta: { 'claudecode/toolUseId': toolId } });
        const res = await (cut ? Promise.race([call, cut.then(() => 'cut')]) : call);
        if (res === 'cut') {
          text = 'interrupted';
          blocks = [{ type: 'text', text: '[Request interrupted by user for tool use]' }];
          isError = true;
        } else {
          text = res?.result?.content?.map((c) => (c.type === 'image' ? '<image>' : c.text)).join(' ') ?? res?.error?.message;
          if (res?.result?.isError) text = `error: ${text}`;
          isError = !!res?.result?.isError || !res?.result;
          // the API's tool_result blocks: text, and images as base64 sources
          blocks = (res?.result?.content ?? [{ type: 'text', text }]).map((c) =>
            c.type === 'image'
              ? { type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } }
              : { type: 'text', text: c.text },
          );
        }
      }
      if (step && !parent) {
        const content = [{ type: 'tool_result', tool_use_id: toolId, content: blocks, ...(isError ? { is_error: true } : {}) }];
        const uuid = randomUUID();
        record('user', { message: { role: 'user', content }, uuid });
        send({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: sessionId, uuid });
      }
      log({ kind: 'cu', server: name, tool: toolName, permission, text });
      out.push(` [cu: ${text}]`);
    }
    return out.join('');
  }

  /**
   * A linked sessions' wake-up quoting ORCHWRAP-<name> reports: the parent carries on and wraps up, naming each one, and
   * asks what next (a recap alone draws no box).
   */
  async function wrapUpWake(text) {
    const reported = text.includes('<mopilot-side-sessions-event>') ? [...new Set(text.match(/ORCHWRAP-\w+/g) ?? [])] : [];
    const recap = `Wrapped up after ${reported.join(' and ')} reported back.`;
    return reported.length
      ? callSdkTool('wrap_up', { recap, ask: 'Open a PR?', actions: [{ label: 'Open PR' }, { label: 'Not now' }] })
      : '';
  }

  return { permit, callSdkMcp, callSdkTool, wrapUpWake };
}
