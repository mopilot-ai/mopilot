// MoMo's phone view models for the Tasks, Notes, Rules and Settings tabs: sections, details, failures with their fixes, notes and why, permission, previews, brief.
import { offered } from './ownHome';
import {
  groupMomoTasks,
  type MomoDecisionView,
  type MomoNoteLine,
  type MomoNoteView,
  type MomoSettingsView,
  type MomoTaskView,
} from '../../../shared/momoView';
import { type Action, agentOf, ago, clock, homeId, homeName, shortDate, time12 } from './common';
import { say, sentences } from './say';
import type { Intent, NotificationAction, PhoneView } from './types';

export type TaskSection = { key: string; title: string; tasks: MomoTaskView[] };
const sectionTitle = (): Record<string, string> => ({
  'needs-you': say('needsYou'),
  working: say('working'),
  watching: say('watching'),
  done: say('doneToday'),
  other: say('other'),
});

/** The Tasks screen's sections in the contract's order, or "Nothing running." with Ask MoMo. */
export function taskSections(tasks: readonly MomoTaskView[]): {
  sections: TaskSection[];
  empty: { title: string; body: string; cta: string } | null;
} {
  const sections = groupMomoTasks(tasks).map((g) => ({ key: g.id, title: sectionTitle()[g.id], tasks: g.tasks }));
  return {
    sections,
    empty: sections.length
      ? null
      : {
          title: say('nothingRunning'),
          body: sentences(say('askMomoForSomethingThatA'), say('askMomoForSomethingThatB')),
          cta: say('askMomo'),
        },
  };
}

const statusWord = (): Record<string, string> => ({
  needs_you: say('needsYou'),
  working: say('working'),
  watching: say('watching'),
  done: say('done2'),
  failed: say('failed'),
  stopped: say('stopped'),
});

const problemView = (v: PhoneView, task: MomoTaskView) => {
  const p = problemOf(v, task);
  return p && { ...p, actions: offered(v, p.actions) };
};

const problemOf = (v: PhoneView, task: MomoTaskView) => {
  const f = task.failure;
  if (!f) return null;
  const machine = f.machine ?? task.where.machine;
  const agent = f.agent ?? task.where.agent;
  const kind = agentOf(agent);
  // the home's own fix when it offers one, else the fix this client knows for the cause
  const fix = f.fix ? { label: f.fix.label, intent: { kind: 'fix', id: f.fix.id } as Intent, strong: true } : null;
  const retry: Action = { label: say('retry'), intent: { kind: 'task-retry', taskId: task.id }, strong: true };
  switch (f.code) {
    case 'agent-missing':
      return {
        title: say('isnTInstalledOn', { agent, name: machine.name }),
        body: say('thisTaskNeedsInstallIt', { agent }),
        actions: [
          fix ?? {
            label: say('installOn2', { agent, name: machine.name }),
            intent: { kind: 'install-agent', agent: kind, machineId: machine.machineId } as Intent,
            strong: true,
          },
          { label: say('runOn', { name: homeName(v) }), intent: { kind: 'task-retry', taskId: task.id, machineId: homeId(v) } as Intent },
        ],
      };
    case 'agent-signed-out':
      return {
        title: say('isSignedOutOn', { agent, name: machine.name }),
        body: say('theSignInHappensOn'),
        actions: [
          fix ?? {
            label: say('signInOn', { name: machine.name }),
            intent: { kind: 'sign-in-agent', agent: kind, machineId: machine.machineId } as Intent,
            strong: true,
          },
        ],
      };
    case 'restarted':
      return {
        title: say('restartedWhileThisRanIt', { name: machine.name }),
        body: '',
        actions: [
          { label: say('openTheSession'), intent: { kind: 'task-check', taskId: task.id } as Intent },
          { label: say('startAgain'), intent: { kind: 'task-retry', taskId: task.id } as Intent },
        ],
      };
    default:
      return {
        title: say('couldnTFinish', { message: f.message }),
        body: say('attemptOf', { attempts: task.attempts, attemptCap: task.attemptCap }),
        actions: [fix ?? retry, { label: say('runOnAnotherMachine'), intent: { kind: 'pick-machine', taskId: task.id } as Intent }],
      };
  }
};

