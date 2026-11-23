// MoMo's Calendar and Reminders through the macOS helper's EventKit commands (native/helper/Sources/ComputerUseHelper/EventKit.swift, protocol `eventKit` 2 in its hello): reads, plus create/complete/delete writes since protocol 2, and only after the user grants macOS access, which eventkit.request asks for. A helper that predates the commands, or none at all (not macOS), reads as unavailable; macOS's refusal as not_granted.
const { SourceError } = require('./hub.cjs');

/**
 * @typedef {'granted'|'denied'|'restricted'|'writeOnly'|'notDetermined'|'unavailable'} Grant
 * @typedef {{ call(method: string, params?: object, opts?: { timeoutMs?: number }): Promise<any>, fix?: string,
 *   offlineStatus?: (kind: 'eventkit') => Promise<any>, release?: () => 'stopped' | 'none' | 'busy',
 *   resetGrant?: (entity: 'calendar' | 'reminders') => Promise<boolean> }} Helper
 *   the computer-use helper's client (electron/capabilities/computer.cjs ComputerHelper)
 */

/** How long a connect waits for the user to answer macOS's prompt, which stays up until they do. */
const REQUEST_WAIT = 10 * 60 * 1000;
/** How long a write waits for the helper. */
const WRITE_WAIT = 20_000;

/** A helper failure as a SourceError: macOS's refusal, an outdated or missing helper, or a failed read. */
function sourceError(/** @type {any} */ e) {
  if (e instanceof SourceError) return e;
  const reason = e?.reason;
  if (reason === 'not_granted') return new SourceError(String(e.message), 'not_granted');
  if (reason === 'method_not_found')
    return new SourceError(`The macOS helper is too old to read Calendar and Reminders; ${e.fix || 'update MoPilot'}`, 'unavailable');
  if (reason === 'helper_unavailable') return new SourceError(`Calendar and Reminders can't be read here: ${e.message}`, 'unavailable');
  return new SourceError(`Calendar or Reminders couldn't be read: ${String(e?.message ?? e)}`, 'failed');
}

/**
 * A helper failure of a write: what the helper answered with a reason is known not to have written (a SourceError); a
 * timeout or a crash may have, so it goes up unchanged and the gate counts it as uncertain.
 */
function writeError(/** @type {any} */ e) {
  const reason = e?.reason;
  if (reason === 'changed' || reason === 'gone') return new SourceError(String(e.message), 'changed');
  if (reason === 'read_only') return new SourceError(String(e.message), 'read_only');
  if (reason === 'not_found' || reason === 'bad_args' || reason === 'invalid_params') return new SourceError(String(e.message), 'bad_args');
  if (reason === 'not_granted' || reason === 'method_not_found' || reason === 'helper_unavailable') return sourceError(e);
  return e;
}

/** @param {Helper | null} helper */
function createEventKit(helper) {
  const call = async (/** @type {string} */ method, /** @type {object} */ params = {}, /** @type {object} */ opts = {}) => {
    if (!helper) throw new SourceError('Calendar and Reminders are read through macOS, which this computer is not', 'unavailable');
    try {
      return await helper.call(method, params, opts);
    } catch (e) {
      throw sourceError(e);
    }
  };
  const write = async (/** @type {string} */ method, /** @type {object} */ params) => {
    if (!helper) throw new SourceError('Calendar and Reminders are written through macOS, which this computer is not', 'unavailable');
    try {
      return await helper.call(method, params, { timeoutMs: WRITE_WAIT });
    } catch (e) {
      throw writeError(e);
    }
  };
  /** @returns {Promise<{ calendar: Grant, reminders: Grant }>} */
  /** `fresh`: read by a helper launched for the read, which sees a grant made since the helper started (a running one does not). */
  const status = async (/** @type {{ fresh?: boolean }} */ { fresh = false } = {}) => {
    try {
      const s = fresh && helper?.offlineStatus ? await helper.offlineStatus('eventkit') : await call('eventkit.status');
      return { calendar: s.calendar, reminders: s.reminders };
    } catch (e) {
      if (e instanceof SourceError && e.code === 'unavailable') return { calendar: 'unavailable', reminders: 'unavailable' };
      throw e;
    }
  };
  return {
    status,
    /** Quits the helper while System Settings is open on a privacy list (it asks a running app to Quit & Reopen): 'stopped', 'none' (not running) or 'busy' (working: left running). */
    release: () => helper?.release?.() ?? 'none',
    /**
     * Shows macOS's prompt the first time and waits for the user's answer (up to REQUEST_WAIT); answers like status, plus
     * `asked`: true when this call showed the prompt (a helper that predates the field never did, as far as main knows).
     */
    request: async (/** @type {'calendar'|'reminders'} */ entity) => {
      const s = await call('eventkit.request', { entity }, { timeoutMs: REQUEST_WAIT });
      // what the helper saw of the request itself (EventKit's answer, its error, how long it took): kept for what the user is told
      return {
        calendar: s.calendar,
        reminders: s.reminders,
        asked: s.asked === true,
        ...(typeof s.granted === 'boolean' && { granted: s.granted }),
        ...(typeof s.requestError === 'string' && { requestError: s.requestError }),
        ...(typeof s.requestMs === 'number' && { requestMs: s.requestMs }),
      };
    },
    /** Clears macOS's record of this helper's `entity` answer (tccutil), so the next request is asked afresh: false when it could not. */
    resetGrant: async (/** @type {'calendar'|'reminders'} */ entity) => (helper?.resetGrant ? await helper.resetGrant(entity) : false),
    /** @returns {Promise<{ id: string, title: string, account: string }[]>} */
    calendars: async () => (await call('calendar.calendars')).items,
    /** @returns {Promise<{ id: string, title: string, account: string }[]>} */
    lists: async () => (await call('reminders.lists')).items,
    /** @param {{ start: number, end: number, ids?: string[], limit?: number }} q */
    events: (q) => call('calendar.events', q),
    /** @param {{ ids?: string[], completedSince?: number, limit?: number }} q */
    reminders: (q) => call('reminders.items', q),
    // writes (#2139 P5): each answers `{ id }` of the item, or says by a reason that nothing was written
    /** @param {{ title: string, start: number, end: number, allDay: boolean, calendarId?: string, location?: string }} p @returns {Promise<{ id: string, calendar: string }>} */
    createEvent: (p) => write('calendar.create', p),
    /** @param {{ title: string, due?: number, dueAllDay?: boolean, listId?: string }} p @returns {Promise<{ id: string, list: string }>} */
    createReminder: (p) => write('reminders.create', p),
    /** One reminder by id, for the card that asks to complete it. @returns {Promise<{ id: string, title: string, list: string, done: boolean }>} */
    reminder: (/** @type {string} */ id) => write('reminders.get', { id }),
    /** @param {{ id: string, done: boolean, expect: { title: string } }} p */
    setReminderDone: (p) => write('reminders.complete', p),
    /** Deletes the event only if it still has the title and start in `expect`. @param {{ id: string, expect: { title: string, start: number } }} p */
    deleteEvent: (p) => write('calendar.delete', p),
    /** @param {{ id: string, expect: { title: string } }} p */
    deleteReminder: (p) => write('reminders.delete', p),
  };
}

