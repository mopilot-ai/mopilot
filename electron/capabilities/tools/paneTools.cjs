// The pane tools a chat uses to show the user what it is talking about beside the conversation, as Claude Desktop's
// ccd_view show_pane / close_pane and its terminal tool's open_terminal_tab, the same on Codex, Claude Code and admitted
// ACP harnesses. Main asks the window showing the calling chat (window:layout, answered by src/lib/windowPanes.ts); a
// chat on no screen changes nothing, another session's pane is never touched, and nothing moves the OS focus.
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { ToolError } = require('../contract/registry.cjs');
const { askWindow } = require('../../platform/exitGate.cjs');
const { shownBy } = require('../../session/viewing.cjs');
const { lexicalInside, realPath } = require('../../platform/pathInside.cjs');
const { classifyClaudeUrl } = require('../../../shared/claudeArtifacts.mjs');
const { registerTerminalTools, TerminalTabs } = require('./terminalTools.cjs');

const PANES = ['diff', 'file', 'terminal', 'tasks', 'preview', 'artifact'];
const SCOPES = ['branch', 'uncommitted', 'turn'];
const PANE_REPLY_MS = 5000;

/** What the model hears for each outcome the window reports (or main decides), with what to do next. */
const SAID = {
  shown: (pane) => `Showing the ${pane} pane.`,
  closed: (pane) => `Closed the ${pane} pane.`,
  not_open: (pane) => `The ${pane} pane isn't open; nothing changed.`,
  opened: () => 'Opened a terminal tab and showed the panel. It runs the user’s shell and types nothing.',
  not_on_screen: () => "This session isn't on screen in any window, so nothing was shown. Tell the user what to look at instead.",
  not_focused: () =>
    'This session is in split view, and the side pane belongs to the focused session, so nothing was shown. Tell the user what to look at instead.',
  no_page: () => "This session's built-in browser has no page open, so there is nothing to show. Open one with the browser tools first.",
  no_terminal: () => 'This session has no terminal tab open. Open one with open_terminal_tab.',
  no_tab: () => 'No open tab of this session has that tab_id; nothing changed. Omit tab_id to show the pane as it is.',
};

/**
 * @param {any} registry
 * @param {object} o
 * @param {(ctx: any) => string | null} o.owner the chat a call came from
 * @param {Map<number, import('../../session/viewing.cjs').WindowView>} o.viewedBy webContents id -> that window's view (app:viewing)
 * @param {() => Iterable<any>} o.windows the app's open windows (not Quick Chat)
 * @param {(chatId: string) => Promise<string | null>} o.projectOf the chat's working directory
 * @param {(chatId: string, signal: AbortSignal | null, req: { cwd: string }) => Promise<boolean>} o.approveTerminal the user's
 *   answer to a terminal in `cwd`; the call's signal withdraws the card
 * @param {(chatId: string, signal: AbortSignal | null, req: { cwd: string, command: string }) => Promise<boolean>} [o.approveCommand]
 *   the user's answer to one command line run_in_terminal would type (the card names the line)
 * @param {(chatId: string) => 'readOnly' | 'ask' | 'auto' | 'full'} [o.anchorOf] the chat's permission anchor
 * @param {any} o.pty electron/platform/pty.cjs (info, write)
 * @param {any} o.ipcMain
 * @param {number} [o.replyMs]
 * @returns {() => void} removes the tools
 */
