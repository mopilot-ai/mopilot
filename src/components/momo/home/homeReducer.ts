// What each user move does to MoMo's view while no home answers: the fixture seam's brain, pure so a screen's result can be checked without a Host.
import {
  MOMO_MOVE_STEPS,
  MOMO_SETUP_STEPS,
  type MomoApprovalView,
  type MomoQuestionView,
  type MomoHomeView,
  type MomoNoteView,
  type MomoRuleView,
  type MomoTaskView,
  type MomoView,
} from '../../../../shared/momoView';
import type { MomoHomeAction } from './homeActions';

const withTask = (v: MomoView, id: string, f: (t: MomoTaskView) => MomoTaskView): MomoView => ({
  ...v,
  tasks: v.tasks.map((t) => (t.id === id ? f(t) : t)),
});
const withRule = (v: MomoView, id: string, f: (r: MomoRuleView) => MomoRuleView): MomoView => ({
  ...v,
  rules: v.rules.map((r) => (r.id === id ? f(r) : r)),
});
const withNote = (v: MomoView, id: string, f: (n: MomoNoteView) => MomoNoteView): MomoView => ({
  ...v,
  notes: v.notes.map((n) => (n.id === id ? f(n) : n)),
});
const withHome = (v: MomoView, f: (h: MomoHomeView) => Partial<MomoHomeView>): MomoView => ({ ...v, home: { ...v.home, ...f(v.home) } });
const withApproval = (v: MomoView, id: string, f: (a: MomoApprovalView) => MomoApprovalView): MomoView => ({
  ...v,
  chat: v.chat.map((r) => (r.kind === 'approval' && r.approval.id === id ? { ...r, approval: f(r.approval) } : r)),
});
const withQuestion = (v: MomoView, id: string, f: (q: MomoQuestionView) => MomoQuestionView): MomoView => ({
  ...v,
  chat: v.chat.map((r) => (r.kind === 'question' && r.question.id === id ? { ...r, question: f(r.question) } : r)),
});
const refOf = (v: MomoView, machineId: string) => ({
  machineId,
  name: v.home.machines.find((m) => m.machineId === machineId)?.name ?? machineId,
});

/** The scripted home's own step: a move goes on to its next step, and past the last one the target is home. */
export function advanceMove(v: MomoView, now: number): MomoView {
  return withHome(v, (h) => {
    const m = h.move;
    if (!m || m.failure) return {};
    const next = MOMO_MOVE_STEPS[(MOMO_MOVE_STEPS as readonly string[]).indexOf(m.step) + 1];
    if (next) return { move: { ...m, step: next } };
    // the last step is done: the target is home now, and an old machine that is offline still holds a copy
    const offline = h.machines.find((x) => x.machineId === m.from.machineId)?.status === 'offline';
    return {
      state: 'running',
      stateSince: now,
      homeMachineId: m.to.machineId,
      leaseEpoch: (h.leaseEpoch ?? 0) + 1,
      machineName: m.to.name,
      move: offline ? { ...m, outcome: 'moved', finishedAt: now, oldMachineOffline: true } : null,
      machines: h.machines.map((x) => ({ ...x, isHome: x.machineId === m.to.machineId })),
    };
  });
}

export function failMove(v: MomoView, cause: string, now: number): MomoView {
  return withHome(v, (h) => ({
    move: h.move ? { ...h.move, outcome: 'failed', finishedAt: now, failure: { cause: cause, failedAt: h.move.step } } : null,
  }));
}

