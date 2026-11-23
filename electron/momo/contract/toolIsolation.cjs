// MoMo is kept apart from the coding side (#2139), both ways: its chats see and call only MoMo's own tools (default deny:
// momoTool, through the registry's chat scope, and per session for a Codex thread that starts before its chat names it),
// and no other chat or window surface reads or messages a MoMo chat (`readable`, for the peer runtime and the panel).
const { isMomoMeta, isMomoDataMeta } = require('../../../shared/momoChat.mjs');
const { MAIN_REPAIR_TOOLS } = require('../../../shared/mainRepairTools.mjs');

/**
 * The tools a MoMo chat may use, by family: MoMo's own (memory, sources, routines: momo_*), the in-app browser and the
 * user's Chrome (sage_browser_*, browser_*, chrome_*: their names come from the browser's own schemas), and computer
 * use on this Mac (computer_*, desktop_*).
 */
const MOMO_FAMILIES = Object.freeze([/^momo_/, /^sage_browser_/, /^browser_/, /^chrome_/, /^computer_/, /^desktop_/]);
/** And one by one: the chat's own panes, task list and wrap-up, and the skills of the user's plugins. */
const MOMO_TOOLS = Object.freeze(['show_pane', 'close_pane', 'update_task_list', 'wrap_up', 'plugin_skills', 'plugin_skill_read']);

/**
 * The tools a MoMo chat never gets, each decided: those that read, list or target other chats (chat messaging, the
 * sidebar, linked sessions, the window layout, Remote Control (it links a session to claude.ai), scheduled tasks that run chats in the user's projects), a terminal, design
 * and pull-request tools, another computer's access, and the debug echo. Any tool on neither list is hidden too.
 */
const CHAT_TOOLS = Object.freeze([
  ...MAIN_REPAIR_TOOLS,
  'list_chats',
  'read_chat',
  'send_message_to_chat',
  'reply_to_message',
  'get_message_status',
  'wait_for_message',
  'list_sidebar',
  'start_session',
  'dismiss_task',
  'hand_off_to_session',
  'list_sessions',
  'send_message',
  'stop_session',
  'archive_session',
  'open_session_in',
  'close_split',
  'get_window_layout',
  'set_sidebar_collapsed',
  'set_remote_control',
  'list_scheduled_tasks',
  'create_scheduled_task',
  'update_scheduled_task',
  'run_scheduled_task',
  'list_task_runs',
  'delete_scheduled_task',
]);
const NOT_MOMO = Object.freeze([
  ...CHAT_TOOLS,
  'open_terminal_tab',
  'get_session',
  'search_session_transcripts',
  'list_events',
  'unarchive_session',
  'set_session_title',
  'clear_session',
  'delete_session',
  'detach_session',
  'set_session_model',
  'set_session_harness',
  'set_session_effort',
  'set_session_fast_mode',
  'set_session_output_style',
  'set_session_permission_mode',
  'get_usage',
  'export_transcript',
  'list_start_targets',
  'mark_chapter',
  'request_directory',
  'change_directory',
  'propose_branch',
  'open_in_editor',
  'reveal_path',
  'request_keep_awake',
  'get_storage_usage',
  'clean_up_worktrees',
  'discard_kept_worktree',
  'sync_with_base_branch',
  'run_in_terminal',
  'read_terminal',
  'stop_terminal_tab',
  'get_pr_monitor',
  'set_pr_monitor',
  'get_pr_stack_candidates',
  'stack_pull_request',
  'remote_computers',
  'remote_computer_tools',
  'remote_computer_call',
  'sage_debug_echo',
  // the sidebar, settings and connectors are the user's app state, not MoMo's
  'set_pinned',
  'set_unread',
  'list_sections',
  'create_section',
  'rename_section',
  'delete_section',
  'move_project',
  'get_settings',
  'set_setting',
  'session_connectors_status',
  'set_session_connector_enabled',
  'reconnect_session_connector',
  'list_connectors',
  'search_mcp_registry',
]);
/**
 * Families MoMo never gets: design, simulator/emulator, action memory routines (G4), and the MCP gateway's servers'
 * tools (electron/gateway/offer.cjs, mcp_<server>_<tag>_<tool>: the coding side's; MoMo reaches MCP servers through its own proxy).
 */