export type TaskDetail = {
  title: string;
  status: string;
  facts: { label: string; value: string }[];
  step: string | null;
  /** What MoMo will do next about a watched item that you have not been told of yet. */
  watchNote: string | null;
  awayNote: string | null;
  result: { headline: string; summary: string; checked: string } | null;
  problem: { title: string; body: string; actions: Action[] } | null;
  actions: Action[];
};

/** One task: its facts, its result or problem, and the buttons for its state (Stop only while it works). */
export function taskDetail(v: PhoneView, task: MomoTaskView): TaskDetail {
  const facts = [
    { label: say('doneMeans'), value: task.doneMeans },
    { label: say('runsOn2'), value: say('agentOnMachine', { agent: task.where.agent, name: task.where.machine.name }) },
    { label: say('started'), value: ago(v.now, task.startedAt) },
    ...(task.state === 'watching' ? [{ label: say('why'), value: task.watch?.why ?? task.step ?? '' }] : []),
    ...(task.state === 'watching' && task.nextCheck !== null ? [{ label: say('nextCheck'), value: clock(task.nextCheck) }] : []),
    // the home says whether you were told, and when (W3.3)
    ...(task.state === 'watching' && task.watch
      ? [
          {
            label: say('toldYou'),
            value: task.watch.told ? (task.watch.toldAt === null ? say('yes') : clock(task.watch.toldAt)) : say('notYet'),
          },
        ]
      : []),
  ].filter((f) => f.value);
  const session: Action = { label: say('openTheSession'), intent: { kind: 'task-check', taskId: task.id } };
  let actions: Action[] = [];
  if (task.state === 'working') actions = [session, { label: say('stop'), intent: { kind: 'task-stop', taskId: task.id } }];
  else if (task.state === 'done' && task.result)
    actions = [
      { label: say('open2'), intent: { kind: 'task-check', taskId: task.id }, strong: true },
      { label: say('attachToTheReply'), intent: { kind: 'task-attach', taskId: task.id } },
      session,
    ];
  else if (task.state === 'watching')
    actions = [
      { label: say('checkNow'), intent: { kind: 'task-check', taskId: task.id }, strong: true },
      { label: say('snooze'), intent: { kind: 'task-snooze', taskId: task.id } },
      { label: say('stopWatching'), intent: { kind: 'task-stop-watching', taskId: task.id } },
    ];
  const asleep = v.view.home.state === 'asleep' && task.state === 'working' && task.where.machine.machineId !== homeId(v);
  return {
    title: task.title,
    status: statusWord()[task.state] ?? task.state,
    facts,
    step: task.state === 'watching' ? null : task.step,
    watchNote:
      task.state === 'watching' && v.snoozed?.[task.id] !== undefined
        ? say('snoozedUntil', { time: clock(v.snoozed[task.id]) })
        : task.state === 'watching' && task.watch && !task.watch.told && task.nextCheck !== null
          ? say('iWillTellYouAt', { time: clock(task.nextCheck) })
          : null,
    awayNote: asleep
      ? sentences(say('awayNote', { home: homeName(v), machine: task.where.machine.name }), say('awayNote2', { home: homeName(v) }))
      : null,
    result: task.result
      ? {
          headline: say('ready', { files: task.result.files.join(', ') }),
          summary: task.result.summary,
          checked: say('checked', { evidence: task.result.evidence }),
        }
      : null,
    problem: problemView(v, task),
    actions,
  };
}

/** The Stop confirmation sheet. */
export const stopSheet = (task: MomoTaskView) => ({
  title: say('stopThisTask'),
  body: say('theSessionStopsFilesAlready', { title: task.title }),
  confirm: { label: say('stopTask'), intent: { kind: 'task-stop', taskId: task.id } as Intent },
  cancel: say('keepWorking'),
});

