// Tool tiers for a session whose harness has no tool search of its own (ACP harnesses, a Codex that lists every MCP tool):
// the core of each surface is always listed; the rest wait in groups behind browser_more_tools, desktop_more_tools,
// app_more_tools (appTiers.cjs) and mcp_more_tools (the gateway's servers, one group each). The task list and wrap-up (app `turn` group) and desktop_request_access (desktop `access`
// group) wait there too (G11): a grant loads the desktop app group (autoLoad), callable at once and listed from the next turn.
// A group loaded during a turn is listed from the session's next turn (the list never changes mid-turn), and any of its
// tools runs at once through the more tool's `call`. A deferred tool called directly before it is loaded is refused
// with how to load it. Claude Code defers through ToolSearch instead (toolLoading.cjs), and so does a Codex that defers
// MCP tools itself (codex-cli 0.166's tool_search_always_defer_mcp_tools). @host-portable: no Electron.

const { APP_CORE, APP_SURFACE } = require('./appTiers.cjs');
const { gatewayGroupOf } = require('../../gateway/tools.cjs');

/** The surfaces that have a more tool: its name, what it lists, and the groups it loads (Registry names). */
const SURFACES = Object.freeze({
  browser: {
    more: 'browser_more_tools',
    about: "More browser tools (the built-in browser and the user's Chrome), in groups",
    skill: 'mopilot:built-in-browser',
    groups: {
      tabs: {
        summary: 'list, open, close, switch and keep built-in browser tabs',
        tools: ['browser_tabs_context', 'browser_tabs_create', 'browser_tabs_close', 'browser_tabs_select', 'browser_tabs_mark'],
      },
      signin: {
        summary: 'hand a tab to the user (sign-in, CAPTCHA) and fill saved passwords',
        tools: ['browser_request_signin', 'browser_request_credentials'],
      },
      page: {
        summary: 'form fields, page text, JavaScript, dialogs, uploads, window size and batches',
        tools: [
          'browser_form_input',
          'browser_get_page_text',
          'browser_javascript_exec',
          'browser_handle_dialog',
          'browser_file_upload',
          'browser_resize_window',
          'browser_batch',
        ],
      },
      devtools: {
        summary: 'console, network, HAR, perf traces, Web Vitals, accessibility audits, video and React',
        tools: [
          'browser_read_console_messages',
          'browser_read_network_requests',
          'browser_har',
          'browser_perf_trace',
          'browser_vitals',
          'browser_accessibility_audit',
          'browser_record',
          'browser_react',
        ],
      },
      capture: { summary: 'save screenshots and record GIFs', tools: ['browser_save_screenshot', 'browser_gif_creator'] },
      history: { summary: 'search history and bookmarks', tools: ['browser_history_search', 'browser_bookmarks_search'] },
      webmcp: {
        summary: 'page tools (WebMCP)',
        tools: ['browser_page_tools', 'browser_page_tool'],
      },
      preview: {
        summary: 'start, list and stop dev servers and read their logs',
        tools: ['browser_preview_start', 'browser_preview_stop', 'browser_preview_list', 'browser_preview_logs'],
      },
      // the user's Chrome's core: listed from the start only when the user chose Chrome (CHROME_CORE_GROUP), as Claude's
      // alwaysLoad does (toolLoading.cjs): a chat in the built-in browser carries no second browser's schemas
      chrome: {
        summary: "the user's Chrome: tabs, navigation, page reads, clicks and forms",
        tools: ['chrome_tabs_context_mcp', 'chrome_navigate', 'chrome_read_page', 'chrome_find', 'chrome_computer', 'chrome_form_input'],
      },
      chrome_tabs: { summary: "open and close tabs in the user's Chrome", tools: ['chrome_tabs_create_mcp', 'chrome_tabs_close_mcp'] },
      chrome_page: {
        summary: "the page group's tools in the user's Chrome",
        tools: [
          'chrome_get_page_text',
          'chrome_javascript_tool',
          'chrome_handle_dialog',
          'chrome_file_upload',
          'chrome_upload_image',
          'chrome_resize_window',
          'chrome_browser_batch',
        ],
      },
      chrome_devtools: {
        summary: "the devtools group's tools in the user's Chrome",
        tools: [
          'chrome_read_console_messages',
          'chrome_read_network_requests',
          'chrome_har',
          'chrome_perf_trace',
          'chrome_vitals',
          'chrome_accessibility_audit',
          'chrome_record',
          'chrome_react',
        ],
      },
      chrome_capture: { summary: "record GIFs in the user's Chrome", tools: ['chrome_gif_creator'] },
      chrome_webmcp: {
        summary: "page tools in the user's Chrome",
        tools: ['chrome_page_tools', 'chrome_page_tool'],
      },
    },
  },
  desktop: {
    more: 'desktop_more_tools',
    about: 'More computer-use tools, in groups',
    skill: 'mopilot:computer-use',
    groups: {
      access: {
        summary: 'ask the user for access to apps: the first step of any computer-use task',
        tools: ['desktop_request_access'],
      },
      app: {
        summary: 'screenshots, clicks, typing and keys in one app (loaded by a request_access grant)',
        tools: [
          'desktop_screenshot',
          'desktop_app_list_windows',
          'desktop_app_screenshot',
          'desktop_app_click',
          'desktop_app_type',
          'desktop_app_key',
        ],
      },
      app_more: {
        summary: 'scroll, menus, element search, zoom, focus, drag and file panels in one app',
        tools: [
          'desktop_app_scroll',
          'desktop_app_menu',
          'desktop_app_ax_find',
          'desktop_app_zoom',
          'desktop_app_focus',
          'desktop_app_drag',
          'desktop_app_file_panel',
        ],
      },
      app_script: {
        summary: "AppleScript or JXA in one scriptable app, and the user's own Shortcuts",
        tools: ['desktop_app_script', 'desktop_shortcut_list', 'desktop_shortcut_run'],
      },
      app_session: {
        summary: 'batches of app actions, bringing a window to this Space, releasing an app',
        tools: ['desktop_app_batch', 'desktop_app_bring_to_current_space', 'desktop_app_release'],
      },
      pointer: {
        summary: 'screen-wide mouse: clicks, moves, drags, scrolling, zoom',
        tools: [
          'desktop_left_click',
          'desktop_right_click',
          'desktop_middle_click',
          'desktop_double_click',
          'desktop_triple_click',
          'desktop_mouse_move',
          'desktop_left_click_drag',
          'desktop_left_mouse_down',
          'desktop_left_mouse_up',
          'desktop_scroll',
          'desktop_cursor_position',
          'desktop_zoom',
        ],
      },
      keyboard: { summary: 'screen-wide typing, keys and held keys', tools: ['desktop_type', 'desktop_key', 'desktop_hold_key'] },
      batch: { summary: 'several screen-wide actions in one call', tools: ['desktop_batch'] },
      apps: {
        summary: 'granted apps, opening apps, displays, waiting, full control',
        tools: [
          'desktop_list_granted_applications',
          'desktop_open_application',
          'desktop_switch_display',
          'desktop_wait',
          'desktop_request_full_control',
          'desktop_release_full_control',
        ],
      },
      clipboard: { summary: 'read and write the clipboard', tools: ['desktop_read_clipboard', 'desktop_write_clipboard'] },
      teach: {
        summary: 'guide the user step by step on screen',
        tools: ['desktop_request_teach_access', 'desktop_teach_step', 'desktop_teach_batch'],
      },
    },
  },
  app: APP_SURFACE,
  // the MCP servers the gateway runs (electron/gateway): one group per server, made from the tools a session sees
  // (gatewayGroupOf reads it from the name), so a session loads one server's tools at a time
  mcp: {
    more: 'mcp_more_tools',
    about: "Tools of the user's MCP servers that MoPilot runs, one group per server",
    skill: null,
    groups: {},
    perServer: true,
  },
});

