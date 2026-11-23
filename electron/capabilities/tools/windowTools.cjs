// The window tools a chat uses to arrange what the user sees, as Claude Desktop's ccd_window ones (open_session_in,
// close_split, get_window_layout), the same on Codex, Claude Code and admitted ACP harnesses. Main finds the app window
// showing the calling chat and asks that window to change its layout (window:layout), one request at a time per
// window; a result says only what the window reports it did. Nothing here ever moves the OS focus.
const { ToolError } = require('../contract/registry.cjs');
const { threadHash } = require('../../../shared/deepLink.mjs');
const { isDescendant, resolveMember } = require('../../session/orchestration/family.cjs');
const { askWindow } = require('../../platform/exitGate.cjs');
const { shownBy } = require('../../session/viewing.cjs');

/** How long a window has to answer a layout request; a page that doesn't answer in time changed nothing we know of. */
const LAYOUT_REPLY_MS = 5000;
const TARGETS = ['split', 'window', 'focus'];
const settled = () => undefined;

/** What the model is told when the calling chat is on no screen: nothing changed, and how the user finds it. */
const NOT_ON_SCREEN =
  'This session is not on screen, so the layout was left as it is. Do not retry; tell the user they can open it from the sidebar (right-click it → Open in → Split view).';

/**
 * Words for what a window did, by its outcome, for the model (each says what to do next where there is something).
 * @type {Record<string, string>}
 */
const SAID = {
  opened: 'Opened it in split view beside this session.',
  visible: 'It is already on screen; nothing changed.',
  full: 'Split view already shows as many sessions as it can; nothing changed. Close one first (close_split) or tell the user.',
  no_room: 'The window is too narrow for another split view pane; nothing changed. Tell the user.',
  focused: 'Showed it in the main pane.',
  busy: 'The user is typing (a text field or terminal has the keyboard), so it was not moved into the main pane. Tell the user where to find it instead.',
  closed: 'Closed the split view pane. The session in it keeps running.',
  missing: 'No split view pane you opened is showing; nothing changed.',
  'not-yours': 'That pane was not opened by you, or the user has arranged it since; it stays. Only the user closes it.',
  window: 'Opened it in its own window, behind the current one.',
  layout: 'The window layout is above.',
  collapsed: 'Collapsed the sidebar.',
  expanded: 'Showed the sidebar.',
  unchanged: 'The sidebar was already like that; nothing changed.',
};

/**
 * @param {any} registry
 * @param {object} o
 * @param {(ctx: any) => string | null} o.owner the chat a call came from
 * @param {() => any} o.journal the linked-session journal (who started whom), or null while it is unavailable
 * @param {Map<number, import('../../session/viewing.cjs').WindowView>} o.viewedBy webContents id -> that window's view (app:viewing)
 * @param {() => Iterable<any>} o.windows the app's open windows (not Quick Chat)
 * @param {(hash: string, opts: object) => any} o.createWindow opens a window on a chat
 * @param {any} o.ipcMain
 * @param {number} [o.replyMs]
 * @returns {() => void} removes the tools
 */
