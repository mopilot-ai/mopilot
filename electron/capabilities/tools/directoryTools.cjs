// The directory tools a chat uses to reach folders and branches, as Claude Desktop's ccd_directory ones (request_directory,
// change_directory, propose_branch), the same on Codex, Claude Code and admitted ACP harnesses, with or without a window
// open. A folder is granted only after the user chose it (a picker) or approved the exact path (a card), and the chat is
// told whether its harness has the folder now or from its next turn. A session's working directory can't be moved
// mid-conversation on any harness, so change_directory grants the folder and says so.
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { ToolError } = require('../contract/registry.cjs');
const { realPathAsync, lexicalInside } = require('../../platform/pathInside.cjs');
const { expandHome } = require('./sessionFolders.cjs');
const { toolAdder, askUser } = require('./hostToolKit.cjs');

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
/** Whether `name` is a branch name this tool will pass on (no `..`, no empty or dotted parts, no .lock). */
const validBranch = (/** @type {unknown} */ name) =>
  typeof name === 'string' &&
  BRANCH.test(name) &&
  !name.includes('..') &&
  name.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));

const REQUEST =
  "Request access to a directory on the user's computer that is outside your current working directory. If you know the path, pass it: the user sees and approves that exact folder. If you omit `path`, a native folder picker opens. Use this whenever the user asks you to work with files you don't currently have access to.";
const CHANGE =
  "Move this session to a different project directory on the user's computer. `path` is required and the user sees and approves that exact folder. Access is granted at once; this harness can't move a running session's working directory, so it stays where it is and you use absolute paths for the new folder. Use this when the user's task is about an existing project and the session isn't in it yet; to let the user pick a folder themselves, use request_directory without a path.";
const BRANCH_TOOL =
  "Ask the user whether your changes should go on a new Git branch or land on the branch that is checked out. Call it once, right before your first file edit in a Git repository (not earlier, and not for read-only questions), unless the user already said which branch to use; `suggested` is a short branch name for the task (e.g. fix/canada-tax). The result is the user's choice; create and switch to the branch yourself when they pick a new one.";

const IN_WORKTREE = (/** @type {string | null | undefined} */ branch) =>
  `This session already runs in its own worktree${branch ? ` on branch ${branch}` : ''}, so the changes are isolated from the user's main checkout. Do not create or switch branches; edit here.`;
const NEEDS_PATH =
  'change_directory requires `path`: the absolute path of the folder to move the session to. To let the user choose a folder, call request_directory without a path instead.';
const DECLINED = 'The user declined to give access to that folder, so it was not granted. Do not ask for it again unless they bring it up.';
const STAYS =
  "This harness can't move a running session's working directory, so it stays where it is. Use the folder's absolute path in commands and file tools, or ask the user to start a session in that folder.";

/**
 * @param {any} registry
 * @param {object} o
 * @param {(ctx: any) => string | null} o.owner the chat a call came from
 * @param {{ folders(chatId: string): Promise<string[]> }} o.sessionFolders
 * @param {(chatId: string, directory: string) => Promise<{ status: string, note: string | null }>} o.grant saves the folder for the chat
 * @param {(chatId: string, signal: AbortSignal | null, card: object) => Promise<any>} o.ask puts a card to the user
 * @param {() => Promise<string | null>} o.pickFolder the native folder picker: the folder chosen, or null
 * @param {(args: string[], cwd: string) => Promise<{ ok: boolean, stdout: string }>} o.git
 * @param {(dir: string) => { branch?: string | null } | null} o.worktreeInfo the managed worktree a folder is in
 * @returns {() => void} removes the tools
 */