function registerPaneTools(
  registry,
  { owner, viewedBy, windows, projectOf, approveTerminal, approveCommand, anchorOf, pty, ipcMain, replyMs = PANE_REPLY_MS, ...timing },
) {
  /** the Terminal tabs each chat opened, which run_in_terminal, read_terminal and stop_terminal_tab act on */
  const terminals = new TerminalTabs();
  /** chat id -> folders the user allowed a terminal in, for the rest of the chat */
  const allowedTerminals = new Map();
  /** The open app window showing `chatId`, the focused one first, or null. */
  const showing = (chatId) =>
    [...windows()]
      .filter((w) => !w.isDestroyed() && shownBy(viewedBy, w.webContents.id, chatId))
      .sort((a, b) => Number(b.isFocused()) - Number(a.isFocused()))[0] ?? null;
  /** The window's answer to one pane request, or a refusal when it can't answer. */
  const ask = async (w, request) => {
    let reply;
    try {
      reply = await askWindow(ipcMain, w.webContents, 'window:layout', request, replyMs);
    } catch {
      throw new ToolError("Couldn't change the pane: the window's page reloaded or stopped. Tell the user.", 'window_gone');
    }
    if (!reply || typeof reply !== 'object' || typeof reply.outcome !== 'string')
      throw new ToolError("The window didn't confirm a change, so the pane may be as it was", 'no_reply');
    return reply;
  };
  const result = (pane, reply) => {
    const said = SAID[reply.outcome]?.(pane) ?? '';
    return {
      changed: ['shown', 'closed', 'opened'].includes(reply.outcome),
      outcome: reply.outcome,
      said,
      ...(reply.tab_id ? { tab_id: reply.tab_id } : {}),
    };
  };
  /** A folder or file `p` names for `chatId`: absolute, or relative to its working directory; null without one. */
  const resolveIn = async (chatId, p) => {
    const cwd = await projectOf(chatId);
    if (!cwd) return { cwd: null, full: path.isAbsolute(p) ? path.normalize(p) : null };
    return { cwd, full: path.resolve(cwd, p) };
  };
  /** Whether `full` lies in `dir` (the callers compare both as written and by their real paths). */
  const inside = lexicalInside;
  const real = realPath;
  /** chat id + folder -> the card under way for it, so overlapping calls share one card */
  const asking = new Map();
  const add = (name, description, properties, required, handler) =>
    registry.register({
      name,
      description,
      schema: { type: 'object', properties, required, additionalProperties: false },
      policy: 'act',
      authorizesItself: true,
      handler: async (args, ctx) => {
        const caller = owner(ctx);
        if (!caller) throw new ToolError('The caller does not own this chat segment', 'no_owner');
        return handler(args, caller, ctx);
      },
    });

  const notOnScreen = () => ({ changed: false, outcome: 'not_on_screen', said: SAID.not_on_screen() });
  /** The folder a terminal starts in: `cwd` (absolute, or relative to the chat's folder; default that folder), which must exist. */
  const folderOf = async (chatId, cwd) => {
    const { full } = await resolveIn(chatId, typeof cwd === 'string' && cwd.trim() ? cwd.trim() : '.');
    if (!full) throw new ToolError('This session has no working directory: give cwd as an absolute folder.', 'bad_args');
    if (!fs.statSync(full, { throwIfNoEntry: false })?.isDirectory()) throw new ToolError(`No folder at ${full}`, 'not_found');
    return full;
  };
  /** A new Terminal tab in `dir` in the window showing the chat, remembered as the chat's own; null when no window shows it. */
  const openIn = async (chatId, dir) => {
    const w = showing(chatId);
    if (!w) return null;
    const reply = await ask(w, { op: 'open_terminal', caller: chatId, chatId: null, cwd: dir });
    if (reply.outcome === 'opened' && reply.tab_id) terminals.opened(chatId, w.webContents.id, reply.tab_id, dir);
    return { reply };
  };

  const disposers = [
    add(
      'show_pane',
      'Show one of this session\'s side panes in the user\'s view of MoPilot, beside the conversation.\n\nPanes: "diff" (the session\'s changes; optional `path` scrolls to that changed file, `diff_scope` picks "branch" (all branch changes, the default), "uncommitted", or "turn" (this turn\'s edits)), "file" (`path` opens that file at `line`; it must be inside the session\'s working directory), "terminal" (optional `tab_id` switches to that open tab), "tasks" (background tasks), "preview" (the built-in browser, once this session has a page open in it; optional `tab_id` picks the tab), "artifact" (`url` is a claude.ai artifact or Claude Design project link, such as one an Artifact publish returned; it shows as its own tab when the built-in browser is signed in to claude.ai, else the tab offers the user to sign in or open it in their browser).\n\nPrefer showing over describing: after finishing a set of edits, show the diff; when pointing the user at code, open the file at the line. It only changes what is on screen for this session: if the session isn\'t open in any window, or another session is focused in split view, it does nothing and says so (tell the user what to look at instead), and it never takes focus from another session.',
      {
        pane: { type: 'string', enum: PANES },
        path: {
          type: 'string',
          description:
            'For "file": the file to open (absolute, or relative to the working directory). For "diff": the changed file to scroll to.',
        },
        line: { type: 'number', description: 'For "file": 1-based line to scroll to.' },
        diff_scope: { type: 'string', enum: SCOPES, description: 'For "diff": "branch" (the default), "uncommitted", or "turn".' },
        tab_id: {
          type: 'string',
          description:
            'For "terminal" or "preview": the open tab to switch to, by the tab_id a terminal or browser tool gave you. Omit to show the pane as it is.',
        },
        url: { type: 'string', description: 'For "artifact": the claude.ai artifact or Claude Design project link to show.' },
      },
      ['pane'],
      async (args, caller) => {
        if (!PANES.includes(args.pane)) throw new ToolError(`pane must be one of ${PANES.join(', ')}`, 'bad_args');
        if (args.diff_scope !== undefined && !SCOPES.includes(args.diff_scope))
          throw new ToolError('diff_scope must be "branch", "uncommitted" or "turn"', 'bad_args');
        // only claude.ai's own artifact and design pages, checked before anything is shown
        if (args.pane === 'artifact' && !classifyClaudeUrl(args.url))
          throw new ToolError('"artifact" needs url: a claude.ai artifact or Claude Design project link', 'bad_args');
        const w = showing(caller);
        if (!w) return { changed: false, outcome: 'not_on_screen', said: SAID.not_on_screen() };
        const req = { op: 'show_pane', caller, chatId: null, pane: args.pane };
        if (args.pane === 'artifact') Object.assign(req, { url: args.url });
        if (args.pane === 'file') {
          if (typeof args.path !== 'string' || !args.path.trim()) throw new ToolError('"file" needs a path', 'bad_args');
          const { cwd, full } = await resolveIn(caller, args.path.trim());
          const outside = () =>
            new ToolError(
              `${args.path} is not inside this session's working directory${cwd ? ` (${cwd})` : ''}; only files there can be shown.`,
              'bad_args',
            );
          // outside as written (under the folder's own or its real path) is refused before anything about it is looked up
          const folder = cwd ? (real(cwd) ?? cwd) : '';
          if (!cwd || !full || (!inside(cwd, full) && !inside(folder, full))) throw outside();
          const file = real(full);
          if (!file || !fs.statSync(file).isFile()) throw new ToolError(`No file at ${full}`, 'not_found');
          // a link inside that leads out of the folder
          if (!inside(folder, file)) throw outside();
          Object.assign(req, { path: full, ...(Number.isInteger(args.line) && args.line > 0 ? { line: args.line } : {}) });
        } else if (args.pane === 'diff') {
          if (typeof args.path === 'string' && args.path.trim()) Object.assign(req, { path: args.path.trim() });
          Object.assign(req, { scope: args.diff_scope ?? 'branch' });
        } else if ((args.pane === 'terminal' || args.pane === 'preview') && typeof args.tab_id === 'string' && args.tab_id) {
          Object.assign(req, { tabId: args.tab_id });
        }
        return result(args.pane, await ask(w, req));
      },
    ),
    add(
      'close_pane',
      "Close one of this session's side panes in the user's view. No-op when it is not open, or the session isn't on screen (or is not the focused one in split view). The tabs in it stay: the user can open the pane again.",
      { pane: { type: 'string', enum: PANES } },
      ['pane'],
      async (args, caller) => {
        if (!PANES.includes(args.pane)) throw new ToolError(`pane must be one of ${PANES.join(', ')}`, 'bad_args');
        const w = showing(caller);
        if (!w) return { changed: false, outcome: 'not_on_screen', said: SAID.not_on_screen() };
        return result(args.pane, await ask(w, { op: 'close_pane', caller, chatId: null, pane: args.pane }));
      },
    ),
    add(
      'open_terminal_tab',
      "Open a new tab in the user's Terminal panel beside this session and show the panel. It starts the user's shell (their login shell, with their startup files) in cwd, default the session's working directory, and types nothing. The user approves the folder (once per folder for this chat). Returns its tab_id for show_pane. Use it only to hand the user an empty shell; run_in_terminal opens a tab of its own for a command.",
      {
        cwd: {
          type: 'string',
          description: "The folder to start in (absolute, or relative to the working directory); default the session's working directory",
        },
      },
      [],
      async (args, caller, ctx) => {
        if (!showing(caller)) return notOnScreen();
        const dir = await folderOf(caller, args.cwd);
        const allowed = allowedTerminals.get(caller) ?? new Set();
        if (!allowed.has(dir)) {
          const key = `${caller}\n${dir}`;
          const card = asking.get(key) ?? approveTerminal(caller, ctx.signal, { cwd: dir }).finally(() => asking.delete(key));
          asking.set(key, card);
          if (!(await card)) throw new ToolError('The user declined to open a terminal there.', 'denied');
          allowedTerminals.set(caller, allowed.add(dir));
        }
        // the window may have moved on while the card waited: ask whichever shows the chat now
        const opened = await openIn(caller, dir);
        if (!opened) return notOnScreen();
        return result('terminal', opened.reply);
      },
    ),
    ...registerTerminalTools({
      add,
      terminals,
      pty,
      showing,
      ask,
      folderOf,
      openIn,
      notOnScreen,
      approveCommand: approveCommand ?? (async () => false),
      anchorOf,
      ...timing,
    }),
  ];
  return () => disposers.forEach((dispose) => dispose());
}

module.exports = { registerPaneTools, PANE_REPLY_MS, SAID };
