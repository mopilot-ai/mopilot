// MoMo's phone view models for home and chat: header pill, banners, delivery rows, Where MoMo runs, the move, the approval card, brief and catch-up cards, over the shared view contract.
import {
  MOMO_MOVE_STEPS,
  momoApprovalStatus,
  momoMoveCancellable,
  type MomoApprovalView,
  type MomoChatRow,
  type MomoMachineView,
  type MomoMoveStep,
} from '../../../shared/momoView';
import { offered } from './ownHome';
import { type Action, agentName, agentOf, clock, type Dot, homeId, homeMachine, homeName } from './common';
import { andList, say, sentences } from './say';
import type { Intent, LocalTurn, PhoneView } from './types';

export { agentName };

/** The chat header pill: "MoMo · Studio" and its state dot; an unknown state is amber, never green. */
export function headerPill(v: PhoneView): { label: string; dot: Dot; hint: string } {
  const home = v.view.home;
  if (home.movedAway) return { label: 'MoMo', dot: 'grey', hint: say('notHere') };
  // no home has been chosen yet: nothing is asleep or running, so the pill says only where to look
  if (!home.homeMachineId) return { label: 'MoMo', dot: 'grey', hint: say('whereShouldMomoLive') };
  const name = homeName(v);
  const label = say('momo', { name });
  switch (home.state) {
    case 'running':
      return { label, dot: 'green', hint: say('runsOn', { name }) };
    case 'asleep':
      return { label, dot: 'amber', hint: say('isAsleep', { name }) };
    case 'moving':
      return { label, dot: 'amber', hint: say('moving') };
    case 'needs-update':
      return { label, dot: 'red', hint: say('outOfDate') };
    case 'needs-sign-in':
      return { label, dot: 'red', hint: say('signedOut') };
    default:
      return { label, dot: 'amber', hint: name };
  }
}

/** The banner under the header when the home cannot work: its words and one-tap fixes. */
export const homeBanner = (v: PhoneView) => {
  const b = bannerOf(v);
  return b && { ...b, actions: offered(v, b.actions) };
};
function bannerOf(v: PhoneView): { title: string; body: string; actions: Action[] } | null {
  const home = v.view.home;
  const name = homeName(v);
  const id = homeId(v);
  if (home.movedAway) {
    const to = home.movedAway.machine;
    return {
      title: say('movedAwayTo', { name: to.name, time: clock(home.movedAway.at) }),
      body: '',
      actions: [{ label: say('open', { name: to.name }), intent: { kind: 'choose-home', machineId: to.machineId }, strong: true }],
    };
  }
  const moveInstead: Action = { label: say('moveMomo'), intent: { kind: 'open-where' } };
  switch (home.state) {
    case 'asleep':
      return {
        title: say('wentToSleepAt', { time: clock(home.stateSince ?? v.now) }),
        body: sentences(say('nothingIsBeingCheckedMailA'), say('nothingIsBeingCheckedMailB')),
        actions: [
          { label: v.waking ? say('waking', { name }) : say('wake', { name }), intent: { kind: 'wake' }, strong: true },
          moveInstead,
        ],
      };
    case 'needs-update':
      return {
        title: say('mopilotOnIsOutOf', { name }),
        body: sentences(say('takesNoNewWork'), say('notesSafe')),
        actions: [{ label: say('update', { name }), intent: { kind: 'update-machine', machineId: id }, strong: true }, moveInstead],
      };
    case 'needs-sign-in': {
      const problem = home.agentProblem ?? { kind: 'signed-out', agent: 'Claude Code', fix: null };
      const agent = agentOf(problem.agent);
      const missing = problem.kind === 'not-installed';
      const codexReady = agent !== 'codex' && !!homeMachine(v)?.agentsSignedIn.some((a) => agentOf(a) === 'codex');
      const label = problem.fix?.label ?? (missing ? say('installOn', { name }) : say('signInOn', { name }));
      return {
        title: missing ? say('isnTInstalledOn', { agent: problem.agent, name }) : say('isSignedOutOn', { agent: problem.agent, name }),
        body: missing ? sentences(say('cantThinkInstalled'), say('stillNotes')) : sentences(say('cantThinkSignedIn'), say('stillNotes')),
        actions: [
          { label, intent: { kind: missing ? 'install-agent' : 'sign-in-agent', agent, machineId: id }, strong: true },
          ...(codexReady ? [{ label: say('useCodex'), intent: { kind: 'sign-in-agent', agent: 'codex', machineId: id } as Intent }] : []),
        ],
      };
    }
    default:
      return null;
  }
}