function registerDirectoryTools(registry, { owner, sessionFolders, grant, ask, pickFolder, git, worktreeInfo }) {
  const add = toolAdder(registry, owner);

  /** The folder `raw` names, as a real directory path, or a ToolError saying why not. */
  const directoryAt = async (/** @type {string} */ raw) => {
    const wanted = expandHome(raw);
    if (!path.isAbsolute(wanted)) throw new ToolError('`path` must be an absolute folder path (or start with ~).', 'invalid_args');
    const real = await realPathAsync(wanted);
    if (!real) throw new ToolError(`No folder at ${wanted}`, 'not_found');
    if (!(await fs.promises.stat(real)).isDirectory()) throw new ToolError(`${wanted} is a file, not a folder.`, 'invalid_args');
    if (path.parse(real).root === real)
      throw new ToolError('The filesystem root can not be granted; name the project folder.', 'invalid_args');
    return real;
  };

  /** Whether `dir` (a real path) is one of the chat's folders or inside one. */
  const insideSession = async (/** @type {string} */ caller, /** @type {string} */ dir) => {
    for (const folder of await sessionFolders.folders(caller)) {
      const real = await realPathAsync(folder);
      if (real && lexicalInside(real, dir)) return true;
    }
    return false;
  };

  /** Grants a folder: the one named (after the user approved it) or the one they pick; the text the model gets back. */
  const grantFolder = async (
    /** @type {any} */ args,
    /** @type {string} */ caller,
    /** @type {any} */ ctx,
    /** @type {boolean} */ move,
  ) => {
    const raw = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '';
    if (move && !raw) throw new ToolError(NEEDS_PATH, 'invalid_args');
    let dir;
    if (raw) {
      dir = await directoryAt(raw);
      if (!(await insideSession(caller, dir))) {
        const { allowed } = await askUser(ask, caller, ctx, {
          title: 'Folder access',
          message: move ? 'Move this session to this folder?' : 'Give this session access to this folder?',
          details: [dir],
          choices: [{ id: 'allow', label: 'Allow' }],
        });
        if (!allowed) throw new ToolError(DECLINED, 'denied');
        // approval can wait for minutes: what was approved must still be what the path names
        if ((await realPathAsync(expandHome(raw))) !== dir)
          throw new ToolError('The directory changed while approval was pending; request it again.', 'changed');
      }
    } else {
      const picked = await pickFolder();
      if (!picked) return 'Directory selection was cancelled by the user.';
      dir = await directoryAt(picked);
    }
    const { status, note } = await grant(caller, dir);
    if (status === 'gone') throw new ToolError('This session is no longer available.', 'gone');
    if (status === 'unsaved') throw new ToolError('Failed to grant folder access: the session could not save it.', 'failed');
    return [
      `Folder access granted: ${dir}`,
      `Use this exact absolute path ${move ? 'from now on' : 'when reading or writing files there'}.`,
      ...(note ? [note] : []),
      ...(move ? [STAYS] : []),
    ].join('\n\n');
  };

  const disposers = [
    add(
      'request_directory',
      REQUEST,
      { path: { type: 'string', description: 'Absolute host path to grant (e.g. ~/Downloads). Omit to open the native folder picker.' } },
      [],
      (args, caller, ctx) => grantFolder(args, caller, ctx, false),
    ),
    add(
      'change_directory',
      CHANGE,
      { path: { type: 'string', description: 'Absolute host path of the folder to move the session to (e.g. ~/code/my-project).' } },
      ['path'],
      (args, caller, ctx) => grantFolder(args, caller, ctx, true),
    ),
    add(
      'propose_branch',
      BRANCH_TOOL,
      { suggested: { type: 'string', description: 'A short branch name for this task, e.g. fix/canada-tax.' } },
      ['suggested'],
      async (args, caller, ctx) => {
        const suggested = validBranch(args.suggested) ? args.suggested : undefined;
        const [cwd] = await sessionFolders.folders(caller);
        // a managed worktree is already isolated on its own branch: nothing to ask
        const managed = cwd ? worktreeInfo(cwd) : null;
        if (managed) return IN_WORKTREE(managed.branch);
        const head = cwd ? await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) : null;
        if (!head?.ok)
          throw new ToolError("This session's folder is not a Git repository, so there is no branch to ask about.", 'not_a_repo');
        const current = head.stdout.trim();
        const { choice } = await askUser(ask, caller, ctx, {
          title: 'Branch',
          message: 'Where should the changes go?',
          details: [suggested ? `New branch: ${suggested}` : 'A new branch', `Current branch: ${current}`],
          choices: [
            { id: 'new', label: 'New branch' },
            { id: 'stay', label: current === 'HEAD' ? 'Stay here' : `Stay on ${current}` },
          ],
        });
        if (choice === 'stay')
          return 'The user wants the changes on the branch that is currently checked out. Do not create or switch branches.';
        const lead = choice === 'new' ? 'The user wants' : 'No branch was picked, so put';
        return suggested
          ? `${lead} the changes on a new branch named ${suggested}. Create it and switch to it (git switch -c) before editing, and keep the original branch untouched.`
          : `${lead} the changes on a new branch. Create one with a short descriptive name and switch to it before editing.`;
      },
    ),
  ];
  return () => disposers.forEach((dispose) => dispose());
}

module.exports = { registerDirectoryTools, validBranch };
