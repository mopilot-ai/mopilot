// MoMo's settings in prefs.momo (#2139): what each key may hold, the settings read back with their defaults, and one
// key's change merged into the rest. Main writes through it (electron/app/ipc/momoPrefs.cjs), so a change never drops one
// another window or MoMo's main chat made; the renderer reads with it (src/session/momoPrefs.ts). MoMo has one brain
// (prefs.momo.brain.main, #2527): every kind of work runs on it, under one at-limit rule (prefs.momo.atLimit). The brain
// belongs to MoMo's main chat service and is never set here; Reset clears it with the rest. migrateMomoPrefs folds the
// per-role settings older builds saved into that one brain and rule.
// Proactivity and quiet hours are kept under prefs.momo.routines, where MoMo's routines read them.
import { isJsonRecord } from './jsonRecord.mjs';
import { isHarnessKind } from './defaultHarness.mjs';

/** How often MoMo reaches out. */
export const MOMO_PROACTIVITY = ['off', 'low', 'default', 'high'];
/**
 * Per proactivity level, the routine runs a day; Off runs nothing. The one table MoMo's routines enforce and Settings
 * describes, so the two always agree.
 */
export const MOMO_PROACTIVITY_LIMITS = Object.freeze({
  off: Object.freeze({ runs: 0 }),
  low: Object.freeze({ runs: 2 }),
  default: Object.freeze({ runs: 6 }),
  high: Object.freeze({ runs: 12 }),
});
/** What MoMo does when its brain's account reaches a limit. */
export const MOMO_AT_LIMIT = ['nextAccount', 'pause', 'skip'];
/** How MoMo talks; kept in MoMo's persona (memory's persona file), not here (src/components/momo/setup/personaStyle.ts). */
export const MOMO_STYLES = ['concise', 'warm', 'detailed'];
/** The starter routines setup suggests; picked ones wait in routines.starter for MoMo's routines. 'morningFeed' is the id older builds saved for the morning briefing; it stays so a saved pick still reads. */
export const MOMO_STARTER_ROUTINES = ['morningFeed', 'weekAhead', 'bills'];
/** The ones setup proposes now: not 'morningFeed', which the Morning brief (A7) replaces so nobody gets two morning notes; one an account already has stays as it was. */
export const MOMO_SETUP_STARTERS = ['weekAhead', 'bills'];
/** MoMo's colors (the sidebar dot, the avatar, setup's big dot): the ids saved in persona.color, drawn by src/components/momo/momoColors.ts. */
export const MOMO_COLORS = ['clay', 'blue', 'green', 'violet', 'ink'];
/** Setup's steps are screens of the window (#2607); the one step an older build saved is read as the start. */
export const MOMO_SETUP_STEPS = 1;
const NAME_MAX = 40;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Every setting's value when nothing (or nothing valid) is saved. */
export const MOMO_DEFAULTS = Object.freeze({
  atLimit: 'nextAccount',
  routines: Object.freeze({
    proactivity: 'default',
    /** null: no quiet hours */
    quietHours: Object.freeze({ start: '22:00', end: '07:00' }),
    starter: Object.freeze([]),
  }),
  /** `pushBody`: a phone's push may name the user's own routine (shared/momoNotices.mjs); a Mac-only setting, never one a phone sets */
  notify: Object.freeze({ needsAnswer: true, pushBody: false }),
  /** a paired phone changes MoMo's brain only when the user allowed it here */
  remote: Object.freeze({ brainChange: false }),
  paused: false,
  /** the four-tab Tasks panel (M0a), on for the owners trying it: `momo.tasksPanel`. Its page works alone; its button is the shell's */
  tasksPanel: false,
  /** the morning brief (A7, Mac only), off by default: `momo.brief` */
  brief: false,
  /** MoMo's suggestions (A7: Up next's rows, `momo_suggest`), Mac-only and off until an owner turns it on, whatever the Tasks panel is: `momo.suggestions`. Its rows are drawn in the Tasks panel (`tasksPanel`) */
  suggestions: false,
  /** channels and groups (A2), on for the owners trying them: `momo.channels`. Draws only inside the shell: it needs `shell` (MoMo's design §10.1) */
  channels: false,
  /** MoMo's page shell (M0b: its own rail, the panel buttons, whole-bubble replies), Mac-only and off until an owner turns it on: `momo.shell` */
  shell: false,
  /** the shell's Sessions pane (M6: the home's other chats with their attention words), Mac-only and off until an owner turns it on: `momo.sessions`. Draws only inside the shell: it needs `shell` */
  sessions: false,
  /** the Sessions pane's first control: the pane lists the other chats. On, since the list is the user's own view of their chats */
  sessionsShow: true,
  /** the Sessions pane's second control: MoMo may read the other chats and answer their cards. Off until the user allows it */
  sessionsAct: false,
  persona: Object.freeze({ name: 'MoMo', color: 'clay' }),
  onboarding: Object.freeze({ done: false, step: 0 }),
});

