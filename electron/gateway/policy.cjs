// Which stance the gateway takes on one of its tools for one chat (#2999 C3): the user's rules (rules.cjs) over the chat's harness, permission mode and folders, decided by shared/toolRules.mjs. A chat's folder is the project a managed worktree belongs to, else its working folder, as its real path (a symlink is the same folder, and the path is in the file system's own case), written with `/` (a Windows drive's as `C:/…`). A session's tool list is built from facts known at once (the folder is read only at a call), so a listing hides only a tool that is blocked whatever folder the chat works in; every call decides again with the folder, so a rule changed mid-session holds from the next call (B6), and a call whose folder couldn't be read (session/chatProject.cjs answers null), where a project rule might apply, asks. "Always allow" is offered only when no rule decided, and writes a rule for that one tool of that server, for the chat's harness and project (only in a chat whose folder is known), so it never outranks a rule meant for another harness and never reaches another project.
const path = require('node:path');
const { fs } = require('../platform/ports/fs.cjs');
const { decideStance, exactPattern } = require('../../shared/toolRules.mjs');
const { noteIgnored } = require('../ignored.cjs');

/**
 * @typedef {{ connector: string, tool: string, readOnly: boolean }} ToolRef connector: the server's key; tool: its own name
 * @typedef {{ harness: string | null, fullAccess: boolean, worktreeOf?: string | null }} ChatFacts worktreeOf: the project a managed worktree belongs to
 * @typedef {ReturnType<typeof decideStance> & { project: string | null, harness: string | null }} Decision project: the folder "Always allow" is for
 */

/**
 * A folder as rules compare it: its real path (symlinks resolved, the file system's own case), or as written when it
 * can't be resolved (gone, not reachable), with `/` separators (a Windows drive's `C:\\work` is `C:/work`).
 * @param {string} dir @param {{ platform?: string, realpath?: (p: string) => string }} [o]
 */
function realFolder(dir, { platform = process.platform, realpath = (p) => fs.realpathSync.native(p) } = {}) {
  const resolve = platform === 'win32' ? path.win32.resolve : path.posix.resolve;
  let real;
  try {
    real = realpath(dir);
  } catch {
    real = resolve(dir);
  }
  // Windows: `/` separators and an upper-case drive letter (a network share's `\\\\server\\share` is `//server/share`)
  return platform === 'win32' ? real.replace(/\\/g, '/').replace(/^([a-z]):/, (_m, l) => `${l.toUpperCase()}:`) : real;
}

/**
 * A rule's scope as the gateway keeps it: a project's absolute folder as its real path (realFolder), whoever typed it
 * and however (`c:\\Work\\App`, a symlink, a trailing `/`); any other scope as it is (shared/toolRules.mjs ruleOf then checks it).
 * @param {unknown} scope @param {{ platform?: string, realpath?: (p: string) => string }} [o]
 */
function canonicalScope(scope, o = {}) {
  if (typeof scope !== 'string' || !scope.startsWith('project:')) return scope;
  const dir = scope.slice('project:'.length);
  const absolute = (o.platform ?? process.platform) === 'win32' ? path.win32.isAbsolute(dir) : path.posix.isAbsolute(dir);
  return absolute ? `project:${realFolder(dir, o)}` : scope;
}

class GatewayPolicy {
  /**
   * @param {{ rules: { view(): import('./rules.cjs').RulesView, add(rule: unknown): Promise<unknown> },
   *   chatOf: (chatId: string) => ChatFacts | null, projectOf: (chatId: string) => Promise<string | null>, folderOf?: typeof realFolder }} o
   *   rules.add: the gateway's, so every window hears a rule "Always allow" wrote; chatOf: the chat's harness kind, whether
   *   it runs with Full access, and the project its worktree belongs to
   */
  constructor({ rules, chatOf, projectOf, folderOf = realFolder }) {
    this.rules = rules;
    this.chatOf = chatOf;
    this.projectOf = projectOf;
    this.folderOf = folderOf;
  }

  /** @param {ChatFacts | null} chat @param {ToolRef} t @param {string | null | undefined} folder */
  #decide(chat, t, folder) {
    const v = this.rules.view();
    return decideStance({
      rules: v.rules,
      connector: t.connector,
      tool: t.tool,
      readOnly: t.readOnly,
      harness: chat?.harness ?? null,
      project: folder,
      // a chat main can't read the mode of is not Full access
      fullAccess: chat?.fullAccess === true,
      unreadable: v.state === 'unreadable',
    });
  }

  /** Whether a listing for the chat leaves the tool out: blocked whatever folder the chat works in. */
  hides(/** @type {string} */ chatId, /** @type {ToolRef} */ t) {
    const d = this.#decide(this.chatOf(chatId), t, undefined);
    return d.stance === 'block' && d.certain;
  }

  /**
   * The stance for one call, with the chat's folders read now. A folder that can't be read leaves a project rule that
   * might apply undecided: the call asks (a block still holds). @returns {Promise<Decision>}
   */
  async decide(/** @type {string} */ chatId, /** @type {ToolRef} */ t) {
    const chat = this.chatOf(chatId);
    const harness = chat?.harness ?? null;
    /** @type {string | null | undefined} undefined: not known (chatProject answers null for a folder it couldn't read) */
    let folder;
    if (chat?.worktreeOf) folder = this.folderOf(chat.worktreeOf);
    else {
      try {
        const cwd = await this.projectOf(chatId);
        folder = cwd ? this.folderOf(cwd) : undefined;
      } catch (error) {
        noteIgnored('read a chat’s folder for the gateway’s rules', error);
        folder = undefined;
      }
    }
    const d = this.#decide(chat, t, folder);
    const project = folder ?? null;
    if (!d.certain && d.stance !== 'block') return { ...d, stance: 'ask', why: /** @type {any} */ ('folder'), project, harness };
    return { ...d, project, harness };
  }

  /**
   * "Always allow": a rule allowing this one tool of this server for the chat's harness in its project. @param {ToolRef} t @param {Decision} d
   */
  async alwaysAllow(t, d) {
    // the store adds nothing when the same rule is there already (decided under its lock: two cards at once keep one)
    await this.rules.add({
      connector: t.connector,
      pattern: exactPattern(t.tool),
      stance: 'allow',
      // offered only for a chat whose folder is known (offer.cjs)
      scope: `project:${d.project}`,
      // offered only for a chat whose harness is known (offer.cjs): the rule names it
      harness: /** @type {string} */ (d.harness),
    });
  }
}

/** The stances before any rule (C2's): a tool the server says only reads runs, any other asks; nothing is hidden. */
const BASELINE = Object.freeze({
  hides: () => false,
  decide: async (/** @type {string} */ _chatId, /** @type {ToolRef} */ t) =>
    /** @type {Decision} */ ({
      stance: t.readOnly ? 'allow' : 'ask',
      rule: null,
      certain: true,
      why: t.readOnly ? 'read-only' : 'default',
      project: null,
      harness: null,
    }),
  alwaysAllow: null,
});

module.exports = { GatewayPolicy, BASELINE, realFolder, canonicalScope };
