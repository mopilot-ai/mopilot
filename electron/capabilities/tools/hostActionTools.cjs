// The host tools a chat uses to hand work back to the user's computer, as Claude Desktop's ccd_host ones (open_in_editor,
// reveal_path, request_keep_awake), the same on Codex, Claude Code and admitted ACP harnesses, with or without a window
// open. A file or folder opens only from the chat's own folders and after the user approved that exact path; a keep-awake
// hold is the app's (platform/keepAwake.cjs) and ends with the turn, the idle chat, a stop, the chat's end or the app.
const path = require('node:path');
const { ToolError } = require('../contract/registry.cjs');
const { toolAdder, askUser } = require('./hostToolKit.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { EDITOR_IDS } = require('../../platform/editorLauncher.cjs');

const MAX_LINE = 1e7;
const MAX_REASON = 200;
const WORKSPACE = /\.code-workspace$/i;
const LOOKS_LIKE_LINE = /:\d+(?::\d+)?$/;

const OPEN_EDITOR =
  "Open a file from this session's project in the user's code editor (VS Code, Cursor, Windsurf or Zed), optionally at a line and column. Use it to hand work back to the user: after a change they'll want to inspect or finish by hand, or when they ask you to open something.\n\n`path` is absolute or relative to the session's working directory, and must be inside the session's folders (the working directory or worktree, or a folder granted with request_directory). If the user has several supported editors installed and hasn't chosen one in Settings, the call fails and lists them: ask which they prefer and pass it as `editor`. Files only: to show the user a folder, use reveal_path. The user approves each open on a card that shows the resolved path. Returns once the editor has been asked to open the file; it doesn't report what happens inside the editor.";
const REVEAL =
  "Show a file or folder from this session's project in the system file manager (Finder on macOS, File Explorer on Windows), selected inside its parent folder. Use when the user wants to get at a file outside this app: drag it somewhere, attach it to an email, look at a build output. `path` follows open_in_editor's rules, and may also name a folder. The user approves each reveal on a card that shows the resolved path.";
const keepAwakeText = (/** @type {number} */ idleMin) =>
  `Keep the user's computer from idle-sleeping while this session works. Call this before work that must outlast your turn, such as waiting on CI or a long build you will check on later, or when the user asks you to keep their computer awake.\n\n\`until: "turn_end"\` holds until your current turn finishes. \`until: "session_idle"\` also covers follow-up turns and lets go once the session has been idle for about ${idleMin} minutes. The user approves it once per session (after that, further calls take effect without asking). The hold ends when the session is stopped, archived or deleted or the app quits, and it never changes the user's settings. It prevents idle sleep only: a closed lid still sleeps, and so does choosing Sleep.`;

const NOT_CHECKED =
  'That path no longer resolves to what was approved (something along it changed), so nothing was opened. Call again if it is still wanted.';
const NOT_ALLOWED_AWAKE =
  'The user did not allow keeping the computer awake, so nothing is held. If the work is long, tell the user their computer may sleep when it sits idle.';
const NO_BLOCKER =
  "Keeping the computer awake isn't available in this app, so nothing is held. If the work is long, tell the user their computer may sleep when it sits idle.";

/**
 * @param {any} registry
 * @param {object} o
 * @param {(ctx: any) => string | null} o.owner the chat a call came from
 * @param {{ resolve(chatId: string, p: unknown): Promise<{ path: string, isDirectory: boolean }> }} o.sessionFolders
 * @param {(chatId: string, signal: AbortSignal | null, card: object) => Promise<any>} o.ask puts a card to the user
 * @param {{ installed(): string[], open(id: string, file: string, line?: number, column?: number): Promise<{ ok: boolean, error?: string }>, label(id: string): string }} o.editors
 * @param {() => string | null} o.preferredEditor the editor the user chose in Settings, when it is one of these
 * @param {(p: string) => void} o.reveal shows a path in the file manager
 * @param {string} o.fileManager its name for the user ("Finder")
 * @param {InstanceType<typeof import('../../platform/keepAwake.cjs').KeepAwake>} o.keepAwake
 * @param {number} o.idleMinutes
 * @returns {() => void} removes the tools
 */
function registerHostActionTools(
  registry,
  { owner, sessionFolders, ask, editors, preferredEditor, reveal, fileManager, keepAwake, idleMinutes },
) {
  const add = toolAdder(registry, owner);

  /** The path the user approves for `tool`: resolved inside the chat's folders, checked again after the card. */
  const approvedPath = async (
    /** @type {string} */ caller,
    /** @type {any} */ ctx,
    /** @type {unknown} */ p,
    /** @type {string} */ message,
    /** @type {string[]} */ more = [],
  ) => {
    const target = await sessionFolders.resolve(caller, p);
    return {
      target,
      confirm: async () => {
        const { allowed } = await askUser(ask, caller, ctx, {
          title: 'Open',
          message,
          details: [target.path, ...more],
          choices: [{ id: 'allow', label: 'Allow' }],
        });
        if (!allowed) throw new ToolError('The user declined, so nothing was opened. Tell the user the path instead.', 'denied');
        // the card can wait for minutes: the path must still name what was shown
        /** @type {{ path: string } | null} */
        let again = null;
        try {
          again = await sessionFolders.resolve(caller, p);
        } catch (error) {
          // gone or moved out of the folders meanwhile: the same answer as a path that names something else
          noteIgnored('check an approved path again', error, ['not_found']);
        }
        if (again?.path !== target.path) throw new ToolError(NOT_CHECKED, 'changed');
      },
    };
  };
  const count = (/** @type {unknown} */ v, /** @type {string} */ what) => {
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_LINE)
      throw new ToolError(`${what} must be a whole number from 1 to ${MAX_LINE}.`, 'invalid_args');
    return v;
  };

  const disposers = [
    add(
      'open_in_editor',
      OPEN_EDITOR,
      {
        path: { type: 'string', description: "File to open: absolute, or relative to the session's working directory." },
        line: { type: 'number', description: '1-based line to reveal (files only).' },
        column: { type: 'number', description: '1-based column on that line. Ignored without `line`.' },
        editor: {
          type: 'string',
          enum: EDITOR_IDS,
          description:
            'Only when the user told you which editor to use, or after a previous call listed several. Otherwise omit it and their usual editor is used.',
        },
      },
      ['path'],
      async (args, caller, ctx) => {
        const line = count(args.line, '`line`');
        const column = line === undefined ? undefined : count(args.column, '`column`');
        if (args.editor !== undefined && !EDITOR_IDS.includes(args.editor))
          throw new ToolError(`\`editor\` must be one of ${EDITOR_IDS.join(', ')}.`, 'invalid_args');
        const { target, confirm } = await approvedPath(
          caller,
          ctx,
          args.path,
          'Open this file in your code editor?',
          line === undefined ? [] : [`Line ${line}${column === undefined ? '' : `, column ${column}`}`],
        );
        if (target.isDirectory)
          throw new ToolError('open_in_editor opens files, not folders. To show the user a folder, use reveal_path.', 'not_a_file');
        if (WORKSPACE.test(target.path))
          throw new ToolError(
            "open_in_editor doesn't open workspace files: an editor opens those like a folder, with their tasks and settings. Tell the user the path instead.",
            'not_a_file',
          );
        if (LOOKS_LIKE_LINE.test(path.basename(target.path)))
          throw new ToolError(
            "That file's name ends in a colon and digits, which code editors read as a line number, so it can't be opened from here. Tell the user the path instead.",
            'refused_path',
          );
        const have = editors.installed();
        if (!have.length)
          throw new ToolError(
            'No supported code editor (VS Code, Cursor, Windsurf or Zed) is installed. Tell the user the path instead.',
            'no_editor',
          );
        const named = (/** @type {string[]} */ ids) => ids.map((id) => `${id} (${editors.label(id)})`).join(', ');
        const preferred = preferredEditor();
        let chosen = args.editor ?? (preferred && have.includes(preferred) ? preferred : have.length === 1 ? have[0] : null);
        if (!chosen)
          throw new ToolError(
            `Several editors are installed (${named(have)}) and none is chosen in Settings. Ask the user which they prefer, then call again with \`editor\`.`,
            'choose_editor',
          );
        if (!have.includes(chosen))
          throw new ToolError(`${editors.label(chosen)} is not installed. Installed: ${named(have)}.`, 'not_installed');
        await confirm();
        const opened = await editors.open(chosen, target.path, line, column);
        if (!opened.ok)
          throw new ToolError(
            `Could not open ${target.path} in ${editors.label(chosen)}. Tell the user the path instead.`,
            'launch_failed',
          );
        return `Asked ${editors.label(chosen)} to open ${target.path}${line === undefined ? '' : ` at line ${line}${column === undefined ? '' : `, column ${column}`}`}.`;
      },
    ),
    add(
      'reveal_path',
      REVEAL,
      { path: { type: 'string', description: "File or folder to reveal: absolute, or relative to the session's working directory." } },
      ['path'],
      async (args, caller, ctx) => {
        const { target, confirm } = await approvedPath(caller, ctx, args.path, `Show this in ${fileManager}?`);
        await confirm();
        try {
          reveal(target.path);
        } catch {
          throw new ToolError(`Could not reveal ${target.path}. Tell the user the path instead.`, 'launch_failed');
        }
        return `Revealed ${target.isDirectory ? 'folder ' : ''}${target.path} in ${fileManager}.`;
      },
    ),
    add(
      'request_keep_awake',
      keepAwakeText(idleMinutes),
      {
        until: {
          type: 'string',
          enum: ['turn_end', 'session_idle'],
          description:
            '"turn_end": release when this turn finishes. "session_idle": keep across follow-up turns until the session goes quiet.',
        },
        reason: { type: 'string', description: 'One short sentence the user sees when approving: what work needs the machine awake.' },
      },
      ['until', 'reason'],
      async (args, caller, ctx) => {
        if (args.until !== 'turn_end' && args.until !== 'session_idle')
          throw new ToolError('`until` must be "turn_end" or "session_idle".', 'invalid_args');
        const reason = args.reason.replace(/\s+/g, ' ').trim();
        if (!reason || reason.length > MAX_REASON)
          throw new ToolError(
            `\`reason\` is required: one short sentence (at most ${MAX_REASON} characters) saying what work needs the machine awake.`,
            'invalid_args',
          );
        if (!keepAwake.available) throw new ToolError(NO_BLOCKER, 'unavailable');
        if (!keepAwake.approved.has(caller)) {
          const { allowed } = await askUser(ask, caller, ctx, {
            title: 'Keep awake',
            message: 'Keep this computer awake while this session works?',
            details: [reason],
            choices: [{ id: 'allow', label: 'Allow' }],
          });
          if (!allowed) throw new ToolError(NOT_ALLOWED_AWAKE, 'denied');
          keepAwake.approved.add(caller);
        }
        // the card was withdrawn because the call was stopped (or the chat ended) as it was answered: nothing to hold for
        if (ctx?.signal?.aborted) throw new ToolError('The call was stopped before the hold began, so nothing is held.', 'aborted');
        const held = keepAwake.hold(caller, args.until);
        const when =
          args.until === 'turn_end' ? 'until this turn finishes' : `until the session has been idle for about ${idleMinutes} minutes`;
        return `${held === 'replaced' ? 'Updated the keep-awake hold' : 'Keeping this computer awake'} ${when}. It ends early if the session is stopped or archived or the app quits, prevents idle sleep only (a closed lid or a manual sleep still sleeps), and leaves the user's settings unchanged.`;
      },
    ),
  ];
  return () => disposers.forEach((dispose) => dispose());
}

module.exports = { registerHostActionTools };
