// Claude's tool channel: in-process SDK MCP servers, new ones for every startSession. The SDK gives
// a tool handler no session id, so each server's handlers close over the chat and segment they serve.
// Each surface's core tools are always loaded; the others sit behind ToolSearch (toolLoading.cjs), and the session's
// canUseTool lets them all through.
//
// The Registry's in-app browser (browser_*) and desktop (desktop_*) tools are presented the way Claude
// knows them from Anthropic's desktop app: each set on a server of its own with short tool names
// (hostServers.cjs). Every other tool is on the session's sage_<nonce> server under its Registry name.
const { callToolResult } = require('./socket.cjs');
const { isSageTool, chatOfOwner } = require('../contract/session.cjs');
const {
  HOST_SERVER_NAMES,
  placement,
  nameRewriter,
  rewriteSchema,
  rewriteResult,
  VERBATIM_RESULTS,
  FOREIGN_RESULTS,
} = require('../contract/hostServers.cjs');
const { hiddenRefusalText } = require('../contract/toolRefusal.cjs');
const { isCoreTool } = require('./toolLoading.cjs');

/** The registry's tools this session's chat may see (Registry.servesChat), less those `hide` names. */
const visible = (registry, hide, chatId) => registry.list({ chatId }).filter((t) => !(hide && hide(t.name)));

/** The visible tools grouped by the server that presents them, the sage server first; and the text rewriter. */
function plan(registry, serverName, hide, /** @type {string | null} */ chatId = null) {
  /** @type {Map<string, { tool: ReturnType<typeof visible>[number], name: string }[]>} */
  const groups = new Map([[serverName, []]]);
  const placed = new Map();
  for (const t of visible(registry, hide, chatId)) {
    const p = placement(t.name, serverName);
    placed.set(t.name, p);
    let list = groups.get(p.server);
    if (!list) groups.set(p.server, (list = []));
    list.push({ tool: t, name: p.name });
  }
  for (const [server, list] of groups) if (!list.length) groups.delete(server);
  return { groups, rewrite: nameRewriter(placed) };
}

/** One SDK server presenting `entries`; each call goes to the Registry under the tool's Registry name. */
function buildServer({
  sdk,
  z,
  registry,
  server,
  entries,
  owner,
  hide,
  rewrite,
  instructions = /** @type {string | null} */ (null),
  chromeCore = false,
}) {
  const text = rewrite(server);
  const tools = entries.map(({ tool: t, name }) =>
    sdk.tool(
      name,
      text(t.description),
      z.fromJSONSchema(rewriteSchema(t.inputSchema, text)),
      async (args, extra) => {
        // the session's own rule says why (visibility.cjs), under the names this server presents
        if (hide && hide(t.name)) return { content: [{ type: 'text', text: text(hiddenRefusalText(hide, t.name)) }], isError: true };
        const callId = (extra && extra._meta && extra._meta['claudecode/toolUseId']) || null;
        // the SDK aborts `extra.signal` when the CLI cancels the call (an interrupt): the Registry run stops with it
        const signal = (extra && extra.signal) || null;
        // the Registry's content goes back with its text under the names this server presents (a refusal that says
        // "call desktop_request_access" names request_access), except a successful result that is the user's or a
        // page's own text; image items stay MCP image content, which the CLI gives the model as image blocks
        const result = callToolResult(await registry.invoke(chatOfOwner(owner.chatId), owner.segmentId, t.name, args, { callId, signal }));
        if (FOREIGN_RESULTS.has(t.name)) return result;
        return result.isError || !VERBATIM_RESULTS.has(t.name) ? rewriteResult(result, text) : result;
      },
      {
        alwaysLoad: !!registry.tools?.get(t.name)?.upFront?.() || isCoreTool(server, name, HOST_SERVER_NAMES.includes(server), chromeCore),
        annotations: { readOnlyHint: t.policy === 'observe' },
      },
    ),
  );
  return sdk.createSdkMcpServer({ name: server, version: '1.0.0', tools, ...(instructions ? { instructions } : {}) });
}

