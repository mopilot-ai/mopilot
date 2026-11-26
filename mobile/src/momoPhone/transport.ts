// The phone's transport to MoMo's home: the typed home view read and the intents sent over the computer's request channel, each answer checked before a screen sees it.
import type { MomoView } from '../../../shared/momoView';
import { say } from './say';
import { notYet, wireOf } from './wire';
import type { Intent, IntentResult, MomoTransport, PhoneView } from './types';

/** The home lane's methods (names to confirm with it): the whole view, one intent, and the event that says the view changed. */
export const VIEW_METHOD = 'momo.home.view';
export const INTENT_METHOD = 'momo.home.intent';
export const CHANGED_EVENT = 'momo.home.changed';

export type Channel = {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (event: { ev?: string; [key: string]: unknown }) => void): () => void;
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** The most one list of a view is read to: a home that sends more cannot freeze the screen (a chat keeps its newest rows). */
const MAX_LIST = 500;
const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, MAX_LIST) : []);

/** What a part of the view holds before the home has said anything about it: the design's defaults (D1, D2). */
const SETUP = { step: 'done', google: 'idle', notifications: 'unknown' };
const SETTINGS = { brief: { on: true, time: '08:00' }, quietHours: { from: '22:00', to: '08:00' }, dailyCap: 6, previews: false };
const str = (v: unknown) => typeof v === 'string';
const isFix = (f: unknown) => isObject(f) && str(f.id) && str(f.label);

/** The entries of a list that are objects with these text fields, whatever else they carry; one that is not is left out, never thrown on. */
const entries = (v: unknown, ...fields: string[]) =>
  list(v).filter((e): e is Record<string, unknown> => isObject(e) && fields.every((f) => str(e[f])));

/**
 * A chat row of a kind this phone knows, with the parts that kind needs and its lists as lists of drawable entries (an older Host may send a list as a
 * non-list, or an entry without its words: it is read with defaults, so a card is never lost to one bad field); a known kind missing a part is left out
 * (an unknown kind is kept, and drawn as nothing).
 */
function chatRow(row: unknown): unknown[] {
  if (!isObject(row) || !str(row.id) || !str(row.kind)) return [];
  const keep = (ok: boolean, shaped: unknown = row) => (ok ? [shaped] : []);
  switch (row.kind) {
    case 'assistant':
    case 'user':
      return keep(str(row.text));
    case 'waiting':
      return keep(isObject(row.machine) && str(row.machine.name));
    case 'brief': {
      const { brief } = row;
      if (!isObject(brief) || !isObject(brief.overnight)) return [];
      // the kept-quiet lines are those with their words; the rule that kept one is known only as text
      // a brief from a Host that sends no `offers`, or one without its words, still has its card
      const offers = entries(brief.offers, 'id', 'title').map((o) => ({ ...o, why: str(o.why) ? o.why : '' }));
      const keptQuiet = entries(brief.keptQuiet, 'id', 'title', 'label').map((k) => ({ ...k, ruleId: str(k.ruleId) ? k.ruleId : null }));
      return [{ ...row, brief: { ...brief, offers, keptQuiet } }];
    }
    case 'catch-up':
      return keep(isObject(row.catchUp) && isObject(row.catchUp.machine));
    case 'approval':
      return keep(isObject(row.approval) && str(row.approval.id) && Array.isArray(row.approval.recipients));
    case 'question': {
      const { question } = row;
      if (!isObject(question) || !str(question.id) || !Array.isArray(question.options)) return [];
      return [
        {
          ...row,
          question: { ...question, title: str(question.title) ? question.title : '', options: entries(question.options, 'id', 'label') },
        },
      ];
    }
    case 'result': {
      const { result } = row;
      if (!isObject(result) || !str(result.taskId) || !isObject(result.machine)) return [];
      const shaped = {
        ...result,
        files: list(result.files).filter(str),
        actions: entries(result.actions, 'id', 'label'),
        summary: str(result.summary) ? result.summary : '',
        title: str(result.title) ? result.title : '',
      };
      return [{ ...row, result: shaped }];
    }
    case 'watch-changed':
      return keep(isObject(row.watch) && str(row.watch.taskId) && isObject(row.watch.machine));
    case 'draft':
      return keep(isObject(row.draft));
    default:
      return [row];
  }
}

/** A note with its lines and history as lists, each line's sources too. */
function note(n: unknown): unknown[] {
  if (!isObject(n) || !str(n.id)) return [];
  const lines = list(n.lines).flatMap((l) => (isObject(l) && str(l.id) ? [{ quote: null, ...l, sources: list(l.sources) }] : []));
  return [{ ...n, lines, history: list(n.history) }];
}

/** A task with a place to run, even when the home did not say where. */
function task(t: unknown): unknown[] {
  if (!isObject(t) || !str(t.id)) return [];
  const where = isObject(t.where) ? t.where : {};
  const machine = isObject(where.machine) ? where.machine : { machineId: '', name: '' };
  return [
    {
      doneMeans: '',
      step: null,
      nextCheck: null,
      failure: null,
      result: null,
      attempts: 1,
      attemptCap: 3,
      ...t,
      where: { agent: '', ...where, machine },
    },
  ];
}

