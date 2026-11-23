// What a MoMo chat's composer may run (#2279): Feedback alone, as the reference agent app's "/" menu; every other
// command is the coding side's (a project, plan mode, a model or harness MoMo's brain doesn't name), so a new command
// stays out of MoMo unless it is added here. Read by the composer (menu and typed commands) and main (session:patch).

/** The "/" menu entries a MoMo chat shows, by entry id (a basic harness's are `acp:<name>`). */
export const MOMO_MENU = Object.freeze(['feedback']);

/** The commands a MoMo chat runs when typed: Feedback and its /bug alias. */
export const MOMO_COMMANDS = Object.freeze(['feedback', 'bug']);

/** Whether a MoMo chat's "/" menu shows the entry with this id. */
export function momoShowsEntry(id) {
  return MOMO_MENU.includes(String(id).replace(/^acp:/, ''));
}

/** Whether a MoMo chat runs one of these command names (a command and its aliases) when typed. */
export function momoRunsCommand(names) {
  return names.some((n) => MOMO_COMMANDS.includes(n));
}

/** Whether a MoMo chat sends this typed text as it is: a "/name" that isn't one of its commands goes out as plain text. */
export function momoTypedAsText(text) {
  const m = /^\/([\w-]+)(?:\s|$)/.exec(String(text).trim());
  return !!m && !momoRunsCommand([m[1]]);
}

/**
 * The part of a window's session patch a MoMo chat takes: never plan mode on or a goal set (coding features), though
 * either may be cleared (a chat that had one before it was MoMo's); and never its permission or a pending harness
 * switch, set or cleared: only MoMo's brain change sets those, in main (electron/momo/mainChat.cjs reconcile, which
 * writes the session state directly, never through a window's patch).
 * @param {Record<string, unknown>} partial
 */
export function momoSessionPatch(partial) {
  const out = { ...partial };
  if (out.plan === true) delete out.plan;
  if ('goal' in out && out.goal != null) delete out.goal;
  delete out.permission;
  delete out.pendingSwitch;
  return out;
}

/**
 * The "/" menu a chat shows: all of `items`, or MoMo's entries alone in a MoMo chat.
 * @template {{ id: string }} T
 * @param {boolean} momo
 * @param {T[]} items
 */
export function momoMenu(momo, items) {
  return momo ? items.filter((it) => momoShowsEntry(it.id)) : items;
}

/** The names a typed command may run by in a chat: all of `names`, or MoMo's commands alone in a MoMo chat. */
export function momoNames(momo, names) {
  return momo ? names.filter((n) => MOMO_COMMANDS.includes(n)) : names;
}

/**
 * U+200B, put ahead of a MoMo chat's text that starts with "/" or "!" on its way to the harness: invisible, and no
 * harness trims it, so the text no longer starts with a command. Claude Code runs a message as its own command when
 * it (or its last text block) starts with "/" (CLI 2.1.311: `startsWith("/")`, untrimmed); an ACP agent runs its
 * advertised commands the same way.
 */
export const LITERAL_MARK = '​';

/** A MoMo chat's text as the harness should read it: plain text, never one of the harness's commands. */
export function momoLiteralText(text) {
  return typeof text === 'string' && /^[/!]/.test(text) ? LITERAL_MARK + text : text;
}