/** Notes: read-only with a cached copy while the home sleeps; the empty state otherwise. */
export function notesState(v: PhoneView): {
  readOnly: boolean;
  empty: { title: string; body: string; actions: string[] } | null;
} {
  const readOnly = v.view.home.state === 'asleep';
  return {
    readOnly,
    empty: v.view.notes.length
      ? null
      : {
          title: say('nothingHereYet'),
          body: sentences(say('afterYouConnectGmailAndA'), say('afterYouConnectGmailAndB')),
          actions: [say('connectGmailAndCalendar'), say('writeYourOwnNote')],
        },
  };
}

/** A note's list row: its title, the date and where it was learned. */
export const noteRow = (note: MomoNoteView) => ({
  id: note.id,
  title: note.title,
  detail: [shortDate(note.updatedAt), note.lines.find((l) => l.sources.length)?.sources[0].label].filter(Boolean).join(' · '),
});

const lineBadges = (): Record<string, string> => ({
  'mentioned-once': say('mentionedOnce'),
  learned: say('learned'),
  confirmed: say('confirmed'),
  'let-go': say('letGo'),
});
export const lineBadge = (line: MomoNoteLine) => lineBadges()[line.status] ?? say('learned');

/** A note line's "Why MoMo thinks this" block; null when it has neither a quote nor a source. */
export function whyLine(line: MomoNoteLine) {
  const [first, ...rest] = line.sources;
  if (!first && !line.quote) return null;
  return {
    quote: line.quote ? say('quoted', { quote: line.quote }) : null,
    from: first ? say('sourceLine', { label: first.label, date: shortDate(first.at) }) : null,
    gone: first?.gone ? say('theMessageIsGoneFrom') : null,
    open:
      first && !first.gone && first.kind === 'mail'
        ? { label: say('openMessage'), intent: { kind: 'open-source', sourceId: first.id } as Intent }
        : null,
    moreLine: rest.length ? say('moreSources', { count: rest.length, labels: rest.map((s) => s.label).join('; ') }) : null,
  };
}

/** A note's History rows: each change with Undo when it can be undone. */
export const historyRows = (note: MomoNoteView) =>
  note.history.map((h) => ({ id: h.id, when: shortDate(h.at), what: h.summary, undoable: h.undoable }));

export const editNote = () => say('yourEditBecomesConfirmedThe');
export const rulesEmpty = () => ({ title: say('noRulesYet'), body: say('whenYouAnswerTheSame') });

const origin = (): Record<string, string> => ({ learned: say('learned'), yours: say('yours'), 'built-in': say('builtIn') });
/** Rules rows: the words, whether it is on, and where it came from. */
export const ruleRows = (v: PhoneView) =>
  v.view.rules.map((r) => ({
    id: r.id,
    words: r.text,
    on: r.state === 'on',
    // a rule in the owner's words is kept but not read by anything yet: it is not drawn as active
    detail:
      r.state === 'saved' ? say('savedNotApplied') : say('ruleDetail', { origin: origin()[r.origin] ?? say('learned'), count: r.useCount }),
  }));

/** Quiet hours as the design words them ("10:00 PM to 8:00 AM"), or Off when the home's range is empty. */
const quiet = (s: MomoSettingsView) =>
  s.quietHours.from === s.quietHours.to ? say('off') : say('quietRange', { from: time12(s.quietHours.from), to: time12(s.quietHours.to) });

/** The notification permission screen: ask, or the fallback when it was refused. */
export function permissionView(v: PhoneView) {
  const s = v.view.settings;
  if (v.view.setup.notifications === 'denied') {
    return {
      title: say('notificationsAreOff'),
      body: say('momoKeepsThingsInChat'),
      actions: [{ label: say('openSettings'), intent: { kind: 'open-settings' } as Intent | null }],
    };
  }
  return {
    title: say('letMomoReachYou'),
    body: sentences(
      say('notifyBody'),
      say('notifyCap', { cap: s.dailyCap }),
      ...(quiet(s) === say('off') ? [] : [say('quietFrom', { range: quiet(s) })]),
    ),
    actions: [
      { label: say('allowNotifications'), intent: { kind: 'prefs', patch: { notifications: 'allowed' } } as Intent | null },
      { label: say('notNow'), intent: null as Intent | null },
    ],
  };
}

