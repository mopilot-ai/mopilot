// Relays a machine's browser and desktop tools and brokers explicitly approved calls to this Mac.
const { createToolRelay, hostToolsFor } = require('../host/toolRelay.cjs');
const { desktopAnnounce } = require('../host/desktopAnnounce.cjs');
const { ToolError } = require('../capabilities/contract/registry.cjs');
const { onThisMac } = require('../capabilities/contract/thisMacControl.cjs');
const { guarded } = require('../capabilities/contract/actionGuard.cjs');
const { normalizeUrl } = require('../capabilities/browser/hostUtil.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { identityKey } = require('../../shared/identityKey.mjs');
const { userError } = require('../../shared/userError.mjs');

const SPEC = {
  name: 'this_mac_control',
  policy: 'act',
  description:
    'Use Chrome or desktop apps on the Mac running MoPilot, when the user wants work on that Mac. Call with action "list" for available tool names and input schemas. Call with action "call", a tool name and its arguments. Each tool call, including a read, needs approval on the Mac before running. The built-in browser tools still use the browser on your Host.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'call'] },
      tool: { type: 'string', description: 'The name of a tool from action "list".' },
      arguments: { type: 'object', description: 'Arguments for the selected tool.' },
    },
    required: ['action'],
  },
};

// The remote route uses app-scoped desktop tools. It has no global desktop, clipboard, shell or script access.
const AVAILABLE = new Set([
  'chrome_tabs_context_mcp',
  'chrome_tabs_create_mcp',
  'chrome_tabs_close_mcp',
  'chrome_navigate',
  'chrome_read_page',
  'chrome_find',
  'chrome_get_page_text',
  'chrome_computer',
  'chrome_form_input',
  'desktop_request_access',
  'desktop_list_granted_applications',
  'desktop_open_application',
  'desktop_app_list_windows',
  'desktop_app_ax_find',
  'desktop_app_screenshot',
  'desktop_app_focus',
  'desktop_app_click',
  'desktop_app_scroll',
  'desktop_app_key',
  'desktop_app_type',
  'desktop_app_release',
]);

const cardText = (/** @type {string} */ value) => value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 160);

/** A browser navigation move or the origin of its normalized URL. @param {unknown} url */
function navigationTarget(url) {
  if (typeof url !== 'string') return null;
  if (['back', 'forward', 'reload', 'stop', 'about:blank'].includes(url)) return url;
  try {
    return new URL(normalizeUrl(url)).origin;
  } catch {
    return null;
  }
}

/** @param {string} tool @param {Record<string, unknown>} args */
function detailsOf(tool, args) {
  // Keep credentials, queries, fragments and typed form values off the card.
  const target = navigationTarget(args.url);
  const fields = ['app', 'action', 'tabId', 'ref', 'window_id', 'element_index', 'repeat', 'scroll_direction', 'scroll_amount'];
  if (tool.endsWith('_key') || args.action === 'key') fields.push('combo', 'text');
  const details = [tool];
  if (target) details.push(`url: ${cardText(target)}`);
  for (const field of fields) {
    const value = args[field];
    if ((typeof value === 'string' && value) || Number.isSafeInteger(value)) details.push(`${field}: ${cardText(String(value))}`);
  }
  for (const field of ['coordinate', 'start_coordinate']) {
    const point = args[field];
    if (Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)) details.push(`${field}: ${point.join(', ')}`);
  }
  if (Array.isArray(args.apps)) {
    const apps = args.apps.filter((app) => typeof app === 'string');
    if (apps.length)
      details.push(`apps: ${apps.slice(0, 8).map(cardText).join(', ')}${apps.length > 8 ? ` (+${apps.length - 8} more)` : ''}`);
  }
  return details;
}

/**
 * @param {{ live: any, hostId: string, machine: () => string, owns: (chatId: string, epoch: number) => boolean,
 *           usingApps: (chatId: string, current: () => boolean) => void }} o
 */
