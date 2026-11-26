// MoMo phone fixtures: the design's own example data (Studio, Dana Lee, the Acme quote) as a PhoneView and an in-memory transport the home lane replaces.
import type { MomoView } from '../../../shared/momoView';
import type { Intent, IntentResult, MomoTransport, PhoneView } from './types';

const at = (h: number, m: number, d = 24) => new Date(2026, 10, d, h, m).getTime();
const NOW = at(14, 20);

export function fixtureShared(): MomoView {
  return {
    home: {
      state: 'running',
      homeMachineId: 'studio',
      leaseEpoch: 1,
      machineName: 'Studio',
      stateSince: at(8, 0),
      lastSeenAt: NOW,
      movedAway: null,
      move: null,
      update: null,
      agentProblem: null,
      machines: [
        {
          machineId: 'studio',
          name: 'Studio',
          isThisDevice: false,
          isHome: true,
          status: 'online',
          note: 'Keeps running when your Mac sleeps',
          recommended: true,
          agentsSignedIn: ['Claude Code', 'Codex'],
        },
        {
          machineId: 'mac',
          name: 'This Mac',
          isThisDevice: true,
          isHome: false,
          status: 'online',
          note: 'Stops when the lid closes',
          recommended: false,
          agentsSignedIn: ['Claude Code'],
        },
        {
          machineId: 'mini',
          name: 'Mac mini',
          isThisDevice: false,
          isHome: false,
          status: 'needs-update',
          note: null,
          recommended: false,
          agentsSignedIn: [],
        },
        {
          machineId: 'cloud',
          name: 'Cloud machine',
          isThisDevice: false,
          isHome: false,
          status: 'not-set-up',
          note: 'Wakes when MoMo has work, stops when idle',
          recommended: false,
          agentsSignedIn: [],
        },
      ],
      sources: [
        { id: 'gmail', account: 'du@example.com', access: 'read-only', status: 'ok', progress: null },
        { id: 'calendar', account: 'du@example.com', access: 'read-only', status: 'ok', progress: null },
      ],
    },
    setup: { step: 'done', google: 'connected', notifications: 'allowed' },
    chat: [
      {
        kind: 'assistant',
        id: 'a1',
        at: at(13, 5),
        text: 'The quote sheet is ready. Want me to attach it to Dana’s reply?',
        source: null,
        whyTold: 'Dana Lee replied on \u201cAcme renewal\u201d and asked about the price.',
        notNeeded: { suggestion: null },
        decision: {
          id: 'd1',
          outcome: 'tell_now',
          reason: 'Dana Lee replied on \u201cAcme renewal\u201d and asked about the price.',
          kind: 'Client replies',
          rule: { id: 'r1', text: 'Client replies \u2192 tell me right away' },
          checks: ['Sender matches Acme \u00b7 passes the sender check'],
          matter: { key: 'acme-renewal', title: 'Acme renewal', first: true },
          at: at(13, 4),
        },
      },
      { kind: 'user', id: 'u1', at: at(13, 6), text: 'Yes, attach it and show me the reply.', delivery: 'accepted' },
      {
        kind: 'approval',
        id: 'k1',
        at: at(14, 14),
        approval: {
          id: 'c1',
          action: 'send-email',
          title: 'Send this email?',
          recipients: [{ name: 'Dana Lee', address: 'dana@acme.com', outsideCompany: true }],
          subject: 'Re: Acme renewal',
          attachments: ['Acme-quote.xlsx'],
          body: 'Hi Dana, the $48k price holds for a Dec 1 start. The quote is attached.',
          fields: [],
          expiresAt: null,
          status: 'pending',
          answeredElsewhere: null,
          failure: null,
          canAskAgain: false,
          editable: true,
        },
      },
    ],
    tasks: [
      {
        id: 't1',
        title: 'Build the Acme quote sheet',
        doneMeans: 'Sheet has 200 seats at $48k and opens without errors',
        state: 'working',
        where: { machine: { machineId: 'mini', name: 'Mac mini' }, agent: 'Codex' },
        origin: 'asked',
        attempts: 1,
        attemptCap: 3,
        startedAt: at(14, 14),
        step: 'Filling the pricing table',
        nextCheck: null,
        failure: null,
        result: null,
      },
      {
        id: 't2',
        title: 'AWS invoice · due today',
        doneMeans: 'Invoice mail from AWS, due today',
        state: 'watching',
        where: { machine: { machineId: 'studio', name: 'Studio' }, agent: 'Claude Code' },
        origin: 'matter',
        attempts: 1,
        attemptCap: 3,
        startedAt: at(9, 0),
        step: 'Invoice mail from AWS, due today',
        nextCheck: at(16, 0),
        failure: null,
        result: null,
        watch: { why: 'Invoice mail from AWS, due today', nextCheck: at(16, 0), told: false, toldAt: null, decision: null },
      },
    ],
    notes: [
      {
        id: 'n1',
        title: 'Acme',
        kind: 'company',
        updatedAt: at(8, 0),
        lastChange: null,
        lines: [
          {
            id: 'l1',
            text: 'Renewal in progress. $48k for 200 seats, price holds for a Dec 1 start.',
            at: at(8, 0),
            status: 'learned',
            quote: 'the $48k price holds if we start Dec 1',
            sources: [
              { id: 's1', kind: 'mail', label: 'Gmail · Re: Acme renewal', at: at(8, 0), gone: false },
              { id: 's2', kind: 'event', label: 'Calendar · Acme sync', at: at(9, 0, 11), gone: false },
            ],
          },
        ],
        history: [
          { id: 'h1', at: at(2, 0), summary: 'Summary rewritten after the price was confirmed', undoable: true },
          { id: 'h2', at: at(9, 0, 18), summary: 'Added: Dana needs the revised quote by Friday', undoable: false },
        ],
      },
    ],
    rules: [
      {
        id: 'r1',
        text: 'Delivery notices → stay quiet',
        kind: 'quieter',
        effect: 'stay_quiet',
        origin: 'learned',
        state: 'on',
        appliesTo: 'Delivery notices from shops and carriers',
        evidence: [{ at: at(9, 0, 5), reaction: 'Not needed', item: 'Your Uniqlo package arrives tomorrow' }],
        useCount: 7,
        inBrief: true,
      },
    ],
    signals: [],
    settings: { brief: { on: true, time: '08:00' }, quietHours: { from: '22:00', to: '08:00' }, dailyCap: 6, previews: false },
    problems: [],
  };
}