/** Applies one move to the view; `now` stamps what the move creates. */
export function reduceHome(v: MomoView, a: MomoHomeAction, now: number): MomoView {
  switch (a.type) {
    case 'setup.choose': {
      const chosen = withHome(v, (h) => ({
        machines: h.machines.map((m) => ({ ...m, isHome: m.machineId === a.machineId })),
        homeMachineId: a.machineId,
        leaseEpoch: 1,
        machineName: refOf(v, a.machineId).name,
      }));
      return { ...chosen, setup: { ...chosen.setup, step: 'read' } };
    }
    case 'setup.open':
      return { ...v, setup: { ...v.setup, step: 'read', google: 'idle' } };
    case 'setup.next': {
      const i = (MOMO_SETUP_STEPS as readonly string[]).indexOf(v.setup.step);
      return { ...v, setup: { ...v.setup, step: MOMO_SETUP_STEPS[i + 1] ?? 'done' } };
    }
    case 'setup.google':
      return { ...v, setup: { ...v.setup, google: a.to } };
    case 'setup.notifications':
      // allowing them is the last step; saying no stays on the screen that says what that means
      return { ...v, setup: { ...v.setup, notifications: a.to, ...(a.to === 'allowed' ? { step: 'done' } : {}) } };
    case 'move.start':
      return withHome(v, (h) => ({
        state: 'moving',
        stateSince: now,
        move: {
          moveId: `move-${now}`,
          from: { machineId: h.homeMachineId ?? '', name: h.machineName ?? '' },
          to: refOf(v, a.machineId),
          step: MOMO_MOVE_STEPS[0],
          outcome: 'running',
          finishedAt: null,
          failure: null,
          oldMachineOffline: false,
        },
      }));
    case 'home.reclaim':
      // the owner takes the home back at a higher lease: whatever copy the target holds is refused from then on
      return withHome(v, (h) => ({
        state: 'running',
        stateSince: now,
        homeMachineId: h.move?.from.machineId ?? h.homeMachineId,
        machineName: h.move?.from.name ?? h.machineName,
        leaseEpoch: (h.leaseEpoch ?? 0) + 1,
        move: null,
        machines: h.machines.map((m) => ({ ...m, isHome: m.machineId === (h.move?.from.machineId ?? h.homeMachineId) })),
      }));
    case 'move.cancel':
    case 'move.stay':
    case 'move.dismiss':
      return withHome(v, () => ({ state: 'running', stateSince: now, move: null }));
    case 'move.retry':
      return withHome(v, (h) => ({
        move: h.move ? { ...h.move, step: MOMO_MOVE_STEPS[0], outcome: 'running', finishedAt: null, failure: null } : null,
      }));
    case 'home.wake':
    case 'home.useOtherAgent':
      return withHome(v, () => ({ state: 'running', stateSince: now, agentProblem: null }));
    case 'machine.setUp':
    case 'machine.update':
      return withHome(v, (h) => ({
        machines: h.machines.map((m) => (m.machineId === a.machineId ? { ...m, status: 'online', note: null } : m)),
        // the home itself was the one out of date: it takes work again
        ...(h.state === 'needs-update' && h.homeMachineId === a.machineId ? { state: 'running', stateSince: now, update: null } : {}),
      }));
    case 'chat.send':
      return {
        ...v,
        chat: [
          ...v.chat,
          { kind: 'user', id: a.turnId, at: now, text: a.text, delivery: v.home.state === 'asleep' ? 'queued' : 'accepted' },
        ],
      };
    case 'chat.check':
      return { ...v, chat: v.chat.map((r) => (r.kind === 'user' && r.id === a.rowId ? { ...r, delivery: 'accepted' } : r)) };
    case 'brief.hide':
      return {
        ...v,
        chat: v.chat.map((r) =>
          r.kind === 'brief' ? { ...r, brief: { ...r.brief, offers: r.brief.offers.filter((o) => o.id !== a.offerId) } } : r,
        ),
      };
    case 'brief.start':
      return reduceHome(
        reduceHome(v, { type: 'brief.hide', offerId: a.offerId }, now),
        { type: 'chat.send', turnId: `brief-${now}`, text: 'Yes, go ahead.' },
        now,
      );
    case 'question.answer':
      return withQuestion(v, a.id, (q) => ({ ...q, status: 'answered', answer: { optionId: a.optionId, device: 'this Mac', at: now } }));
    case 'approval.send':
      return withApproval(v, a.id, (c) => ({ ...c, status: 'completed' }));
    case 'approval.edit':
      return withApproval(v, a.id, (c) => ({ ...c, body: a.body }));
    case 'approval.deny':
      return withApproval(v, a.id, (c) => ({ ...c, status: 'denied', canAskAgain: true }));
    case 'approval.askAgain':
      return withApproval(v, a.id, (c) => ({
        ...c,
        status: 'pending',
        expiresAt: null,
        answeredElsewhere: null,
        failure: null,
        canAskAgain: false,
        editable: true,
      }));
    case 'row.notNeeded':
      // the second "Not needed" on a kind proposes the rule that keeps it quiet (it starts on, with Undo)
      return {
        ...v,
        chat: v.chat.map((r) =>
          r.kind === 'assistant' && r.id === a.rowId && r.notNeeded
            ? { ...r, notNeeded: { suggestion: { ruleId: 'r-deliveries', text: 'Second time. I will stay quiet about deliveries.' } } }
            : r,
        ),
      };
    case 'task.stop':
      return withTask(v, a.id, (t) => ({ ...t, state: 'stopped', step: null }));
    case 'task.retry':
      return withTask(v, a.id, (t) => ({ ...t, state: 'working', failure: null, step: 'Starting again' }));
    case 'task.runElsewhere':
      return withTask(v, a.id, (t) => ({
        ...t,
        state: 'working',
        failure: null,
        step: 'Starting again',
        where: { ...t.where, machine: refOf(v, a.machineId) },
      }));
    case 'task.act':
      // a result's action belongs to its task: the scripted home has no task to change, the real home answers it
      return v;
    case 'fix.run': {
      // a fix is addressed by its id alone: whatever offered it is cleared (the home's own answer replaces this one)
      const agent = v.home.agentProblem;
      const solved = agent?.fix.id === a.id;
      return {
        ...v,
        problems: v.problems.filter((p) => p.fix.id !== a.id),
        home: { ...v.home, ...(solved ? { agentProblem: null, state: 'running', stateSince: now } : {}) },
        tasks: v.tasks.map((t) => (t.failure?.fix?.id === a.id ? { ...t, state: 'working', failure: null, step: 'Starting again' } : t)),
      };
    }
    case 'task.stopWatching':
      return { ...v, tasks: v.tasks.filter((t) => t.id !== a.id) };
    case 'note.edit':
      return withNote(v, a.noteId, (n) => ({
        ...n,
        updatedAt: now,
        lines: n.lines.map((l) => (l.id === a.lineId ? { ...l, text: a.text, status: 'confirmed', at: now } : l)),
      }));
    case 'note.undo':
      return withNote(v, a.noteId, (n) => ({
        ...n,
        lastChange: n.lastChange?.id === a.changeId ? null : n.lastChange,
        history: n.history.filter((c) => c.id !== a.changeId),
      }));
    case 'note.restore':
      return withNote(v, a.noteId, (n) => ({ ...n, lastChange: null, history: n.history.filter((c) => c.id !== n.lastChange?.id) }));
    case 'note.forget':
      return { ...v, notes: v.notes.filter((n) => n.id !== a.noteId) };
    case 'note.write':
      return {
        ...v,
        notes: [
          ...v.notes,
          {
            id: `n-${now}`,
            title: a.title,
            kind: 'topic',
            updatedAt: now,
            lastChange: null,
            history: [],
            lines: [{ id: `l-${now}`, text: a.text, at: now, status: 'confirmed', quote: a.text, sources: [] }],
          },
        ],
      };
    case 'source.reconnect':
      return withHome(v, (h) => ({ sources: h.sources.map((s) => (s.id === a.id ? { ...s, status: 'ok' } : s)) }));
    case 'source.remove':
      return withHome(v, (h) => ({ sources: h.sources.filter((s) => s.id !== a.id) }));
    case 'rule.add':
      return {
        ...v,
        rules: [
          ...v.rules,
          {
            id: `r-${now}`,
            text: a.text,
            kind: a.effect === 'stay_quiet' ? 'quieter' : 'does-more',
            effect: a.effect,
            origin: 'yours',
            state: 'on',
            appliesTo: a.text,
            evidence: [],
            useCount: 0,
            inBrief: false,
          },
        ],
      };
    case 'rule.edit':
      // an edit makes the rule the user's: automatic passes never change it again
      return withRule(v, a.id, (r) => ({
        ...r,
        text: a.text,
        effect: a.effect,
        inBrief: a.inBrief,
        origin: 'yours',
        kind: a.effect === 'stay_quiet' ? 'quieter' : 'does-more',
      }));
    case 'rule.undo':
      return {
        ...withRule(v, a.id, (r) => ({ ...r, state: 'undone' })),
        chat: v.chat.map((r) => (r.kind === 'assistant' && r.notNeeded?.suggestion?.ruleId === a.id ? { ...r, notNeeded: null } : r)),
      };
    case 'rule.turnOff':
      return withRule(v, a.id, (r) => ({ ...r, state: 'off' }));
    case 'rule.accept':
      return withRule(v, a.id, (r) => ({ ...r, state: 'on' }));
    case 'signal.make': {
      const sig = v.signals.find((s) => s.id === a.id);
      const rest = { ...v, signals: v.signals.filter((s) => s.id !== a.id) };
      return sig ? reduceHome(rest, { type: 'rule.add', text: 'Newsletters → morning brief', effect: 'stay_quiet' }, now) : rest;
    }
    case 'signal.ignore':
      return { ...v, signals: v.signals.filter((s) => s.id !== a.id) };
    case 'intent':
      // a raw intent (a fix the home refused with) has no effect on a scripted view
      return v;
    case 'settings.set': {
      const p = a.patch;
      const s = v.settings;
      return {
        ...v,
        settings: {
          brief: { on: p.briefOn ?? s.brief.on, time: p.briefTime ?? s.brief.time },
          quietHours: { from: p.quietFrom ?? s.quietHours.from, to: p.quietTo ?? s.quietHours.to },
          dailyCap: p.dailyCap ?? s.dailyCap,
          previews: p.previews ?? s.previews,
        },
      };
    }
  }
}