const oneOf = (/** @type {readonly string[]} */ list) => (/** @type {unknown} */ v) =>
  typeof v === 'string' && list.includes(v) ? v : undefined;
const bool = (/** @type {unknown} */ v) => (typeof v === 'boolean' ? v : undefined);
const clock = (/** @type {unknown} */ v) => (typeof v === 'string' && CLOCK.test(v) ? v : undefined);
const text = (/** @type {unknown} */ v) => (typeof v === 'string' || v === null ? v : undefined);

/** A brain as saved: a harness with its account and model (null: the harness's own) and the effort when it names one, or null. */
function brain(/** @type {unknown} */ v) {
  if (v === null) return null;
  if (!isJsonRecord(v) || !isHarnessKind(v.harness)) return undefined;
  const account = text(v.account ?? null);
  const model = text(v.model ?? null);
  const modelLabel = text(v.modelLabel ?? null);
  if (account === undefined || model === undefined || modelLabel === undefined) return undefined;
  // its effort goes with it (a routine's run follows it, electron/momo/brainEffort.cjs checks it)
  const effort = typeof v.effort === 'string' && v.effort ? { effort: v.effort } : {};
  return { harness: v.harness, account, model, modelLabel, ...effort };
}
/** Quiet hours from start to end (past midnight when end is earlier), or null for none. */
function quietHours(/** @type {unknown} */ v) {
  if (v === null) return null;
  if (!isJsonRecord(v)) return undefined;
  const start = clock(v.start);
  const end = clock(v.end);
  return !start || !end || start === end ? undefined : { start, end };
}
/** MoMo's name: 1-40 characters once trimmed. */
function personaName(/** @type {unknown} */ v) {
  const name = typeof v === 'string' ? v.trim() : '';
  return !name || name.length > NAME_MAX ? undefined : name;
}
function onboarding(/** @type {unknown} */ v) {
  if (!isJsonRecord(v)) return undefined;
  const done = bool(v.done);
  const step = v.step;
  if (done === undefined || !Number.isInteger(step) || Number(step) < 0) return undefined;
  // setup is one screen: a later step an older build saved reads as the start, and done stays done
  return { done, step: Math.min(Number(step), MOMO_SETUP_STEPS - 1) };
}
function starterRoutines(/** @type {unknown} */ v) {
  if (!Array.isArray(v) || !v.every((x) => MOMO_STARTER_ROUTINES.includes(x))) return undefined;
  return [...new Set(v)];
}

/** Each key a window may set, with what it may hold (undefined: not that). */
const KEYS = {
  atLimit: oneOf(MOMO_AT_LIMIT),
  'routines.proactivity': oneOf(MOMO_PROACTIVITY),
  'routines.quietHours': quietHours,
  'routines.starter': starterRoutines,
  'notify.needsAnswer': bool,
  'notify.pushBody': bool,
  'remote.brainChange': bool,
  paused: bool,
  tasksPanel: bool,
  brief: bool,
  suggestions: bool,
  channels: bool,
  shell: bool,
  sessions: bool,
  sessionsShow: bool,
  sessionsAct: bool,
  // the name MoMo is shown by; how it talks lives in its persona, in memory
  'persona.name': personaName,
  'persona.color': oneOf(MOMO_COLORS),
  onboarding,
};

/** The at-limit rule as saved: the one rule, or (an older build, before migrateMomoPrefs ran) the main chat's. */
function savedAtLimit(/** @type {unknown} */ momo) {
  const v = at(momo, 'atLimit');
  return oneOf(MOMO_AT_LIMIT)(isJsonRecord(v) ? v.main : v);
}

/** The value saved at a dotted key of prefs.momo, or undefined. */
function at(/** @type {unknown} */ momo, /** @type {string} */ key) {
  let v = momo;
  for (const part of key.split('.')) v = isJsonRecord(v) ? v[part] : undefined;
  return v;
}

/**
 * MoMo's settings as saved, each one that is missing or not valid at its default. The main chat's brain is left to its
 * service and is not part of it.
 * @param {unknown} momo prefs.momo
 */