/** What the lock screen shows with previews on and off (the design's two examples). */
/** The latest thing MoMo said, which is what a push would carry. */
export const previewSample = (v: PhoneView): string | null => [...v.view.chat].reverse().find((r) => r.kind === 'assistant')?.text ?? null;

/** `sample` is the latest thing MoMo said that the home would push; the lock screen shows it only with previews on. */
export function previewView(s: MomoSettingsView, sample: string | null) {
  return {
    on: s.previews,
    title: s.previews && sample ? sample : say('momoNeedsYou'),
    note: say('theTextIsSealedApple'),
    toggle: { label: say('showTextOnTheLock'), intent: { kind: 'prefs', patch: { previews: !s.previews } } as Intent },
  };
}

/** Brief settings: the switch and its three values, with the quiet-day note. */
export function briefView(s: MomoSettingsView) {
  return {
    on: s.brief.on,
    rows: [
      { id: 'time', label: say('time'), value: time12(s.brief.time) },
      { id: 'quiet', label: say('quietHours'), value: quiet(s) },
      { id: 'cap', label: say('tellMeNowAtMost'), value: say('aDay', { dailyCap: s.dailyCap }) },
    ],
    note: say('aQuietDayMeansNo'),
    toggle: { label: say('sendABrief'), intent: { kind: 'prefs', patch: { brief: !s.brief.on } } as Intent },
  };
}

/** Steps for the daily cap: 1 to 12, so a patch is always a valid cap. */
export const clampCap = (n: number) => Math.min(12, Math.max(1, Math.round(n)));

/** "Not needed" on a row or its Why screen: it carries the decision the row was drawn from when it has one, so an old tap cannot act on what came after it. */
export const notNeeded = (noticeId: string, decisionId?: string): Intent => ({
  kind: 'notice-not-needed',
  noticeId,
  ...(decisionId ? { decisionId } : {}),
});

/** A notification button as a typed intent; "Remind me at 4" carries the time, never free text. */
export function noticeIntent(action: NotificationAction, noticeId: string): Intent {
  if (action === 'draft-reply') return { kind: 'notice-draft-reply', noticeId };
  if (action === 'remind-at-4') return { kind: 'notice-remind', noticeId, at: '16:00' };
  return { kind: 'notice-not-needed', noticeId };
}

/** The real cause and the one-tap fix for a refused intent, as a banner. */
export function failureView(result: { ok: false; cause: string; fix?: Intent; fixLabel?: string }) {
  return { cause: result.cause, fix: result.fix && result.fixLabel ? { label: result.fixLabel, intent: result.fix } : null };
}

/**
 * Why you saw this (W3.2): the reason in MoMo's words, then what the decision log says: how it was sorted, the rule, what was checked and the matter.
 * A notice with no decision record shows the reason alone.
 */
export function decisionView(row: { whyTold: string | null; decision?: MomoDecisionView | null }) {
  const d = row.decision ?? null;
  const sorted: Record<string, string> = { tell_now: say('toldYouNow'), watch: say('watching'), quiet: say('keptQuiet') };
  return {
    reason: d?.reason || row.whyTold || '',
    lines: [
      ...(d && sorted[d.outcome] ? [{ label: sorted[d.outcome], value: d.kind ?? '' }] : []),
      ...(d?.rule ? [{ label: say('rule'), value: d.rule.text }] : []),
      ...(d?.matter
        ? [{ label: say('matter'), value: d.matter.first ? say('matterFirst', { title: d.matter.title }) : d.matter.title }]
        : []),
    ].filter((l) => l.value),
    checks: d?.checks ?? [],
    editRule: d?.rule ? ({ label: say('editRule'), intent: { kind: 'open-rules' } } as Action) : null,
  };
}