/**
 * The SDK MCP servers for one session by name (the sage server, then the host servers that have tools);
 * empty when there are no tools to give.
 * `hide(name)`: Registry tools the session must not have (asked when the servers are built, and again at
 * each call, since a tool's backing channel can change while the session runs).
 * @param {{ sdk: { createSdkMcpServer: Function, tool: Function }, z: { fromJSONSchema: Function },
 *           registry: InstanceType<typeof import('../contract/registry.cjs').Registry>, serverName: string,
 *           owner: { chatId: string | (() => string), segmentId: string }, hide?: ((name: string) => boolean) | null,
 *           instructions?: string | null, chromeCore?: boolean }} o
 *   instructions: what the session's model is told about these tools (capabilities/contract/surfaceNote.cjs), as the first
 *   server's MCP instructions, which the CLI surfaces to the model beside the preset prompt (left as it is);
 *   chromeCore: the user's chosen browser is their Chrome, so the mopilot_chrome core loads up front (toolLoading.cjs)
 * @returns {Map<string, any>}
 */
function sdkMcpServers({ sdk, z, registry, serverName, owner, hide = null, instructions = null, chromeCore = false }) {
  const { groups, rewrite } = plan(registry, serverName, hide, chatOfOwner(owner.chatId));
  const out = new Map();
  for (const [server, entries] of groups)
    out.set(
      server,
      buildServer({ sdk, z, registry, server, entries, owner, hide, rewrite, instructions: out.size ? null : instructions, chromeCore }),
    );
  return out;
}

/**
 * The session's sage_<nonce> server alone (the Registry's tools other than the host sets), or null when it has none.
 * @param {Parameters<typeof sdkMcpServers>[0]} o
 */
function sdkMcpServer(o) {
  return sdkMcpServers(o).get(o.serverName) ?? null;
}

/** Every tool the session's servers present: its full name (mcp__<server>__<tool>) and its Registry entry. */
function presentedTools(
  registry,
  serverName,
  /** @type {((name: string) => boolean) | null} */ hide = null,
  /** @type {string | null} */ chatId = null,
) {
  const { groups } = plan(registry, serverName, hide, chatId);
  const out = [];
  for (const [server, entries] of groups) for (const e of entries) out.push({ full: `mcp__${server}__${e.name}`, tool: e.tool });
  return out;
}

/** In read-only mode canUseTool is never asked, so the tools that only read are listed as allowed. */
function readOnlyAllowedTools(
  registry,
  serverName,
  /** @type {((name: string) => boolean) | null} */ hide = null,
  /** @type {string | null} */ chatId = null,
) {
  return presentedTools(registry, serverName, hide, chatId)
    .filter((p) => p.tool.policy === 'observe')
    .map((p) => p.full);
}

/**
 * Adds the session's servers to SDK options (changed in place). Returns the names of the servers added
 * and the full names of the tools they present, for canUseTool (autoAllow); `servers` is empty when
 * nothing was added.
 * @param {any} options the query() options
 * @param {Parameters<typeof sdkMcpServers>[0]} o
 * @returns {{ servers: string[], tools: Set<string> }}
 */
function injectSdkMcpServers(options, o) {
  const servers = sdkMcpServers(o);
  if (!servers.size) return { servers: [], tools: new Set() };
  const { registry, serverName, hide = null } = o;
  const chatId = chatOfOwner(o.owner.chatId);
  options.mcpServers = { ...(options.mcpServers || {}), ...Object.fromEntries(servers) };
  if (Array.isArray(options.allowedTools))
    options.allowedTools = [...options.allowedTools, ...readOnlyAllowedTools(registry, serverName, hide, chatId)];
  return { servers: [...servers.keys()], tools: new Set(presentedTools(registry, serverName, hide, chatId).map((p) => p.full)) };
}

/**
 * Adds the session's servers to SDK options. Returns the sage server's name (or the first server added
 * when it has no tools), or null when nothing was added.
 * @param {any} options the query() options, changed in place
 * @param {Parameters<typeof sdkMcpServers>[0]} o
 */
function injectSdkMcp(options, o) {
  const { servers } = injectSdkMcpServers(options, o);
  if (!servers.length) return null;
  return servers.includes(o.serverName) ? o.serverName : servers[0];
}

/**
 * canUseTool's answer for a tool of this session's own servers, or null to ask the user as usual.
 * `allowed` is the session's sage server name (any of its tools), or the Set of full tool names
 * injectSdkMcpServers returned. The host servers have fixed names, so with the Set only the exact
 * tools this session was given pass, never another tool of a same-named server.
 * @param {string | Set<string>} allowed
 */
function autoAllow(allowed, toolName, input) {
  const ok = allowed instanceof Set ? typeof toolName === 'string' && allowed.has(toolName) : isSageTool(toolName, allowed);
  return ok ? { behavior: 'allow', updatedInput: input } : null;
}

module.exports = { sdkMcpServer, sdkMcpServers, readOnlyAllowedTools, injectSdkMcp, injectSdkMcpServers, autoAllow, HOST_SERVER_NAMES };