function registerWindowTools(registry, { owner, journal, viewedBy, windows, createWindow, ipcMain, replyMs = LAYOUT_REPLY_MS }) {
  /** per window, the request under way: the next one waits for it, so replies match what each one did */
  const queues = new Map();
  const serially = (wcId, run) => {
    const next = (queues.get(wcId) ?? Promise.resolve()).then(run, run);
    // the next request waits for this one to settle, whatever it settled as; the last one leaves no entry behind
    const tail = next.then(settled, settled).then(() => {
      if (queues.get(wcId) === tail) queues.delete(wcId);
    });
    queues.set(wcId, tail);
    return next;
  };
  /** The open app windows showing `chatId`, the focused one first. */
  const showing = (chatId) =>
    [...windows()]
      .filter((w) => !w.isDestroyed() && shownBy(viewedBy, w.webContents.id, chatId))
      .sort((a, b) => Number(b.isFocused()) - Number(a.isFocused()));
  /** Asks the window `w` for one layout change; what it reports, or a refusal when it can't answer. */
  const ask = (w, request) =>
    serially(w.webContents.id, async () => {
      let reply;
      try {
        reply = await askWindow(ipcMain, w.webContents, 'window:layout', request, replyMs);
      } catch {
        // its page crashed or reloaded mid-request: the new page never got it
        throw new ToolError("Couldn't change the window layout: its page reloaded or stopped. Tell the user.", 'window_gone');
      }
      if (!reply || typeof reply !== 'object' || typeof reply.outcome !== 'string')
        throw new ToolError("The window didn't confirm a change, so the layout may be as it was", 'no_reply');
      return reply;
    });
  /** The chat `session_id` names: this one ("self"), or one this chat started (or one of those started). */
  const target = (caller, sessionId) => {
    // a required string (the Registry checks it): an empty one is this chat
    const wanted = String(sessionId).trim();
    if (!wanted || wanted.toLowerCase() === 'self') return caller;
    const j = journal();
    const id = j ? resolveMember(j, caller, wanted) : null;
    if (id && (id === caller || isDescendant(j, id, caller))) return id;
    throw new ToolError(
      'session_id must be "self" or a session this session started (start_session). For any other session, tell the user to open it from the sidebar: right-click it → Open in → Split view.',
      'not_linked',
    );
  };
  const result = (outcome, extra = {}) => ({
    changed: ['opened', 'focused', 'closed', 'window', 'collapsed', 'expanded'].includes(outcome),
    outcome,
    said: SAID[outcome] ?? '',
    ...extra,
  });
  const add = (name, description, properties, required, policy, handler) =>
    registry.register({
      name,
      description,
      schema: { type: 'object', properties, required, additionalProperties: false },
      policy,
      authorizesItself: policy === 'act',
      handler: async (args, ctx) => {
        const caller = owner(ctx);
        if (!caller) throw new ToolError('The caller does not own this chat segment', 'no_owner');
        return handler(args, caller);
      },
    });

  const disposers = [
    add(
      'open_session_in',
      'Show another session next to this one. Layout only: nothing is sent to that session, and it keeps running either way. The typical use is right after start_session returns a chat_id: open that session in split view beside this one so the user can watch it work. session_id must be this session ("self") or a session this session started; for any other session, tell the user to open it from the sidebar (right-click it → Open in → Split view). target "split": a split view pane in the window where this session is showing; "window": its own window, opened behind the current one; "focus": show it in this window\'s main pane, like clicking its sidebar row (refused while the user is typing in a text field or terminal). Acts only while this session is on screen; if it is not, it changes nothing and says so: don\'t retry, tell the user where to find the session. A session already on screen is reported as such. The OS focus is never changed.',
      {
        session_id: { type: 'string', description: 'A chat_id from start_session or list_sessions, its name, or "self"' },
        target: { type: 'string', enum: TARGETS, description: '"split" | "window" | "focus"' },
      },
      ['session_id', 'target'],
      'act',
      async (args, caller) => {
        if (!TARGETS.includes(args.target)) throw new ToolError('target must be "split", "window" or "focus"', 'bad_target');
        const chatId = target(caller, args.session_id);
        const w = showing(caller)[0];
        if (!w) return { changed: false, outcome: 'not_on_screen', said: NOT_ON_SCREEN };
        if (args.target === 'window') {
          if (showing(chatId).length) return result('visible', { session_id: chatId });
          createWindow(threadHash(chatId), { inactive: true });
          return result('window', { session_id: chatId });
        }
        const reply = await ask(w, { op: args.target, caller, chatId });
        return result(reply.outcome, { session_id: chatId });
      },
    ),
    add(
      'close_split',
      'Close a split view pane that you opened with open_session_in (target "split"), never a pane the user opened or has arranged since. The session in it keeps running; only the pane goes away. session_id picks which of your panes to close; omit it to close the most recent one still open. Acts only while this session is on screen.',
      { session_id: { type: 'string', description: 'The session whose pane to close (one you opened); omit for the most recent' } },
      [],
      'act',
      async (args, caller) => {
        const chatId = args.session_id === undefined ? null : target(caller, args.session_id);
        const w = showing(caller)[0];
        if (!w) return { changed: false, outcome: 'not_on_screen', said: NOT_ON_SCREEN };
        const reply = await ask(w, { op: 'close', caller, chatId });
        return result(reply.outcome, chatId ? { session_id: chatId } : {});
      },
    ),
    add(
      'get_window_layout',
      "Describe the window showing this session: the main pane's page or session, its split view panes (session ids, which one is focused, which you opened), and whether this session is on screen at all. Read-only. Use it before rearranging, or to check whether the user can see this session now.",
      {},
      [],
      'observe',
      async (_args, caller) => {
        const w = showing(caller)[0];
        if (!w) return { on_screen: false, said: 'This session is not on screen in any window.' };
        const reply = await ask(w, { op: 'layout', caller, chatId: null });
        return { on_screen: true, ...reply.layout, windows_showing_this_session: showing(caller).length };
      },
    ),
    add(
      'set_sidebar_collapsed',
      "Collapse or show the sidebar of the window showing this session, the same as the user's Hide sidebar toggle. Acts only while this session is on screen. Use it to give the user room (collapsed true) or to bring the session list back (false).",
      { collapsed: { type: 'boolean', description: 'true hides the sidebar, false shows it' } },
      ['collapsed'],
      'act',
      async (args, caller) => {
        const w = showing(caller)[0];
        if (!w) return { changed: false, outcome: 'not_on_screen', said: NOT_ON_SCREEN };
        const reply = await ask(w, { op: 'sidebar', caller, chatId: null, collapsed: args.collapsed });
        return result(reply.outcome);
      },
    ),
  ];
  return () => disposers.forEach((dispose) => dispose());
}

module.exports = { registerWindowTools, LAYOUT_REPLY_MS, NOT_ON_SCREEN };