/** The settings the home sent over the design's defaults, part by part: a home that sends `brief` without a time still has one. */
function mergeSettings(sent: unknown) {
  const s = isObject(sent) ? sent : {};
  return {
    ...SETTINGS,
    ...s,
    brief: { ...SETTINGS.brief, ...(isObject(s.brief) ? s.brief : {}) },
    quietHours: { ...SETTINGS.quietHours, ...(isObject(s.quietHours) ? s.quietHours : {}) },
  };
}

/**
 * `momo.home.view`: the shared view with this phone's own extras. A newer home may send values and rows this phone does not know
 * (an unknown state, a new kind of row), and an older one may leave a part out: both are read, the unknown shown as unknown and
 * the missing as empty. Only a reply with no home, or no state for it, is no view at all.
 */
export function parseHomeView(value: unknown, now: number): PhoneView {
  const v = isObject(value) && isObject(value.view) ? value.view : null;
  const home = v && isObject(v.home) ? v.home : null;
  if (!v || !home || typeof home.state !== 'string') throw new Error(say('couldNotReadMomo'));
  const view = {
    ...v,
    home: {
      move: null,
      movedAway: null,
      update: null,
      agentProblem: null,
      homeMachineId: null,
      ...home,
      // an element that is not what a screen draws from is left out, never handed to the screens
      machines: list(home.machines).flatMap((m) =>
        isObject(m) && str(m.machineId) && str(m.name) ? [{ status: 'offline', ...m, agentsSignedIn: list(m.agentsSignedIn) }] : [],
      ),
      sources: list(home.sources).filter((x) => isObject(x) && str(x.id) && str(x.status)),
    },
    setup: { ...SETUP, ...(isObject(v.setup) ? v.setup : {}) },
    settings: mergeSettings(v.settings),
    chat: (Array.isArray(v.chat) ? v.chat.slice(-MAX_LIST) : []).flatMap(chatRow),
    tasks: list(v.tasks).flatMap(task),
    notes: list(v.notes).flatMap(note),
    rules: list(v.rules).filter((r) => isObject(r) && str(r.id)),
    signals: list(v.signals),
    problems: list(v.problems)
      .filter((p) => isObject(p) && str(p.id) && str(p.cause) && isFix(p.fix))
      // the other ways on (an older MoMo: keep this one, delete the old one): each its own button; one that is not a button is left out
      .map((p) => ({ ...(p as Record<string, unknown>), also: list((p as Record<string, unknown>).also).filter(isFix) })),
  };
  return { now, view: view as unknown as MomoView, waking: false, ...(isObject(value) && value.phoneOwn === true ? { own: true } : {}) };
}

/** The intents a refusal may offer as its one tap: what a home really offers (a fix of the view, wake, try a move or a task again, reclaim). Anything else a home names is not followed. */
const FOLLOWED_FIXES = new Set(['fix', 'google', 'wake', 'move-retry', 'reclaim', 'task-retry', 'retry-held']);
const GOOGLE_FIXES = new Set(['connect', 'reconnect', 'grant-send', 'remove']);

/** The refusal's fix as an intent of the phone, or nothing: a kind that is not on the list, or a `fix` without its id, is never sent on a tap. */
function followedFix(raw: unknown): Intent | undefined {
  if (!isObject(raw) || !str(raw.kind) || !FOLLOWED_FIXES.has(raw.kind)) return undefined;
  if (raw.kind === 'fix') return str(raw.id) ? { kind: 'fix', id: raw.id as string } : undefined;
  // the Google lane's refusals: sign in again, disconnect (its `client` names the app that asked; the phone sends its own)
  if (raw.kind === 'google') return GOOGLE_FIXES.has(raw.intent as string) ? ({ kind: 'google', intent: raw.intent } as Intent) : undefined;
  return raw as unknown as Intent;
}

/** `momo.home.intent`: the home's answer is ok with the new view, or the real cause with a fix the user can tap. */
export function parseIntentResult(value: unknown, now: number): IntentResult {
  if (!isObject(value) || typeof value.ok !== 'boolean') throw new Error(say('couldNotReadAnswer'));
  if (value.ok)
    return {
      ok: true,
      ...(isObject(value.view) ? { view: parseHomeView({ view: value.view }, now) } : {}),
      // the home's status for a turn: anything but an explicit has or missing is "cannot say"
      ...(value.turn === 'has' || value.turn === 'missing' || value.turn === 'unknown' ? { turn: value.turn } : {}),
    };
  const fix = followedFix(value.fix);
  return {
    ok: false,
    cause: typeof value.cause === 'string' && value.cause ? value.cause : say('momoCouldNotDoThat'),
    ...(fix && typeof value.fixLabel === 'string' ? { fix, fixLabel: value.fixLabel } : {}),
  };
}

export function createRuntimeTransport(channel: Channel, now: () => number = Date.now): MomoTransport {
  return {
    async load() {
      return parseHomeView(await channel.request(VIEW_METHOD, {}), now());
    },
    async send(intent) {
      const wire = wireOf(intent);
      if (!wire) return { ok: false, cause: notYet() };
      return parseIntentResult(await channel.request(INTENT_METHOD, { intent: wire }), now());
    },
    subscribe(listener) {
      return channel.onEvent((event) => {
        if (event.ev !== CHANGED_EVENT) return;
        try {
          const { view } = parseHomeView(event, now());
          listener({ view, now: now() });
        } catch {
          // an event that is not a view is ignored; the next load reads it again
        }
      });
    },
  };
}
