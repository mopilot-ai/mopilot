// What a client picks for a new chat beyond its harness and folder: the login it runs on and a worktree of its project, checked before a chat is made, and the chat started on its harness family (app/chromePanel.cjs start).
const { parseKind } = require('../../shared/harnessKind.mjs');
const { noteIgnored } = require('../ignored.cjs');

/** A new chat on each harness family, in `cwd` (ChatStarter); `basic` names the basic harness. */
const START = {
  claude: (/** @type {any} */ s, /** @type {string} */ cwd, /** @type {string} */ _basic, /** @type {string | null} */ of) =>
    s.startClaude(cwd, of),
  codex: (/** @type {any} */ s, /** @type {string} */ cwd, /** @type {string} */ _basic, /** @type {string | null} */ of) =>
    s.startCodex(cwd, of),
  acp: (/** @type {any} */ s, /** @type {string} */ cwd, /** @type {string} */ basic, /** @type {string | null} */ of) =>
    s.startAcp(basic, cwd, of),
};

/** The families whose logins a new chat can pick; the others have no account menu. */
const PICKABLE = new Set(['claude', 'codex']);

/**
 * The logins of a family as the account menu shows them, signed-out ones included (`loggedIn` false), from the identity
 * registry that owns them. Empty for a family without logins to pick from.
 * @param {any} live
 * @param {string} family
 * @returns {{ id: string, label: string, loggedIn: boolean, limited: boolean }[]}
 */
function loginsOf(live, family) {
  if (!PICKABLE.has(family)) return [];
  const rows = live.identity?.instances?.(family) ?? [];
  return rows.map((/** @type {any} */ i) => ({
    id: i.account,
    label: i.label ?? i.account,
    loggedIn: i.status === 'ok',
    limited: i.limited === true,
  }));
}

/** How each family puts a new chat on its login once the chat exists (Claude: the chat's own pick; Codex: the pool's per-thread pin). */
const PIN = {
  claude: (/** @type {any} */ live, /** @type {string} */ chatId, /** @type {string} */ account) =>
    live.claudeTurns.setOwn(chatId, { account }),
  codex: (/** @type {any} */ live, /** @type {string} */ chatId, /** @type {string} */ account) => {
    try {
      live.accounts.pinChat(chatId, account);
    } catch (error) {
      // the chat exists by now: it runs on the pool's choice rather than being half-made
      noteIgnored('pin a new Codex chat to its login', error);
    }
  },
};

/** What a family checks before a chat is made on a login, beyond the login itself; a throw is the refusal the person reads. */
const BEFORE = {
  // the relay moves a chat only to a login billed the way the one in use is (accounts/providers.cjs inChatLane)
  codex: (/** @type {any} */ live, /** @type {string} */ account) => {
    const login = live.accounts?.get?.(account);
    if (login && live.accounts.inChatLane?.(null, login) === false)
      throw new Error("That account is billed differently from the one in use, so a chat can't start on it.");
  },
};

/**
 * The picks checked and ready: the folder (a fresh worktree of the project when asked), and what to apply to the chat once it exists.
 * Throws a message safe to show; nothing is made when it does, except the worktree, which the caller discards if the chat then fails.
 * @param {object} o
 * @param {any} o.live main's late-bound services (claudeTurns: the Claude Code logins)
 * @param {any} o.starts the ChatStarter
 * @param {string} o.harness
 * @param {{ path: unknown } | null} o.project
 * @param {string | undefined} o.account a login id
 * @param {boolean | undefined} o.worktree
 */
async function shapeStart({ live, starts, harness, project, account, worktree }) {
  const kind = /** @type {{ family: 'codex' | 'claude' | 'acp', basic: string | null }} */ (parseKind(harness));
  if (account !== undefined) {
    // only a harness with logins to pick from has this menu; for any other it is absent, not faked
    if (!loginsOf(live, kind.family).some((a) => a.id === account && a.loggedIn))
      throw new Error("That account isn't available for this harness.");
    // refused before a chat exists, in words, rather than a chat that quietly runs on another login
    if (!live.identity?.driver(kind.family)?.perChat) throw new Error("That agent can't put a chat on its own account now.");
    BEFORE[/** @type {'codex'} */ (kind.family)]?.(live, account);
  }
  let cwd = project ? String(project.path) : null;
  if (worktree) {
    if (!project) throw new Error('Pick a project to start in a worktree.');
    const made = await starts.newWorktree(String(project.path), { what: 'a remote chat' });
    if (!made || 'unsupported' in made) throw new Error("A worktree can't be made for that project.");
    cwd = made.path;
  }
  return {
    kind,
    cwd,
    worktreeOf: worktree ? String(project?.path) : null,
    apply: (/** @type {string} */ chatId) => {
      if (account !== undefined) PIN[/** @type {'claude' | 'codex'} */ (kind.family)](live, chatId, account);
    },
  };
}

/** Makes the chat; a worktree made for it that it never got is removed (a clean one only). */
async function startChat(
  /** @type {any} */ starts,
  /** @type {{ kind: any, worktreeOf: string | null, apply: (chatId: string) => void }} */ { kind, worktreeOf, apply },
  /** @type {string} */ cwd,
) {
  try {
    const chatId = await START[/** @type {'claude' | 'codex' | 'acp'} */ (kind.family)](starts, cwd, kind.basic ?? '', worktreeOf);
    apply(chatId);
    return chatId;
  } catch (error) {
    // never rejects: the starter reports a worktree it keeps instead
    if (worktreeOf) await starts.discardWorktree(cwd);
    throw error;
  }
}

module.exports = { shapeStart, startChat, loginsOf };
