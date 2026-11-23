// A Claude chat's own pick (its model, effort and login) as main keeps it from the windows' pushes (harness/claude/adapter.cjs setOwn), and moving the login before a turn when the pick is held back.
const { noteIgnored } = require('../../ignored.cjs');

const str = (/** @type {unknown} */ v) => (typeof v === 'string' && v ? v : null);

/**
 * `own` over what the chat had: a field it names replaces (null clears), a field it leaves out stays. A window that hasn't
 * read the chat's model yet (a reload) sends only its login, so the chat keeps its model (#2304).
 * @param {{ model: string | null, effort: string | null, account: string | null } | undefined} was
 * @param {Record<string, unknown>} own
 */
function mergeOwn(was, own) {
  const pick = (/** @type {'model' | 'effort' | 'account'} */ k) => (k in own ? str(own[k]) : (was?.[k] ?? null));
  return { model: pick('model'), effort: pick('effort'), account: pick('account') };
}

/** A known model receipt or explicit clear can change auto-mode support on the chat's current live native process. */
function setClaudeOwn(adapter, chatId, own) {
  if (typeof chatId !== 'string' || !chatId) return false;
  const permission = adapter.settings(chatId, {}).permission;
  let changed;
  if (!own || typeof own !== 'object') changed = adapter.own.delete(chatId);
  else {
    adapter.own.set(chatId, mergeOwn(adapter.own.get(chatId), own));
    changed = true;
  }
  if (changed && permission !== adapter.settings(chatId, {}).permission)
    adapter.permissionChanged(chatId).catch((error) => noteIgnored('apply the chat model permission capability', error));
  return changed;
}

/**
 * Before a turn: when the login the chat runs on is held back (a limit seen, a lapse marked), the chat moves to the
 * login of its lane with the most left and keeps that pick, so the next turns stay there rather than following the
 * figures back and forth. With nowhere to go the turn runs on its pick and reports the limit itself (limited).
 * @param {any} adapter the ClaudeAdapter, with its switch policy (adapter.policy: identity/contract/switch.cjs, which a harness is not
 *   to import)
 * @param {string} chatId
 * @param {string} key the chat's native session
 */
function claudePreflight(adapter, chatId, key) {
  const { decideClaudeSwitch, claudeLoginFor } = adapter.policy;
  const now = adapter.clock();
  const view = adapter.api.accounts();
  const account = adapter.accountOf(chatId);
  if (claudeLoginFor(adapter.pickOf(chatId), view, adapter.marks, now) === account) return;
  const d = decideClaudeSwitch({
    account,
    reason: adapter.marks.get(account)?.expired ? 'expired' : 'limit',
    view,
    marks: adapter.marks.snapshot(),
    now,
    recent: adapter.recent.get(chatId) ?? [],
    ephemeral: !!adapter.sessions.get(key)?.ephemeral,
    keyMode: !!adapter.api.keyMode?.(),
  });
  adapter.recent.set(chatId, d.recent);
  if (d.action === 'switch') applyClaudeSwitch(adapter, chatId, key, account, d, now);
}

/**
 * The chat's pick becomes the login decideClaudeSwitch chose, and windows are told, with the note, where it went.
 * @param {any} adapter the ClaudeAdapter
 * @param {string} chatId
 * @param {string} key
 * @param {string} account the login the chat leaves
 * @param {{ to?: string, note?: string }} d a 'switch' decision
 * @param {number} now ms
 */
function applyClaudeSwitch(adapter, chatId, key, account, d, now) {
  const own = adapter.own.get(chatId);
  adapter.own.set(chatId, { model: own?.model ?? null, effort: own?.effort ?? null, account: /** @type {string} */ (d.to) });
  const note = {
    id: `account-${now}`,
    kind: 'account',
    text: /** @type {string} */ (d.note),
    turnId: adapter.lastTurn.get(chatId) ?? null,
    turn: 0,
    at: now,
  };
  try {
    adapter.moved(chatId, { account: d.to, note });
  } catch (error) {
    // a listener error must not stop the accountSwitched event below
    noteIgnored("record a Claude Code chat's new login", error);
  }
  adapter.emit({ kind: 'accountSwitched', key, chatId, from: account, to: d.to, note });
}

module.exports = { mergeOwn, setClaudeOwn, claudePreflight, applyClaudeSwitch };