/** The delivery problems (notifications off, brief missed): the exact sentence and its one-tap fix. */
export const deliveryProblems = (v: PhoneView) =>
  v.view.problems.map((p) => ({
    id: p.id,
    cause: p.cause,
    action: { label: p.fix.label, intent: { kind: 'fix', id: p.fix.id } as Intent },
    also: (p.also ?? []).map((a) => ({ label: a.label, intent: { kind: 'fix', id: a.id } as Intent })),
  }));

/** The composer's placeholder: it says when a message will wait. */
export function composerHint(v: PhoneView): string {
  return v.view.home.state === 'asleep' ? say('messageSendsWhenBack', { name: homeName(v) }) : say('messageMomo');
}

export type TurnRow = { turnId: string; text: string; status: string; sub: string | null; actions: Action[] };
type UserRow = Extract<MomoChatRow, { kind: 'user' }>;

/** What a message you sent says about itself: waiting, or after a lost connection what the home knows. An unknown delivery reads as not sure. */
export function turnRow(v: PhoneView, row: UserRow): TurnRow {
  const name = homeName(v);
  const base = { turnId: row.id, text: row.text };
  const plain = (status: string, sub: string | null = null) => ({ ...base, status, sub, actions: [] as Action[] });
  switch (row.delivery) {
    case 'queued':
      return plain(say('waitingFor', { name }));
    case 'accepted':
      return { ...base, status: say('hasIt', { name }), sub: say('workingOnItNow'), actions: [] };
    case 'completed':
      return plain(say('hasIt', { name }));
    case 'failed':
      return plain(say('couldntDoIt'));
    case 'cancelled':
      return plain(say('stopped'));
    case 'interrupted':
      return plain(say('interrupted'), say('itMayHavePartlyFinished'));
    case 'never-got-it':
      return {
        ...base,
        status: say('neverGotIt', { name }),
        sub: say('notSentSendNow'),
        actions: [{ label: say('sendNow'), intent: { kind: 'send', turnId: row.id, text: row.text }, strong: true }],
      };
    default: {
      // in doubt: only the home's own status (Check again) lets it go again, never a guess
      return {
        ...base,
        status: say('notSure'),
        sub: say('mayHaveStartedCheckBefore', { name }),
        actions: [{ label: say('checkAgain'), intent: { kind: 'check-turn', turnId: row.id } }],
      };
    }
  }
}

/** A message's status line: shown while it waits or its delivery is in doubt, and for the last one while it works with no reply. */
export const turnStatus = (v: PhoneView, row: UserRow): TurnRow | null => {
  const settled = row.delivery === 'completed' || row.delivery === 'accepted';
  const lastRow = v.view.chat[v.view.chat.length - 1] === row;
  return !settled || (row.delivery === 'accepted' && lastRow) ? turnRow(v, row) : null;
};

/** The morning brief card: the one thing that needs you, at most two offers with Hide and Start, and what happened overnight. */
export function briefCard(v: PhoneView, b: Extract<MomoChatRow, { kind: 'brief' }>['brief']) {
  const o = b.overnight;
  return {
    greeting: b.greeting,
    attention: b.attention?.text ?? null,
    offers: b.offers.map((x) => ({
      id: x.id,
      title: x.title,
      why: x.why,
      actions: [
        { label: say('hide'), intent: { kind: 'offer', briefDay: b.day, offerId: x.id, action: 'hide' } as Intent },
        { label: say('start'), intent: { kind: 'offer', briefDay: b.day, offerId: x.id, action: 'start' } as Intent, strong: true },
      ],
    })),
    overnight: say('overnight', {
      name: homeName(v),
      read: say('messageCount', { count: o.read }),
      notes: say('noteCount', { count: o.notesUpdated }),
      rules: say('ruleCount', { count: o.rulesLearned }),
    }),
  };
}

/** The one card after the home slept: what it read and the items that need you. */
export function catchUpCard(c: Extract<MomoChatRow, { kind: 'catch-up' }>['catchUp']) {
  const need = c.needsYou.length;
  return {
    title: say('whileAsleep', { name: c.machine.name, from: clock(c.from), to: clock(c.to) }),
    body: need
      ? say('readNeedsYou', { read: c.read, count: need, items: c.needsYou.map((x) => x.text).join('; '), rest: c.read - need })
      : say('readMessagesNothingNeedsYou', { read: c.read }),
  };
}

export type MachineRow = { id: string; name: string; subtitle: string; recommended: boolean; action: Action | null; here: boolean };