const NOT_MOMO_FAMILIES = Object.freeze([/^design_/, /^(?:ios_simulator|android_emulator)_/, /^routine_/, /^mcp_/]);

const own = new Set(MOMO_TOOLS);
/** Whether a MoMo chat may see and call tool `name` (default deny). */
const momoTool = (/** @type {string} */ name) => own.has(name) || MOMO_FAMILIES.some((re) => re.test(name));

/**
 * A MoMo chat that only answers with data and gets no tool at all: a chat of MoMo's background memory pass
 * (memoryPass.cjs) or of its search aliases (historyAliases.cjs), which read what the user said, so nothing in that
 * text can make it act.
 */
const dataOnlyMeta = (/** @type {unknown} */ meta) => isMomoDataMeta(meta);

/**
 * @param {{ setChatScope: (allows: (name: string, chatId: string) => boolean, apart: (chatId: string) => boolean) => void }} registry
 * @param {() => { records: Map<string, { meta?: unknown }> } | null | undefined} chats the ChatsStore, once main has it
 * @returns {(chatId: string) => boolean} whether a chat is MoMo's (kept apart)
 */
function isolateChatTools(registry, chats) {
  const meta = (/** @type {string} */ chatId) => chats()?.records.get(chatId)?.meta;
  const momo = (/** @type {string} */ chatId) => isMomoMeta(meta(chatId));
  registry.setChatScope((/** @type {string} */ name, /** @type {string} */ chatId) => !dataOnlyMeta(meta(chatId)) && momoTool(name), momo);
  return momo;
}

/**
 * A tool session's own rule for a thread that starts before its chat names it (a MoMo chat's Codex thread): its tool
 * list and calls keep MoMo's tools only, on top of the session's other rule.
 * @param {((name: string) => boolean) | null} hide
 * @returns {(name: string) => boolean}
 */
const momoHide = (hide) => (name) => !momoTool(name) || (typeof hide === 'function' && hide(name) === true);

/**
 * The chat a MoMo chat's Codex thread's tool session serves until the thread's start is answered (#2356): Codex lists a
 * thread's tools while it starts the thread, before its chat is named or tagged MoMo's, and keeps that list, so the
 * session stands for a MoMo chat from its first list on. Only main opens such a session (an isolated thread/start), and
 * no call reaches it before the answer names its real chat.
 */
const PENDING = 'momo-pending:';
const pendingMomoChat = (/** @type {string} */ key) => `${PENDING}${key}`;
/**
 * A MoMo tool's `visibleTo` (the registry's list and call check): the chats `visible` serves, and, while MoMo is allowed,
 * a MoMo thread's session still waiting for its chat, which lists every MoMo tool since its chat's role isn't known yet.
 * Its calls come only once the chat is known, and each handler checks that chat again.
 * @param {(chatId: string) => boolean} visible @param {() => boolean} allowed
 */
const momoListed = (visible, allowed) => (/** @type {string} */ chatId) =>
  String(chatId).startsWith(PENDING) ? allowed() === true : visible(chatId);

/**
 * Whether `target` may be read or messaged from another chat or a window surface: never when it is MoMo's.
 * @param {{ records: Map<string, { meta?: unknown }> }} chats
 * @param {string} target
 */
const readable = (chats, target) => chats.records.has(target) && !isMomoMeta(chats.records.get(target)?.meta);

module.exports = {
  CHAT_TOOLS,
  MOMO_TOOLS,
  MOMO_FAMILIES,
  NOT_MOMO,
  NOT_MOMO_FAMILIES,
  momoTool,
  dataOnlyMeta,
  momoHide,
  pendingMomoChat,
  momoListed,
  isolateChatTools,
  readable,
};