export function readMomoPrefs(momo) {
  const pick = (/** @type {string} */ key, /** @type {unknown} */ fallback) => {
    const v = key === 'atLimit' ? savedAtLimit(momo) : KEYS[key](at(momo, key));
    return v === undefined ? fallback : v;
  };
  const d = MOMO_DEFAULTS;
  return {
    atLimit: pick('atLimit', d.atLimit),
    routines: {
      proactivity: pick('routines.proactivity', d.routines.proactivity),
      quietHours: pick('routines.quietHours', { ...d.routines.quietHours }),
      starter: pick('routines.starter', []),
    },
    notify: { needsAnswer: pick('notify.needsAnswer', d.notify.needsAnswer), pushBody: pick('notify.pushBody', d.notify.pushBody) },
    remote: { brainChange: pick('remote.brainChange', d.remote.brainChange) },
    paused: pick('paused', d.paused),
    tasksPanel: pick('tasksPanel', d.tasksPanel),
    brief: pick('brief', d.brief),
    suggestions: pick('suggestions', d.suggestions),
    channels: pick('channels', d.channels),
    shell: pick('shell', d.shell),
    sessions: pick('sessions', d.sessions),
    sessionsShow: pick('sessionsShow', d.sessionsShow),
    sessionsAct: pick('sessionsAct', d.sessionsAct),
    persona: { name: pick('persona.name', d.persona.name), color: pick('persona.color', d.persona.color) },
    onboarding: pick('onboarding', { ...d.onboarding }),
  };
}

/**
 * prefs.momo with one key set and everything else (the main chat's brain included) as it was, or why not.
 * @param {unknown} momo prefs.momo as saved now
 * @param {unknown} key
 * @param {unknown} value
 * @returns {{ ok: true, momo: Record<string, unknown> } | { ok: false, error: string }}
 */
export function setMomoPref(momo, key, value) {
  if (typeof key !== 'string' || !Object.hasOwn(KEYS, key)) return { ok: false, error: `Not a MoMo setting: ${String(key)}` };
  const v = KEYS[key](value);
  if (v === undefined) return { ok: false, error: `Not a valid value for ${key}.` };
  const root = isJsonRecord(momo) ? { ...momo } : {};
  const [head, leaf] = key.split('.');
  if (leaf === undefined) root[head] = v;
  else root[head] = { ...(isJsonRecord(root[head]) ? root[head] : {}), [leaf]: v };
  return { ok: true, momo: root };
}

/**
 * What a role does at a limit: its choice, except that with no other account to move to (a harness with one sign-in,
 * or one account in the brain's billing lane) Next account pauses. Settings shows this and the role's service acts on
 * it, so the two agree.
 * @param {string} saved the role's choice (readMomoPrefs().atLimit[role])
 * @param {boolean} noOtherAccount the role's brain has no other account to move to
 */
export const effectiveAtLimit = (saved, noOtherAccount) => (noOtherAccount && saved === 'nextAccount' ? 'pause' : saved);

/** The brain per-role settings of an older build saved, in the order the main chat's brain is looked for. */
const LEGACY_BRAINS = ['topics', 'routines', 'quickAsk'];

/** MoMo's brain: the main chat's, else (nothing picked yet, an older build) the first per-role brain it saved. */
function momoBrain(/** @type {unknown} */ momo) {
  const main = brain(at(momo, 'brain.main'));
  if (main) return main;
  for (const role of LEGACY_BRAINS) {
    const b = brain(at(momo, `brain.${role}`));
    if (b) return b;
  }
  return null;
}

/**
 * The brain MoMo's work runs on: the one brain, for every kind of work (main chat, routines, Quick ask);
 * null before it has one. One resolver for Settings, setup and every service, so all of them agree.
 * @param {unknown} momo prefs.momo
 */
export function roleBrain(momo) {
  return momoBrain(momo);
}

/**
 * prefs.momo with the per-role settings older builds saved folded into the one brain and rule (#2527), or null when it
 * is already so. The main chat's brain and rule stay as they are; the other roles' are dropped. A user with only a
 * per-role brain keeps it as the brain (never left with none).
 * @param {unknown} momo prefs.momo as saved now
 */
export function migrateMomoPrefs(momo) {
  if (!isJsonRecord(momo)) return null;
  const legacyBrain = isJsonRecord(momo.brain) && LEGACY_BRAINS.some((r) => Object.hasOwn(momo.brain, r));
  const legacyLimit = isJsonRecord(momo.atLimit);
  if (!legacyBrain && !legacyLimit) return null;
  const next = { ...momo };
  if (legacyBrain) {
    const main = momoBrain(momo);
    const { main: _m, topics: _t, routines: _r, quickAsk: _q, ...rest } = /** @type {Record<string, unknown>} */ (momo.brain);
    next.brain = main ? { ...rest, main } : rest;
  }
  if (legacyLimit) {
    const rule = savedAtLimit(momo);
    delete next.atLimit;
    if (rule) next.atLimit = rule;
  }
  return next;
}

/** Whether MoMo is paused: routines and background reads wait until it is resumed. */
export const isMomoPaused = (/** @type {unknown} */ momo) => at(momo, 'paused') === true;

/**
 * prefs.momo after Reset MoMo: every setting at its default, the main chat's brain too (#2291). Reset deletes the main
 * chat that brain was for, and setup asks for a brain again; nothing is kept from before.
 */
export const resetMomoPrefs = () => ({});