const lower = (s: string) => `${s.charAt(0).toLowerCase()}${s.slice(1)}`;
const subtitleOf = (m: MomoMachineView): string => {
  switch (m.status) {
    case 'needs-update':
      return say('mopilotThereIsOutOf');
    case 'not-set-up':
      return m.note ? say('notSetUpNote', { note: lower(m.note) }) : say('notSetUp');
    case 'online':
      return m.note ? say('onlineNote', { note: lower(m.note) }) : say('online');
    default:
      return say('offline');
  }
};

const rowOf = (m: MomoMachineView): MachineRow => {
  const base = { id: m.machineId, name: m.name, recommended: m.recommended, here: m.isHome };
  if (m.isHome) return { ...base, subtitle: say('momoIsHere'), action: null };
  const subtitle = subtitleOf(m);
  if (m.status === 'not-set-up') return { ...base, subtitle, action: { label: say('setUp'), intent: { kind: 'move', toId: m.machineId } } };
  if (m.status === 'needs-update')
    return { ...base, subtitle, action: { label: say('update2'), intent: { kind: 'update-machine', machineId: m.machineId } } };
  return { ...base, subtitle, action: m.status === 'online' ? { label: say('move'), intent: { kind: 'move', toId: m.machineId } } : null };
};

/** Where MoMo runs: the home card first, then each other machine with Move, Update or Set up. */
export function whereRows(v: PhoneView): { here: MachineRow | null; others: MachineRow[]; footnote: string } {
  // a machine's Update or Set up is the Mac's to run: none on the phone's own home
  const rows = v.view.home.machines.map(rowOf).map((r) => ({ ...r, action: r.action && offered(v, [r.action]).length ? r.action : null }));
  return {
    here: rows.find((r) => r.here) ?? null,
    others: rows.filter((r) => !r.here),
    footnote: say('movingTakesAboutAMinute'),
  };
}

/** The machine's detail lines on the home card. */
export function homeCardLines(v: PhoneView): string[] {
  const m = homeMachine(v);
  if (!m) return [];
  const sources = v.view.home.sources;
  const readOnly = sources.length > 0 && sources.every((s) => s.status === 'ok' && s.access === 'read-only');
  return [
    m.status === 'online' ? say('onlineThisPhoneIsConnected') : say('offline'),
    ...(m.note ? [m.note] : []),
    ...(m.agentsSignedIn.length ? [say('agentsSignedIn', { agents: andList(m.agentsSignedIn) })] : []),
    ...(readOnly ? [say('gmailAndCalendarConnectedRead')] : []),
  ];
}

/** First run: the machines as a list, the recommended one chosen, Continue with it. */
export function firstRun(v: PhoneView): { rows: MachineRow[]; chosen: string | null; cta: string | null } {
  const rows = v.view.home.machines
    .filter((m) => m.status !== 'not-set-up')
    .map((m) => ({ ...rowOf(m), here: false, action: null, subtitle: subtitleOf(m) }));
  const best = rows.find((r) => r.recommended);
  return { rows, chosen: best?.id ?? null, cta: best ? say('continueWith', { name: best.name }) : null };
}

const stepLabel = (): Record<string, string> => ({
  paused: say('paused'),
  sealed: say('sealed'),
  copied: say('copied'),
  switching: say('switching'),
  resuming: say('resuming'),
  'cleaning-up': say('cleaningUp'),
});
/** A step's word; a step a newer Host adds shows as it is named. */
export const moveStepLabel = (s: MomoMoveStep) => stepLabel()[s] ?? s;

export type MovePanel =
  | {
      kind: 'moving';
      title: string;
      from: string;
      steps: { label: string; state: 'done' | 'current' | 'todo' }[];
      note: string;
      cancel: Action | null;
      /** The Cancel was pressed and the home has not finished cancelling: the card says so until it has. */
      cancelling: boolean;
      moveId: string;
      cancelNote: string;
    }
  | {
      kind: 'failed';
      title: string;
      cause: string;
      lastStep: string;
      /** When it was tried again, if it was */
      tried: string | null;
      actions: Action[];
      reclaim: { action: Action; sheet: { title: string; body: string; confirm: string } } | null;
    }
  | { kind: 'finished-late'; title: string; body: string; ack: Action };