/** Every tool always listed (the core tier), by surface; a tool in no group is always listed too. */
const CORE = Object.freeze({
  browser: ['browser_navigate', 'browser_read_page', 'browser_find', 'browser_computer', 'browser_script'],
  desktop: [],
  app: APP_CORE,
});

/** The group a session lists from the start while the user's chosen browser is their Chrome (ToolSessions preloaded). */
const CHROME_CORE_GROUP = 'browser/chrome';

/** The groups a tiered session lists from the start (ToolSessions preloaded): the Chrome core while Chrome is chosen. */
const preloadedGroups = (/** @type {boolean} */ chromeChosen) => (chromeChosen ? [CHROME_CORE_GROUP] : []);

/** A successful call to one of these loads its group (callable now, listed from the next turn): a grant starts CU. */
const AUTO_LOAD = Object.freeze({ desktop_request_access: 'desktop/app' });

/** Registry tool name -> { surface, group } for every deferred tool. */
const GROUP_OF = new Map(
  Object.entries(SURFACES).flatMap(([surface, s]) =>
    Object.entries(s.groups).flatMap(([group, g]) => g.tools.map((name) => [name, { surface, group }])),
  ),
);
/** more tool name -> surface */
const MORE = new Map(Object.entries(SURFACES).map(([surface, s]) => [s.more, surface]));
const CORE_NAMES = new Set(Object.values(CORE).flat());
/**
 * Tools the app surface never takes: the browser, Chrome and desktop surfaces name each of theirs in a group
 * (tests/toolTiers.test.ts), the legacy browser and computer channels' stay listed, and so do a MoMo chat's own tools.
 */