/** Most rows a tool asks for unless the model says otherwise, and the most it may ask for (the helper's own cap). */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const limitOf = (/** @type {unknown} */ n) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), MAX_LIMIT) : DEFAULT_LIMIT;

/**
 * Connects an EventKit source once macOS grants access (asking first when it never was): `{ connected, grant }`, plus
 * `asked: true` when macOS's prompt was shown by this call (so a refusal was the user's answer just now).
 * A disconnect or connect while macOS's prompt was up voids this one (hub.connect's epoch).
 * @param {InstanceType<typeof import('./hub.cjs').SourcesHub>} hub
 * @param {ReturnType<typeof createEventKit>} eventKit
 * @param {'calendar'|'reminders'} id
 */
async function connectWithGrant(hub, eventKit, id) {
  // nothing to connect (MoMo not allowed, no encryption): macOS's prompt isn't shown for it
  hub.assertCanConnect();
  const epoch = hub.epoch(id);
  let answer = await eventKit.request(id);
  // A request that asked leaves no answer behind only when macOS never showed its prompt (the user's answer is granted or
  // denied; a prompt waits for it). Clear macOS's record of this helper once and ask again: a stale record is the cause that
  // clearing fixes. Never in a loop, and never for a refusal the user gave.
  let reset = false;
  if (silent(answer, id) && (await eventKit.resetGrant(id))) {
    reset = true;
    answer = await eventKit.request(id);
  }
  const grant = answer[id];
  if (grant !== 'granted')
    return {
      connected: false,
      grant,
      ...(answer.asked && { asked: true }),
      ...(silent(answer, id) && { noPrompt: true }),
      ...(reset && { reset: true }),
      ...(silent(answer, id) && answer.requestError && { requestError: answer.requestError }),
    };
  return { connected: hub.connect(id, { epoch }), grant };
}

/** The request asked (the status was notDetermined) and still is: macOS answered without showing its prompt. */
const silent = (/** @type {{ asked?: boolean } & Record<string, any>} */ answer, /** @type {string} */ id) =>
  answer.asked === true && answer[id] === 'notDetermined';

/** macOS's privacy panes for Calendar and Reminders, the only places openPrivacy and a refused connect open. */
const PRIVACY_PANES = Object.freeze({
  calendar: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars',
  reminders: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders',
});
/** The grants macOS never asks about again but the user can still turn on in the pane. */
const SWITCH_GRANTS = new Set(['denied', 'writeOnly']);

/**
 * The ids of the calendars or lists the model named (by title, any case). Any name that matches nothing is a bad
 * argument that names it and lists the titles there are.
 * @param {{ id: string, title: string }[]} all
 * @param {string[]} names
 * @param {string} what 'calendar' | 'list'
 */
function idsByTitle(all, names, what) {
  const want = new Set(names.map((n) => String(n).trim().toLowerCase()));
  // every name must match, or the model would take a calendar it named but that wasn't read for an empty one
  const missing = names.filter((n) => !all.some((c) => c.title.toLowerCase() === String(n).trim().toLowerCase()));
  if (missing.length)
    throw new SourceError(
      `No ${what} named ${missing.join(', ')}; the ${what}s are: ${all.map((c) => c.title).join(', ') || 'none'}`,
      'bad_args',
    );
  return all.filter((c) => want.has(c.title.toLowerCase())).map((c) => c.id);
}

module.exports = {
  createEventKit,
  sourceError,
  connectWithGrant,
  PRIVACY_PANES,
  SWITCH_GRANTS,
  idsByTitle,
  limitOf,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