/** The move in progress, failed, or finished while the old machine was offline; null when no move is showing (done, cancelled or none). */
export function movePanel(v: PhoneView): MovePanel | null {
  const m = v.view.home.move;
  if (!m) return null;
  const from = m.from.name;
  const to = m.to.name;
  // a move that was cancelled (or reclaimed) keeps its failure on record: it is over, so nothing is drawn
  if (m.outcome === 'cancelled') return null;
  if (m.failure || m.outcome === 'failed') {
    return {
      kind: 'failed',
      title: say('moveDidntFinish'),
      cause: say('moveStillOn', { cause: m.failure?.cause ?? say('moveStopped'), name: from }),
      lastStep: m.failure ? say('lastStep', { step: moveStepLabel(m.failure.failedAt) }) : '',
      tried: v.retriedAt !== undefined ? say('triedAgainAt', { time: clock(v.retriedAt) }) : null,
      actions: [
        { label: say('retry'), intent: { kind: 'move-retry', moveId: m.moveId }, strong: true },
        { label: say('stayOn', { from }), intent: { kind: 'move-stay', moveId: m.moveId } },
      ],
      // offered only when the home offers it, in the words it gives for the confirmation shown before the tap
      reclaim: m.reclaim
        ? { action: { label: say('runHereAgain'), intent: { kind: 'reclaim', moveId: m.moveId, toId: m.to.machineId } }, sheet: m.reclaim }
        : null,
    };
  }
  if (m.outcome === 'moved') {
    if (!m.oldMachineOffline) return null;
    return {
      kind: 'finished-late',
      title: say('movedTo', { to }),
      body: say('isOfflineAndStillHolds', { from }),
      ack: { label: say('gotIt'), intent: { kind: 'move-ack', moveId: m.moveId } },
    };
  }
  const at = (MOMO_MOVE_STEPS as readonly string[]).indexOf(m.step);
  const cancellable = momoMoveCancellable(m.step);
  return {
    kind: 'moving',
    title: say('movingMomoTo', { to }),
    from: say('fromAboutAMinute', { from }),
    steps: MOMO_MOVE_STEPS.map((s, i) => ({ label: stepLabel()[s], state: i < at ? 'done' : i === at ? 'current' : 'todo' })),
    note: say('chatAndTheMorningBrief'),
    cancel: cancellable && !v.cancelling ? { label: say('cancel'), intent: { kind: 'move-cancel', moveId: m.moveId } } : null,
    cancelling: !!v.cancelling,
    moveId: m.moveId,
    cancelNote: cancellable ? say('youCanCancelUntilThe') : say('itIsSwitchingItCannot'),
  };
}

export type ApprovalView = {
  title: string;
  to: string | null;
  subject: string | null;
  attached: string | null;
  body: string;
  details: { label: string; value: string }[];
  status: string | null;
  statusSub: string | null;
  actions: Action[];
  footer: string | null;
};

/** The approval card in each state; a status this client does not know offers no answer. */
export function approvalView(card: MomoApprovalView, now: number): ApprovalView {
  const who = card.recipients.map((r) => r.name).join(', ');
  const mail = card.action === 'send-email';
  const base = {
    to: mail ? card.recipients.map((r) => say('nameAddress', { name: r.name, address: r.address })).join(', ') : null,
    subject: card.subject,
    attached: card.attachments.length ? card.attachments.join(', ') : null,
    body: card.body,
    details: card.fields,
  };
  const answer = (a: 'send' | 'edit' | 'deny' | 'ask-again'): Intent => ({ kind: 'approval', cardId: card.id, answer: a });
  const again: Action[] = card.canAskAgain ? [{ label: say('askAgain'), intent: answer('ask-again'), strong: true }] : [];
  const closed = (title: string, statusSub: string | null = null, actions: Action[] = [], status: string | null = null): ApprovalView => ({
    ...base,
    title,
    status,
    statusSub,
    actions,
    footer: null,
  });
  const el = card.answeredElsewhere;
  if (el) {
    const sent = el.outcome === 'approved';
    return {
      ...base,
      title: say('answeredOn', { device: el.device || say('otherDevice'), time: clock(el.at) }),
      status: null,
      statusSub: sent ? (mail ? say('youSentTheEmailTo', { who }) : say('youSaidYes')) : say('youDidNotSendIt'),
      actions: [],
      footer: say('theCardClosesOnEvery'),
    };
  }
  const status = momoApprovalStatus(card, now);
  switch (status) {
    case 'expired':
      return closed(
        card.subject
          ? say('cardTitleSubject', { title: card.title, who, subject: card.subject })
          : say('cardTitle', { title: card.title, who }),
        say('nobodyAnsweredInMinutesNothing'),
        [...again, { label: say('dismiss'), intent: answer('deny') }],
        say('expired'),
      );
    case 'approved':
    case 'consumed':
      return closed(say('sending'));
    case 'completed':
      return closed(mail ? say('sentTo', { who }) : say('done'));
    case 'denied':
    case 'answered-elsewhere':
      return closed(say('notSent'), null, again);
    case 'failed':
      return closed(
        say('couldntSend'),
        card.failure?.cause ?? null,
        card.failure?.fix ? [{ label: card.failure.fix.label, intent: { kind: 'fix', id: card.failure.fix.id }, strong: true }] : again,
      );
    case 'uncertain':
      return closed(say('notSure'), say('itMayHaveBeenSent'), again);
    case 'void':
      // the note's line changed or an edit replaced it: the card says why; otherwise the home moved
      return closed(say('noLongerValid'), card.failure?.cause ?? say('cardMomoMoved'), again);
    case 'pending': {
      const outside = card.recipients.filter((r) => r.outsideCompany).length;
      return {
        ...base,
        title: card.title,
        status: outside ? say('outsideCompany', { count: outside }) : null,
        statusSub: null,
        actions: [
          { label: say('send'), intent: answer('send'), strong: true },
          // Edit only on a card the Host can run the edit of itself: the card says so (absent is no)
          ...(card.editable === true ? [{ label: say('edit'), intent: answer('edit') }] : []),
          { label: say('dontSend'), intent: answer('deny') },
        ],
        footer: null,
      };
    }
    default:
      return closed(card.title);
  }
}

