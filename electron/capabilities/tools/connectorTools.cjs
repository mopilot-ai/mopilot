// session_connectors_status, set_session_connector_enabled, reconnect_session_connector and list_connectors, as Claude
// Desktop's ccd_connectors and mcp-registry ones, over the MCP servers ("connectors") of the calling chat's own harness.
// Each harness answers through a provider (electron/app/ipc/connectors.cjs): Claude Code through its session's SDK calls,
// Codex through the app-server's mcpServerStatus/list and config, and a basic (ACP) harness through the user's own
// server list MoPilot can turn on and off for it. What a harness can't do is said, never faked: a provider without
// `reconnect` is told as "not supported on this harness". Switching a connector on or off asks the user first.
const { ToolError } = require('../contract/registry.cjs');
const { parseKind } = require('../../../shared/harnessKind.mjs');

/** @typedef {{ name: string, status: 'connected' | 'needs_auth' | 'failed' | 'pending' | 'disabled' | 'unknown', tool_count?: number, enabled: boolean }} Connector */
/**
 * What a harness family can do with its MCP servers; each call is for the chat that asked.
 * @typedef {object} ConnectorProvider
 * @property {(chatId: string, kind: string) => Promise<{ connectors: Connector[], scope: string }>} status
 * @property {(chatId: string, kind: string, name: string, enabled: boolean) => Promise<{ said?: string }>} setEnabled
 * @property {(chatId: string, kind: string, name: string) => Promise<{ said?: string }>} [reconnect] absent: the harness can't
 */

const NEEDS_AUTH = 'A connector that needs sign-in can only be signed in by the user, on the Plugins page.';

/**
 * @param {any} registry
 * @param {object} o
 * @param {(ctx: any) => string | null} o.owner the chat that called
 * @param {(chatId: string) => string | null} o.kindOf the chat's current harness kind ('codex', 'claude', 'acp:<id>')
 * @param {Record<'codex' | 'claude' | 'acp', ConnectorProvider>} o.providers
 * @param {(chatId: string, summary: string, signal: AbortSignal | null) => Promise<boolean>} o.ask the user's answer to a consent card
 * @returns {() => void} removes the tools
 */
function registerConnectorTools(registry, { owner, kindOf, providers, ask }) {
  const add = (name, description, properties, required, policy, handler) =>
    registry.register({
      name,
      description,
      schema: { type: 'object', properties, required, additionalProperties: false },
      policy,
      authorizesItself: true,
      handler: async (args, ctx) => {
        const caller = owner(ctx);
        if (!caller) throw new ToolError('The caller does not own this chat segment', 'no_owner');
        const kind = kindOf(caller);
        const parsed = parseKind(kind);
        if (!kind || !parsed) throw new ToolError("This chat's harness isn't known, so its connectors can't be reached.", 'unavailable');
        return handler(args, caller, ctx, { kind, provider: providers[parsed.family] });
      },
    });
  /** The connectors of the chat's harness, or why they can't be read. */
  const read = async (caller, { kind, provider }) => {
    try {
      return await provider.status(caller, kind);
    } catch (e) {
      throw e instanceof ToolError
        ? e
        : new ToolError(`Couldn't read the connectors: ${e instanceof Error ? e.message : String(e)}`, 'unavailable');
    }
  };
  /** The one connector `name` names (exact, else ignoring case), or why not. */
  const find = (connectors, name) => {
    const wanted = String(name).trim();
    const found = connectors.find((c) => c.name === wanted) ?? connectors.find((c) => c.name.toLowerCase() === wanted.toLowerCase());
    if (!found)
      throw new ToolError(
        `No connector named “${wanted}”. This session has: ${connectors.map((c) => c.name).join(', ') || 'none'}.`,
        'not_found',
      );
    return found;
  };
  const disposers = [
    add(
      'session_connectors_status',
      `List the MCP servers ("connectors") available to this session and their state: status connected | needs_auth | failed | pending | disabled (unknown: the harness does not report live state), tool_count when connected, and enabled. Use it to answer which connectors the session has, to check one after enabling or reconnecting it, or when a tool you expected is missing. ${NEEDS_AUTH}`,
      {},
      [],
      'observe',
      async (_args, caller, _ctx, h) => {
        const { connectors, scope } = await read(caller, h);
        return { harness: h.kind, scope, connectors, ...(connectors.some((c) => c.status === 'needs_auth') ? { note: NEEDS_AUTH } : {}) };
      },
    ),
    add(
      'set_session_connector_enabled',
      'Turn one of this session’s connectors on or off. Pass its name from session_connectors_status. The user is asked to approve each change; the result says whether it applies to this session now or to the harness’s next start, and whether it is shared with other chats.',
      { name: { type: 'string' }, enabled: { type: 'boolean' } },
      ['name', 'enabled'],
      'act',
      async (args, caller, ctx, h) => {
        const { connectors, scope } = await read(caller, h);
        const found = find(connectors, args.name);
        if (found.enabled === args.enabled)
          return { name: found.name, enabled: found.enabled, changed: false, said: 'It is already that way.' };
        if (!(await ask(caller, `${args.enabled ? 'turn on' : 'turn off'} the connector “${found.name}”`, ctx.signal)))
          throw new ToolError('The user did not allow this change. Do not retry it.', 'denied');
        const done = await h.provider.setEnabled(caller, h.kind, found.name, args.enabled);
        return {
          name: found.name,
          enabled: args.enabled,
          changed: true,
          scope,
          said: done.said ?? 'Done. Check session_connectors_status.',
        };
      },
    ),
    add(
      'reconnect_session_connector',
      'Reconnect one of this session’s connectors that failed or dropped. Pass its name from session_connectors_status, then check it with session_connectors_status. A harness that cannot reconnect one says so.',
      { name: { type: 'string' } },
      ['name'],
      'act',
      async (args, caller, _ctx, h) => {
        const { connectors } = await read(caller, h);
        const found = find(connectors, args.name);
        if (!h.provider.reconnect)
          return {
            name: found.name,
            reconnected: false,
            said: 'This harness cannot reconnect a connector from here. Tell the user to restart the chat.',
          };
        if (found.status === 'needs_auth') return { name: found.name, reconnected: false, said: NEEDS_AUTH };
        const done = await h.provider.reconnect(caller, h.kind, found.name);
        return { name: found.name, reconnected: true, said: done.said ?? 'Reconnecting. Check session_connectors_status.' };
      },
    ),
    add(
      'list_connectors',
      'List the connectors (MCP servers) the user has installed for this harness, optionally filtered by keywords in the name. To find ones the user has not installed, use search_mcp_registry.',
      { keywords: { type: 'array', items: { type: 'string' }, description: 'Only connectors whose name has one of these' } },
      [],
      'observe',
      async (args, caller, _ctx, h) => {
        const { connectors } = await read(caller, h);
        const words = (args.keywords ?? []).map((w) => String(w).toLowerCase()).filter(Boolean);
        const shown = words.length ? connectors.filter((c) => words.some((w) => c.name.toLowerCase().includes(w))) : connectors;
        return {
          connectors: shown.map((c) => ({ name: c.name, status: c.status, enabled: c.enabled })),
          ...(shown.length ? {} : { note: 'No installed connectors match. Offer to search the registry (search_mcp_registry).' }),
        };
      },
    ),
  ];
  return () => disposers.forEach((dispose) => dispose());
}

module.exports = { registerConnectorTools, NEEDS_AUTH };