const NAMED = /^(browser_|chrome_|desktop_|sage_browser_|computer_|momo_)/;
const REST = Object.freeze({ surface: 'app', group: 'other' });

/**
 * The group a deferred tool is in, or null for a core tool or one NAMED matches in no group. Any other tool no group
 * names is an app tool in the `other` group.
 */
const groupOf = (/** @type {string} */ name) => {
  const server = gatewayGroupOf(name);
  if (server) return { surface: 'mcp', group: server };
  return GROUP_OF.get(name) ?? (CORE_NAMES.has(name) || MORE.has(name) || NAMED.test(name) ? null : REST);
};
/** The surface a more tool loads, or null. */
const moreSurface = (/** @type {string} */ name) => MORE.get(name) ?? null;

/** A tool's first sentence: what a group listing says about it. */
function firstSentence(/** @type {string} */ text) {
  const s = String(text ?? '').split('\n')[0];
  const end = s.search(/\.(\s|$)/);
  return end < 0 ? s : s.slice(0, end + 1);
}

/**
 * The groups of `surface` that have a tool in `visible` (the tools the session may see), with those tools, in the
 * fixed order above: the more tool's text is the same for every session with the same tools (a cached prompt prefix).
 * @param {string} surface @param {Set<string>} visible
 */
function visibleGroups(surface, visible) {
  if (/** @type {any} */ (SURFACES[surface]).perServer) return serverGroups(visible);
  /** @type {Record<string, { summary: string, tools: string[], rest?: boolean }>} */
  const groups = SURFACES[surface].groups;
  const rest = () => [...visible].filter((t) => groupOf(t) === REST).sort();
  return Object.entries(groups)
    .map(([id, g]) => ({ id, summary: g.summary, tools: g.rest ? rest() : g.tools.filter((t) => visible.has(t)) }))
    .filter((g) => g.tools.length);
}

/** The gateway's groups among `visible`: one per server, by group id, each server's tools sorted. */
function serverGroups(/** @type {Set<string>} */ visible) {
  /** @type {Map<string, string[]>} */
  const by = new Map();
  for (const t of [...visible].sort()) {
    const id = gatewayGroupOf(t);
    if (id) by.set(id, [...(by.get(id) ?? []), t]);
  }
  return [...by.keys()]
    .sort()
    .map((id) => ({ id, summary: `the ${id.slice(0, id.lastIndexOf('_'))} server's tools`, tools: /** @type {string[]} */ (by.get(id)) }));
}

/** The more tool of `surface` for a session that sees `visible`, as a Registry-shaped tool, or null when it defers nothing. */
function moreTool(/** @type {string} */ surface, /** @type {Set<string>} */ visible) {
  const s = SURFACES[surface];
  const groups = visibleGroups(surface, visible);
  if (!groups.length) return null;
  const list = groups.map((g) => `${g.id} (${g.summary})`).join('; ');
  return {
    name: s.more,
    description:
      `${s.about}: ${list}. No arguments: each group's tools. load: their schemas, listed from your next turn. ` +
      `call with arguments: run one now.${s.skill ? ` The ${s.skill} skill says how to use them.` : ''}`,
    inputSchema: {
      type: 'object',
      properties: {
        load: { type: 'array', items: { type: 'string', enum: groups.map((g) => g.id) }, description: 'Groups to load.' },
        call: { type: 'string', description: 'A tool of these groups to run now.' },
        arguments: { type: 'object', description: 'The input for call.' },
      },
    },
    policy: 'observe',
  };
}

/**
 * The tools/list of a tiered session: `tools` (the Registry tools it may see) less the deferred ones not yet loaded,
 * then each surface's more tool.
 * @template {{ name: string }} T
 * @param {T[]} tools @param {Set<string>} loaded the groups listed this turn ("surface/group")
 * @returns {(T | NonNullable<ReturnType<typeof moreTool>>)[]}
 */
