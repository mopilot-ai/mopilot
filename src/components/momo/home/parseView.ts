// What the main process says about MoMo's home is untrusted until it is parsed here: the whole view (`momoHome:view`, `momoHome:changed`) and an intent's answer. A part that is missing or malformed degrades to empty, a row without an id is dropped, a value this client does not know is kept as it came (the contract's unions are open), and nothing here throws.
import type { MomoView } from '../../../../shared/momoView';
import type { MomoHomeResult } from './homeActions';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** The records of a list that have an id; anything else in it is dropped. */
const rows = (v: unknown, key = 'id'): Rec[] => (Array.isArray(v) ? v.filter((x): x is Rec => isRec(x) && typeof x[key] === 'string') : []);
const recs = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRec) : []);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const ref = (v: unknown) =>
  isRec(v) && typeof v.machineId === 'string' ? { machineId: v.machineId, name: str(v.name, v.machineId) } : null;
const fix = (v: unknown) => (isRec(v) && typeof v.id === 'string' && typeof v.label === 'string' ? { id: v.id, label: v.label } : null);

/** `T` for the parts the clients draw as-is; the cast is the one place this file trusts the shape of a record's remaining fields. */
const as = <T>(v: unknown) => v as T;

function parseChatRow(r: Rec) {
  if (r.kind === 'approval' && isRec(r.approval)) {
    const a = r.approval;
    return {
      ...r,
      approval: {
        ...a,
        id: str(a.id, str(r.id)),
        title: str(a.title),
        recipients: recs(a.recipients),
        subject: strOrNull(a.subject),
        attachments: strings(a.attachments),
        body: str(a.body),
        fields: recs(a.fields),
        expiresAt: numOrNull(a.expiresAt),
        status: str(a.status, 'unknown'),
        answeredElsewhere: isRec(a.answeredElsewhere) ? a.answeredElsewhere : null,
        failure: isRec(a.failure) ? { cause: str(a.failure.cause), fix: fix(a.failure.fix) } : null,
        canAskAgain: a.canAskAgain === true,
      },
    };
  }
  if (r.kind === 'question' && isRec(r.question)) {
    const q = r.question;
    return {
      ...r,
      question: {
        ...q,
        id: str(q.id, str(r.id)),
        title: str(q.title),
        body: str(q.body),
        options: recs(q.options).filter((o) => typeof o.id === 'string' && typeof o.label === 'string'),
        expiresAt: numOrNull(q.expiresAt),
        status: str(q.status, 'unknown'),
        answer: isRec(q.answer) && typeof q.answer.optionId === 'string' ? q.answer : null,
      },
    };
  }
  if (r.kind === 'result' && isRec(r.result)) {
    const x = r.result;
    return {
      ...r,
      result: {
        ...x,
        taskId: str(x.taskId, str(r.id)),
        title: str(x.title),
        state: str(x.state, 'unknown'),
        summary: str(x.summary),
        files: strings(x.files),
        evidence: str(x.evidence),
        checked: str(x.checked),
        machine: ref(x.machine) ?? { machineId: '', name: '' },
        sessionId: strOrNull(x.sessionId),
        untrusted: true,
        actions: recs(x.actions)
          .map(fix)
          .filter((f) => f !== null),
      },
    };
  }
  if (r.kind === 'watch-changed' && isRec(r.watch)) {
    const w = r.watch;
    return {
      ...r,
      watch: {
        ...w,
        taskId: str(w.taskId, str(r.id)),
        title: str(w.title),
        detail: str(w.detail),
        machine: ref(w.machine) ?? { machineId: '', name: '' },
      },
    };
  }
  if (r.kind === 'brief' && isRec(r.brief)) {
    const b = r.brief;
    return {
      ...r,
      brief: {
        day: str(b.day),
        greeting: str(b.greeting),
        attention: isRec(b.attention) ? { text: str(b.attention.text), source: str(b.attention.source) } : null,
        offers: rows(b.offers),
        overnight: { read: 0, notesUpdated: 0, rulesLearned: 0, ...(isRec(b.overnight) ? b.overnight : {}) },
        leftOut: rows(b.leftOut),
      },
    };
  }
  if (r.kind === 'catch-up' && isRec(r.catchUp)) {
    const c = r.catchUp;
    return {
      ...r,
      catchUp: {
        ...c,
        machine: ref(c.machine) ?? { machineId: '', name: '' },
        from: num(c.from),
        to: num(c.to),
        read: num(c.read),
        needsYou: rows(c.needsYou),
      },
    };
  }
  if (r.kind === 'waiting') return { ...r, machine: ref(r.machine) ?? { machineId: '', name: '' } };
  if (r.kind === 'user') return { ...r, text: str(r.text), delivery: str(r.delivery, 'not-sure') };
  if (r.kind === 'assistant')
    return {
      ...r,
      text: str(r.text),
      source: strOrNull(r.source),
      whyTold: strOrNull(r.whyTold),
      notNeeded: isRec(r.notNeeded) ? r.notNeeded : null,
    };
  return r;
}

