// What the notice pipeline's records look like to the two apps (the shared view contract, shared/momoView.ts): the "why you saw this" of a decision, the Watching row of a matter, the brief card and its plain-text twin, with "Left out" drawn from the decision log and never from the model.
import type { MomoBriefView, MomoDecisionView, MomoMachineRef, MomoTaskView } from '../momoView.ts';
import type { Brief } from './brief.ts';
import type { Decision } from './pipeline.ts';
import { localTime } from './limits.ts';
import { cleanText } from './signals.ts';
import type { Matter } from './types.d.ts';

/** A decision as the Host keeps it: the pipeline's record, the title of its matter, and whether it was the first of that matter. */
export type StoredDecision = Decision & { title: string; first: boolean };

const REASON_WORDS = 20;
const HOLDS: Record<string, string> = {
  quiet_hours: 'Held for the brief: quiet hours.',
  daily_cap: 'Held for the brief: the daily limit was reached.',
  snoozed: 'Held for the brief: snoozed.',
  already_told: 'Not told again: you already heard about this.',
  dismissed: 'Not told: you dismissed this.',
  first_connect: 'Held for the brief: it was already in your inbox when MoMo connected.',
};
const SOURCES: Record<string, string> = { gmail: 'Gmail', calendar: 'Calendar' };
const sourceOf = (key: string) => SOURCES[key.split(':')[0]] ?? 'MoMo';
const words = (text: string, max: number) => {
  const all = text.trim().split(/\s+/);
  return all.length > max ? `${all.slice(0, max).join(' ')}…` : text.trim();
};

/** "09:30" on the home's clock; a date-only event is all day. */
function clock(start: string, timeZone: string): string {
  if (start.length === 10) return 'All day';
  const { minute } = localTime(new Date(start), timeZone);
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/** The id of this one decision of a matter (a thread's id repeats with each new mail; this does not): a tap on a row carries it, so an old tap cannot act on what came later. */
export const decisionIdOf = (decision: Pick<StoredDecision, 'changeId' | 'at'>): string => `${decision.changeId}@${decision.at}`;

/** The "Why you saw this" card of one decision. */
export function decisionView(decision: StoredDecision): MomoDecisionView {
  const checks: string[] = [];
  if (decision.suspect) checks.push(`Sender check failed: this may not be from ${decision.suspect.name}.`);
  else if (decision.sender) checks.push(`Sender check: ${decision.sender.reason}`);
  if (decision.heldFor) checks.push(HOLDS[decision.heldFor] ?? 'Held for the brief.');
  if (decision.injection.length > 0) checks.push('The mail told the assistant what to do; that was ignored.');
  if (decision.private) checks.push('Holds a sign-in code or reset link, kept private.');
  checks.push(decision.decidedBy.startsWith('rule:') ? 'Decided by a plain rule, no model.' : 'Read by the model with no tools.');
  const rule = decision.decidedBy.startsWith('rule:') ? { id: decision.decidedBy.slice(5), text: decision.reason } : null;
  return {
    id: decision.changeId,
    decisionId: decisionIdOf(decision),
    outcome: decision.decision === 'unsorted' ? 'unsorted' : decision.decision === 'track' ? 'watch' : decision.decision,
    reason: cleanText(words(decision.reason, REASON_WORDS), 200),
    kind: null,
    rule,
    checks,
    matter: { key: decision.matterKey, title: cleanText(decision.title, 200), first: decision.first },
    at: Date.parse(decision.at),
  };
}

/** A matter MoMo is watching, as a task row in the Watching group: why, when it is checked next, and whether and when you were told. */
export function watchingTask(matter: Matter, decision: StoredDecision | null, machine: MomoMachineRef): MomoTaskView {
  // a reminder the owner asked for is the next time MoMo comes back to it
  const due = matter.remindAt ?? matter.nextCheck;
  const nextCheck = due ? Date.parse(due) : null;
  const toldAt = matter.notifiedAt ? Date.parse(matter.notifiedAt) : null;
  return {
    id: `watch:${matter.matterKey}`,
    title: cleanText(matter.title, 200),
    doneMeans: 'You are told if it changes in a way that needs you.',
    state: 'watching',
    origin: 'matter',
    where: { machine, agent: 'MoMo' },
    startedAt: Date.parse(matter.updatedAt),
    attempts: 0,
    attemptCap: 0,
    step: cleanText(matter.summary, 200),
    nextCheck,
    failure: null,
    result: null,
    watch: {
      why: cleanText(matter.summary, 200),
      nextCheck,
      told: toldAt !== null,
      toldAt,
      decision: decision ? decisionView(decision) : null,
    },
  };
}

/** The brief card. `leftOut`: the quiet mail since the last brief, each with the rule or model reason that left it out. */
export function briefView(brief: Brief, leftOut: StoredDecision[]): MomoBriefView {
  const first = brief.needsYou[0];
  return {
    day: brief.dayKey,
    greeting: brief.name ? `Good morning, ${cleanText(brief.name, 60)}.` : 'Good morning.',
    attention: first ? { text: first.suspect ? first.title : `${first.title}: ${first.summary}`, source: sourceOf(first.matterKey) } : null,
    offers: [],
    overnight: { read: brief.checked.mail, notesUpdated: 0, rulesLearned: 0 },
    leftOut: leftOut.map((decision) => ({ id: decision.changeId, reason: cleanText(decision.reason, 160) })),
  };
}

/** The brief as plain text, built by code from the same record the card is: the same words every time, no model. */
export function renderBrief(brief: Brief, timeZone: string): string {
  const out: string[] = [brief.name ? `Good morning, ${cleanText(brief.name, 60)}.` : 'Good morning.'];
  if (brief.needsYou.length > 0) {
    out.push('', 'Needs you:');
    for (const m of brief.needsYou)
      out.push(m.suspect ? `- ${m.title} Check the sender before you act on it.` : `- ${m.title}: ${m.summary}`);
  }
  if (brief.watching.length > 0) {
    out.push('', 'Watching:');
    for (const m of brief.watching) out.push(`- ${m.title}`);
  }
  if (brief.today.length > 0) {
    out.push('', 'Today:');
    for (const e of brief.today) out.push(`- ${clock(e.start, timeZone)} ${cleanText(e.summary, 120)}`);
  }
  if (brief.couldNotSort.length > 0) {
    out.push('', 'Could not sort:');
    for (const item of brief.couldNotSort) out.push(`- ${item.title}: ${item.error}`);
  }
  for (const gap of brief.couldNotCheck) out.push('', `Could not check ${gap.source}: ${gap.why}`);
  return out.join('\n');
}