export function fixtureView(over: Partial<PhoneView> = {}): PhoneView {
  return { now: NOW, view: fixtureShared(), waking: false, ...over };
}

/** An in-memory home: answers every intent with the next view, so the screens can be driven before the real home exists. */
export function createFixtureTransport(start: PhoneView = fixtureView()): MomoTransport & {
  view(): PhoneView;
  fail(result: IntentResult | null): void;
  emit(patch: Partial<PhoneView>): void;
} {
  let current = start;
  let failNext: IntentResult | null = null;
  const listeners = new Set<(patch: Partial<PhoneView>) => void>();
  return {
    view: () => current,
    /** A push from the home: the view changes and every subscriber is told. */
    emit(patch) {
      current = { ...current, ...patch };
      for (const l of [...listeners]) l(patch);
    },
    fail(result) {
      failNext = result;
    },
    async load() {
      return current;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async send(intent: Intent): Promise<IntentResult> {
      if (failNext) {
        const r = failNext;
        failNext = null;
        return r;
      }
      const patch = next(current, intent);
      current = { ...current, ...patch };
      return { ok: true, view: patch };
    },
  };
}

const withView = (p: PhoneView, f: (v: MomoView) => Partial<MomoView>): Partial<PhoneView> => ({ view: { ...p.view, ...f(p.view) } });

function next(p: PhoneView, intent: Intent): Partial<PhoneView> {
  switch (intent.kind) {
    case 'wake':
      return { waking: false, ...withView(p, (v) => ({ home: { ...v.home, state: 'running' } })) };
    case 'move':
      return withView(p, (v) => ({
        home: {
          ...v.home,
          state: 'moving',
          move: {
            moveId: 'mv1',
            from: { machineId: v.home.homeMachineId ?? '', name: v.home.machineName ?? '' },
            to: { machineId: intent.toId, name: v.home.machines.find((m) => m.machineId === intent.toId)?.name ?? intent.toId },
            step: 'paused',
            outcome: 'running',
            finishedAt: null,
            failure: null,
            oldMachineOffline: false,
          },
        },
      }));
    case 'move-cancel':
    case 'move-stay':
    case 'reclaim':
    case 'move-ack':
      return withView(p, (v) => ({ home: { ...v.home, state: 'running', move: null } }));
    case 'choose-home':
      return withView(p, (v) => ({
        setup: { ...v.setup, step: 'read' },
        home: {
          ...v.home,
          homeMachineId: intent.machineId,
          machineName: v.home.machines.find((m) => m.machineId === intent.machineId)?.name ?? v.home.machineName,
          machines: v.home.machines.map((m) => ({ ...m, isHome: m.machineId === intent.machineId })),
        },
      }));
    case 'approval': {
      const status = intent.answer === 'send' ? 'completed' : intent.answer === 'deny' ? 'denied' : 'pending';
      return withView(p, (v) => ({
        chat: v.chat.map((r) =>
          r.kind === 'approval' && r.approval.id === intent.cardId ? { ...r, approval: { ...r.approval, status } } : r,
        ),
      }));
    }
    case 'notice-not-needed':
      return withView(p, (v) => ({
        chat: v.chat.map((r) =>
          r.kind === 'assistant' && r.id === intent.noticeId
            ? { ...r, notNeeded: { suggestion: { ruleId: 'r1', text: 'Second time. I will stay quiet about deliveries.' } } }
            : r,
        ),
      }));
    case 'rule-undo':
      return withView(p, (v) => ({ rules: v.rules.map((r) => (r.id === intent.ruleId ? { ...r, state: 'undone' } : r)) }));
    case 'rule-set':
      return withView(p, (v) => ({ rules: v.rules.map((r) => (r.id === intent.ruleId ? { ...r, state: intent.on ? 'on' : 'off' } : r)) }));
    case 'task-stop':
    case 'task-stop-watching':
      return withView(p, (v) => ({ tasks: v.tasks.map((t) => (t.id === intent.taskId ? { ...t, state: 'stopped' } : t)) }));
    case 'prefs':
      return withView(p, (v) => ({
        settings: {
          brief: { on: intent.patch.brief ?? v.settings.brief.on, time: intent.patch.briefTime ?? v.settings.brief.time },
          quietHours: { from: intent.patch.quietFrom ?? v.settings.quietHours.from, to: intent.patch.quietTo ?? v.settings.quietHours.to },
          dailyCap: intent.patch.dailyCap ?? v.settings.dailyCap,
          previews: intent.patch.previews ?? v.settings.previews,
        },
        setup: { ...v.setup, notifications: intent.patch.notifications ?? v.setup.notifications },
      }));
    case 'note-edit':
      return withView(p, (v) => ({
        notes: v.notes.map((n) =>
          n.id === intent.noteId
            ? { ...n, lines: n.lines.map((l) => (l.id === intent.lineId ? { ...l, text: intent.text, status: 'confirmed' } : l)) }
            : n,
        ),
      }));
    case 'note-create':
      return withView(p, (v) => ({
        notes: [
          ...v.notes,
          {
            id: `n${v.notes.length + 1}`,
            title: intent.title,
            kind: 'topic',
            updatedAt: p.now,
            lastChange: null,
            lines: [{ id: 'l1', text: intent.text, at: p.now, status: 'confirmed', quote: null, sources: [] }],
            history: [],
          },
        ],
      }));
    case 'note-forget':
      return withView(p, (v) => ({
        notes: v.notes.flatMap((n) => {
          if (n.id !== intent.noteId) return [n];
          const lines = n.lines.filter((l) => l.id !== intent.lineId);
          return lines.length ? [{ ...n, lines }] : [];
        }),
      }));
    default:
      return {};
  }
}