function parseTask(t: Rec) {
  const w = isRec(t.where) ? t.where : {};
  const f = isRec(t.failure) ? t.failure : null;
  return {
    ...t,
    title: str(t.title),
    doneMeans: str(t.doneMeans),
    state: str(t.state, 'unknown'),
    where: { machine: ref(w.machine) ?? { machineId: '', name: '' }, agent: str(w.agent) },
    startedAt: num(t.startedAt),
    attempts: num(t.attempts),
    attemptCap: num(t.attemptCap),
    step: strOrNull(t.step),
    nextCheck: numOrNull(t.nextCheck),
    failure: f
      ? { ...f, code: str(f.code, 'unknown'), message: str(f.message), machine: ref(f.machine), agent: strOrNull(f.agent), fix: fix(f.fix) }
      : null,
    result: isRec(t.result) ? { summary: str(t.result.summary), files: strings(t.result.files), evidence: str(t.result.evidence) } : null,
  };
}

function parseNote(n: Rec) {
  return {
    ...n,
    title: str(n.title),
    updatedAt: num(n.updatedAt),
    lastChange: isRec(n.lastChange) ? n.lastChange : null,
    history: rows(n.history),
    lines: rows(n.lines).map((l) => ({
      ...l,
      text: str(l.text),
      at: num(l.at),
      status: str(l.status),
      quote: strOrNull(l.quote),
      sources: rows(l.sources),
    })),
  };
}

function parseHome(h: Rec) {
  return {
    ...h,
    state: str(h.state, 'asleep'),
    homeMachineId: strOrNull(h.homeMachineId),
    leaseEpoch: numOrNull(h.leaseEpoch),
    machineName: strOrNull(h.machineName),
    stateSince: numOrNull(h.stateSince),
    lastSeenAt: numOrNull(h.lastSeenAt),
    movedAway: isRec(h.movedAway) && ref(h.movedAway.machine) ? { machine: ref(h.movedAway.machine), at: num(h.movedAway.at) } : null,
    move: isRec(h.move)
      ? { ...h.move, from: ref(h.move.from), to: ref(h.move.to), failure: isRec(h.move.failure) ? h.move.failure : null }
      : null,
    update: isRec(h.update) ? { have: str(h.update.have), need: str(h.update.need) } : null,
    agentProblem:
      isRec(h.agentProblem) && fix(h.agentProblem.fix)
        ? { ...h.agentProblem, agent: str(h.agentProblem.agent), fix: fix(h.agentProblem.fix) }
        : null,
    machines: rows(h.machines, 'machineId').map((m) => ({
      ...m,
      name: str(m.name, str(m.machineId)),
      agentsSignedIn: strings(m.agentsSignedIn),
      note: strOrNull(m.note),
    })),
    sources: rows(h.sources).map((s) => ({ ...s, account: str(s.account), progress: isRec(s.progress) ? s.progress : null })),
  };
}

/** The whole view, or null when it is not one (no home at all). */
export function parseView(raw: unknown): MomoView | null {
  if (!isRec(raw) || !isRec(raw.home)) return null;
  const setup = isRec(raw.setup) ? raw.setup : {};
  const s = isRec(raw.settings) ? raw.settings : {};
  const brief = isRec(s.brief) ? s.brief : {};
  const quiet = isRec(s.quietHours) ? s.quietHours : {};
  return as<MomoView>({
    home: parseHome(raw.home),
    setup: { step: str(setup.step, 'done'), google: str(setup.google, 'idle'), notifications: str(setup.notifications, 'unknown') },
    chat: rows(raw.chat).map(parseChatRow),
    tasks: rows(raw.tasks).map(parseTask),
    notes: rows(raw.notes).map(parseNote),
    rules: rows(raw.rules).map((r) => ({
      ...r,
      text: str(r.text),
      evidence: recs(r.evidence),
      useCount: num(r.useCount),
      inBrief: r.inBrief === true,
    })),
    signals: rows(raw.signals),
    settings: {
      brief: { on: brief.on !== false, time: str(brief.time, '08:00') },
      quietHours: { from: str(quiet.from, '22:00'), to: str(quiet.to, '08:00') },
      dailyCap: num(s.dailyCap, 6),
      previews: s.previews === true,
    },
    problems: rows(raw.problems)
      .filter((p) => fix(p.fix))
      .map((p) => (Array.isArray(p.also) ? { ...p, also: p.also.filter(fix) } : p)),
  });
}

/** An answer to `momoHome:view` or `momoHome:changed`: the view, or why there is none. */
export function parseViewAnswer(raw: unknown): { ok: true; view: MomoView } | { ok: false; cause: string } {
  if (isRec(raw) && raw.ok === false) return { ok: false, cause: str(raw.cause, 'MoMo’s home isn’t available here yet.') };
  const view = parseView(isRec(raw) ? raw.view : null);
  return view ? { ok: true, view } : { ok: false, cause: 'MoMo’s home didn’t answer.' };
}

/** An answer to `momoHome:intent`: done (with the home's fresh view when it sent one), or the cause and the fix it offers. */
export function parseIntentAnswer(raw: unknown): MomoHomeResult & { view?: MomoView } {
  if (isRec(raw) && raw.ok === true) {
    const view = parseView(raw.view);
    // a line the home wants said beside the result (kept short: it is shown as it came)
    const notice = typeof raw.notice === 'string' && raw.notice.trim() ? { notice: raw.notice.trim().slice(0, 300) } : {};
    return view ? { ok: true, view, ...notice } : { ok: true, ...notice };
  }
  const cause = isRec(raw) ? str(raw.cause, 'MoMo’s home didn’t answer.') : 'MoMo’s home didn’t answer.';
  if (isRec(raw) && typeof raw.fixLabel === 'string' && raw.fix !== undefined)
    return { ok: false, cause, fix: { label: raw.fixLabel, intent: raw.fix } };
  return { ok: false, cause };
}