function tieredList(tools, loaded) {
  const visible = new Set(tools.map((t) => t.name));
  /** @type {(T | NonNullable<ReturnType<typeof moreTool>>)[]} */
  const out = tools.filter((t) => {
    const g = groupOf(t.name);
    return !g || loaded.has(`${g.surface}/${g.group}`);
  });
  for (const surface of Object.keys(SURFACES)) {
    const more = moreTool(surface, visible);
    if (more) out.push(more);
  }
  return out;
}

/** What a direct call to a deferred tool that is not loaded is told, as MCP CallToolResult content. */
function notLoaded(/** @type {string} */ name) {
  const g = /** @type {{ surface: string, group: string }} */ (groupOf(name));
  const more = SURFACES[g.surface].more;
  return {
    content: [
      {
        type: 'text',
        text: `${name} is not loaded in this session. Run it now with ${more} {"call": "${name}", "arguments": {...}}, or load its group with ${more} {"load": ["${g.group}"]}: it is listed from your next turn.`,
      },
    ],
    structuredContent: { error: 'tool_not_loaded', tool: name, group: g.group, loadWith: { tool: more, arguments: { load: [g.group] } } },
    isError: true,
  };
}

/**
 * A call to a more tool, decided without running anything: what to answer, groups to load, or a tool to run now.
 * `visible`: the Registry tools the session may see, by name; `describe(name)`: that tool's { description, inputSchema }.
 * @param {string} more @param {any} args @param {Set<string>} visible
 * @param {(name: string) => { description: string, inputSchema: any }} describe
 * @returns {{ answer: string, error?: true, load?: string[] } | { run: string, args: any }}
 */
function moreCall(more, args, visible, describe) {
  const surface = /** @type {string} */ (moreSurface(more));
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const groups = visibleGroups(surface, visible);
  const ids = groups.map((g) => g.id);
  if (!ids.length) return { answer: `${more} has no tools in this session.`, error: true };
  if (a.call !== undefined) {
    const name = typeof a.call === 'string' ? a.call : '';
    if (groupOf(name)?.surface !== surface || !visible.has(name))
      return {
        answer: `${name || 'call'} is not a tool ${more} runs here. Its tools are: ${groups.flatMap((g) => g.tools).join(', ')}.`,
        error: true,
      };
    const input = a.arguments ?? {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { answer: 'arguments must be an object.', error: true };
    return { run: name, args: input };
  }
  if (a.load !== undefined) {
    const want = Array.isArray(a.load) ? a.load : [a.load];
    const bad = want.filter((id) => !ids.includes(id));
    if (bad.length || !want.length)
      return { answer: `Unknown group: ${bad.join(', ') || '(none)'}. The groups are: ${ids.join(', ')}.`, error: true };
    const tools = groups.filter((g) => want.includes(g.id)).flatMap((g) => g.tools.map((name) => ({ name, ...describe(name) })));
    return {
      answer: `Loaded ${want.join(', ')}: listed from your next turn. Run one now with ${more} {"call": name, "arguments": {...}}.\n${JSON.stringify(tools)}`,
      load: want.map((id) => `${surface}/${id}`),
    };
  }
  return {
    answer: groups
      .map((g) => `${g.id}: ${g.summary}\n${g.tools.map((t) => `- ${t}: ${firstSentence(describe(t).description)}`).join('\n')}`)
      .join('\n\n'),
  };
}

/**
 * What a tiered session's successful call to `name` loads, and what its result adds: a request_access grant loads the
 * app tools, which this turn runs through the more tool and the next lists. null for any other call.
 * Also null when the group is callable already (`callable`: loaded or loaded this turn).
 * @param {string} name @param {Set<string>} visible the Registry tools the session may see
 * @param {Set<string> | null | undefined} callable
 * @returns {{ load: string[], note: string } | null}
 */
function autoLoad(name, visible, callable) {
  const id = AUTO_LOAD[/** @type {keyof typeof AUTO_LOAD} */ (name)];
  if (!id || callable?.has(id)) return null;
  const [surface, group] = id.split('/');
  const tools = visibleGroups(surface, visible).find((g) => g.id === group)?.tools ?? [];
  if (!tools.length) return null;
  const more = SURFACES[surface].more;
  return {
    load: [id],
    note: `Loaded the ${group} group (${tools.join(', ')}): listed from your next turn. Now run one with ${more} {"call": "${tools[0]}", "arguments": {...}}.`,
  };
}

module.exports = {
  SURFACES,
  CORE,
  CHROME_CORE_GROUP,
  preloadedGroups,
  groupOf,
  moreSurface,
  moreTool,
  tieredList,
  notLoaded,
  moreCall,
  visibleGroups,
  autoLoad,
};
