// The background desktop_app_* tools' escalation ladder: when to retry an action with the app briefly in front, what to remember per app, and the notes the model reads.
const { ownTable } = require('../../../shared/ownTable.mjs');
const P = require('../contract/desktopPolicy.cjs');

/** The actions the brief-foreground rung may retry: input an app can ignore while it is in the background, a file panel's Go to Folder, and a menu item the app keeps disabled until it is active. */
const FOREGROUND_ACTIONS = new Set(['click', 'type', 'key', 'file_panel', 'menu']);

/** What each retried action is called in the one-line note ("TextEdit needs brief foreground for typing"). */
const WHAT = ownTable({ click: 'clicks', type: 'typing', key: 'keys', file_panel: 'Go to Folder', menu: 'menu commands' });

/** Window states the helper refuses posted input in, as its unsupported(<reason>) names them. */
const WINDOW_STATE_RE = /^unsupported\((minimized|app_hidden|off_space)\)/;

/**
 * Who answers the ladder's questions: the user's setting and the per-app memory (the grant store), or
 * nothing (no escalation, nothing remembered).
 * @typedef {{ allowed(): boolean, rung(bundleId: string, action: string): string,
 *   remember(app: {bundleId: string, name: string}, action: string, rung: string): boolean }} Ladder
 */
/** @type {Ladder} */
const NO_LADDER = {
  allowed: () => false,
  rung: () => 'background',
  remember: () => false,
};

/** Whether an action may go up to the brief-foreground rung: the setting is on, the app is granted full control, and the action is one an app ignores in the background. */
function mayForeground(ladder, app, action) {
  return FOREGROUND_ACTIONS.has(action) && P.tierRank(app.tier) >= P.tierRank('full') && ladder.allowed();
}

/** Whether a background result calls for the next rung: the helper saw nothing change, or the app refused the write. */
function needsEscalation(record) {
  return record?.effect === 'no_change' || record?.effect === 'ineffective';
}

/** Whether the brief-foreground attempt did what the background one couldn't (an unverifiable delivery counts: the app was in front). */
function foregroundWorked(record) {
  return record?.effect === 'confirmed' || record?.effect === 'unverifiable';
}

/** The window state named by a helper refusal for posted input (minimized, app_hidden, off_space), or null. */
function windowStateRefusal(err) {
  const m = WINDOW_STATE_RE.exec(String(err?.message ?? ''));
  return m ? m[1] : null;
}

/** The one-line note for an app that needs the brief-foreground rung for an action (`fg`: the helper's account of it). */
function foregroundNote(appName, action, fg) {
  const after = fg?.userTookOver ? '' : ', then the previous app and pointer were restored';
  return `${appName} needs brief foreground for ${WHAT[action] ?? action}: it was brought to the front for this action${after}.`;
}

/**
 * The record of a ladder attempt: which rung succeeded, what the rung before it reported, and the note.
 * `fg` is the helper's account of the brief foreground ({userTookOver}).
 */
function laddered(record, rung, o = {}) {
  const out = { ...record, rung };
  if (o.from) out.background_effect = o.from;
  if (o.note) out.ladder = o.note;
  if (o.fg?.userTookOver)
    out.ladder = `${out.ladder ? `${out.ladder} ` : ''}The user used the mouse or keyboard meanwhile, so the previous app and pointer were left as they are.`;
  return out;
}

module.exports = {
  FOREGROUND_ACTIONS,
  NO_LADDER,
  mayForeground,
  needsEscalation,
  foregroundWorked,
  windowStateRefusal,
  foregroundNote,
  laddered,
};