/** The inline rule line under a "Not needed": the suggestion with Undo, or the Undo outcome (read from the rule's own state). */
export function suggestionView(v: PhoneView, s: { ruleId: string; text: string } | null) {
  if (!s) return null;
  const rule = v.view.rules.find((r) => r.id === s.ruleId);
  if (rule?.state === 'undone') {
    const about = /quiet about (.+?)\.?$/.exec(s.text)?.[1];
    return {
      line: about ? say('undoneIWillKeepTelling', { about }) : say('undone'),
      sub: say('wontSuggest'),
      actions: [{ label: say('seeRules'), intent: { kind: 'open-rules' } as Intent }],
    };
  }
  return {
    line: s.text,
    sub: say('onNowUndoAnyTime'),
    actions: [
      { label: say('undo'), intent: { kind: 'rule-undo', ruleId: s.ruleId } as Intent },
      { label: say('seeRule'), intent: { kind: 'open-rules' } as Intent },
    ],
  };
}

/** The chat as the screen shows it: what the home says, then the messages this phone still holds that the home does not list yet. */
export function withTurns(v: PhoneView, turns: readonly LocalTurn[]): PhoneView {
  const listed = new Set(v.view.chat.flatMap((r) => (r.kind === 'user' ? [r.id] : [])));
  const held = turns
    .filter((t) => !listed.has(t.id))
    .map((t) => ({ kind: 'user' as const, id: t.id, at: t.at, text: t.text, delivery: t.delivery, check: t.check }));
  return held.length ? { ...v, view: { ...v.view, chat: [...v.view.chat, ...held] } } : v;
}

/** A source that needs the person (W2.9): what happened, and the one tap that fixes it; a first look still running shows its progress. */
export function sourceProblems(v: PhoneView) {
  return v.view.home.sources.flatMap((s) => {
    const name = s.id === 'gmail' ? 'Gmail' : s.id === 'calendar' ? 'Google Calendar' : s.id;
    if (s.status === 'ok') return [];
    // a first look still running shows how far it is; every other state that is not ok is a sign-in the person can renew
    if (s.status === 'catching-up')
      return [
        {
          id: s.id,
          title: say('lookingAt', { name }),
          body: s.progress ? say('progress', { done: s.progress.done, total: s.progress.total }) : '',
          action: null as Action | null,
        },
      ];
    return [
      {
        id: s.id,
        title: say('needsYouToSignIn', { name }),
        body: say('googleEndedTheSignIn'),
        action: { label: say('reconnect'), intent: { kind: 'google', intent: 'reconnect' } as Intent } as Action | null,
      },
    ];
  });
}

/** The machines a task can run on, for the picker. */
export const pickRows = (v: PhoneView, taskId: string) =>
  v.view.home.machines
    .filter((m) => m.status === 'online')
    .map((m) => ({
      id: m.machineId,
      name: m.name,
      detail: m.agentsSignedIn.length ? say('agentsSignedIn', { agents: andList(m.agentsSignedIn) }) : say('noAgentSignedIn'),
      intent: { kind: 'task-retry', taskId, machineId: m.machineId } as Intent,
    }));