function localControl({ live, hostId, machine, owns, usingApps }) {
  const registry = live.capabilities;
  const listed = () => registry.list().filter((/** @type {{ name: string }} */ tool) => AVAILABLE.has(tool.name));
  return async (
    /** @type {string} */ chatId,
    /** @type {string} */ segmentId,
    /** @type {any} */ input,
    /** @type {{ callId: string, epoch: number, signal: AbortSignal }} */ ctx,
  ) => {
    const { callId, epoch, signal } = ctx;
    try {
      if (registry.isApart(chatId)) throw new ToolError('This chat cannot use services on this Mac.', 'unavailable');
      if (input.action === 'list') return { ok: true, content: [{ type: 'text', text: JSON.stringify({ tools: listed() }) }] };
      if (
        input.action !== 'call' ||
        typeof input.tool !== 'string' ||
        !listed().some((/** @type {{ name: string }} */ t) => t.name === input.tool)
      )
        throw new ToolError('Choose an available tool from this_mac_control with action "list".', 'unavailable');
      const args = input.arguments ?? {};
      if (typeof args !== 'object' || Array.isArray(args)) throw new ToolError('Tool arguments must be an object.', 'bad_args');
      // The turn-start frame may precede this call in the same read and still be queued in the chat mirror.
      const settle = () => live.remoteChats?.()?.settled(chatId);
      await settle();
      const turnOf = () => live.sessions?.get(chatId)?.activeTurn?.id;
      const turn = turnOf();
      const ownerCurrent = () => turn != null && turnOf() === turn && owns(chatId, epoch);
      const current = () => !signal.aborted && ownerCurrent();
      const retired = () => new ToolError('This chat’s turn or machine connection changed. The request on this Mac ended.', 'stale_turn');
      if (!current()) throw retired();
      const tool = input.tool;
      const chrome = tool.startsWith('chrome_');
      if (tool === 'desktop_request_access' && (args.screenControl || args.clipboardRead || args.clipboardWrite || args.systemKeyCombos))
        throw new ToolError('Remote Run can request access to named apps with this tool.', 'bad_args');
      const answer = await live.computerUse?.broker.ask(
        chatId,
        'hostAsk',
        {
          title: chrome ? 'Use Chrome on this Mac' : 'Use apps on this Mac',
          message: `This chat on ${machine()} wants to run a tool on this Mac. Its result will go to the agent on that machine.`,
          details: detailsOf(tool, args),
          choices: [{ id: 'once', label: 'Allow once' }],
          destructive: true, // a click is required for this approval
          macOnly: true,
        },
        { signal },
      );
      await settle();
      if (!current()) throw retired();
      if (answer == null) throw new ToolError('The request ended without approval on this Mac.', 'approval_unavailable');
      if (answer.decision !== 'allow' || answer.choice !== 'once')
        throw new ToolError('The user did not approve this action on this Mac.', 'denied');
      if (!chrome) usingApps(chatId, ownerCurrent);
      const result = await guarded({ signal, epoch: () => Number(current()) }, () =>
        onThisMac(chatId, tool, () =>
          registry.invoke(chatId, segmentId, tool, args, {
            signal,
            callId: identityKey('this-mac', hostId, String(epoch), String(turn), callId),
          }),
        ),
      );
      await settle();
      return { ...result, canDeliver: current };
    } catch (error) {
      if (!(error instanceof ToolError)) noteIgnored('run a Host chat’s approved call on this Mac', error);
      return {
        ok: false,
        content: [],
        error:
          error instanceof ToolError
            ? { code: error.code, message: userError(error) }
            : { code: 'failed', message: 'MoPilot could not run this action on this Mac.' },
      };
    }
  };
}

/** @param {{ live: any, hostId: string, host: Parameters<typeof createToolRelay>[0]['host'], machines: any }} o */
function bindHostCapabilityRelay({ live, hostId, host, machines }) {
  const registry = live?.capabilities;
  if (!registry) return () => undefined;
  const row = () => machines.row(hostId);
  const desktop = desktopAnnounce({ has: () => row()?.capabilities?.desktop === true, resync: () => relay.resync() });
  const owns = (/** @type {string} */ chatId, /** @type {number} */ epoch) => {
    const owner = live.hostOwnership?.get(chatId);
    return owner?.hostId === hostId && owner.epoch === epoch;
  };
  /** @type {Map<string, () => boolean>} */
  const appUsers = new Map();
  const releaseApp = (/** @type {string} */ chatId) => {
    const current = appUsers.get(chatId);
    appUsers.delete(chatId);
    if (current?.()) live.computerUse?.apps?.turnEnded(chatId);
  };
  const releaseApps = () => {
    for (const chatId of appUsers.keys()) releaseApp(chatId);
  };
  const invokeLocal = localControl({
    live,
    hostId,
    machine: () => row()?.name ?? 'the remote machine',
    owns,
    usingApps: (chatId, current) => appUsers.set(chatId, current),
  });
  const hostTool = hostToolsFor(desktop.announced);
  const relay = createToolRelay({
    host,
    registry: {
      list: () => (live.computerUse?.broker ? [...registry.list(), SPEC] : registry.list()),
      invoke: (chat, segment, name, args, ctx) =>
        name === SPEC.name ? invokeLocal(chat, segment, args, ctx) : registry.invoke(chat, segment, name, args, ctx),
      abortChat: (chat, why) => registry.abortChat?.(chat, why),
    },
    include: (tool) => tool.name === SPEC.name || hostTool(tool),
    owns,
    cancelsChat: (name) => name !== SPEC.name,
    report: noteIgnored,
  });
  const unwatch = machines.onRowChange(desktop.onRow);
  const offState = host.onState((state) => {
    if (state !== 'online') releaseApps();
  });
  const offTurn = registry.turns?.onRetire(
    (/** @type {string} */ chatId, /** @type {number} */ _turn, /** @type {string | null} */ thread) => {
      if (thread === null) releaseApp(chatId);
    },
  );
  return () => {
    unwatch?.();
    desktop.dispose();
    relay.dispose();
    offState();
    offTurn?.();
    releaseApps();
  };
}

module.exports = { bindHostCapabilityRelay };
