// The notice pipeline for one pass: pre-checks, the tool-less reading turn, the sender check, then the code limits, returning one decision record per item and at most one catch-up summary.
import { markSeen, type Change } from './changeDetect.ts';
import { assertFreshIds } from './envelope.ts';
import { applyLimits, isCatchUp, localTime, resolveMatter, type DeliveryMode, type NoticeSettings, type Outcome } from './limits.ts';
import { holdsAccessSecret, preCheck } from './preChecks.ts';
import { injectionSignals, ownMatterKey, readItem, type Candidate, type Person, type ReadItem } from './reading.ts';
import {
  fromDomain,
  isAutomated,
  judgeSender,
  mayOfferReply,
  mentionsMoneyOrCredentials,
  senderName,
  type SenderCheck,
} from './senderCheck.ts';
import { askOf, cleanText, deadlineDay, hasRiskSignal, urgencyRank } from './signals.ts';
import type { Clock, CorrespondentHistory, NoticeStore, ReaderModel, ReadingAnswer, VersionStore } from './types.d.ts';

const mailText = (mail: { subject: string; body: string }) => `${mail.subject}\n${mail.body}`;

/** One line of the decision log: what was decided, by what, and what the code did with it. */
export type Decision = {
  changeId: string;
  decision: ReadingAnswer['verdict'] | 'unsorted';
  /** Short, one line, no links or codes: safe to store and show. */
  reason: string;
  matterKey: string;
  decidedBy: string;
  at: string;
  outcome: Outcome['action'] | 'unsorted';
  /** Why the code held it, when it did. */
  heldFor?: string;
  /** Set for a tell-now about money or credentials: the sender check, and with it whether a reply draft may be offered. */
  sender?: SenderCheck;
  /** What the sender check said about this mail, whenever it ran (it runs for every mail the model did not call quiet): only a mail that passed teaches anything about its sender's domain. */
  senderStatus?: SenderCheck['status'];
  /** The sender failed that check: the reason is "This may not be from <name>" and there is no reply draft and no link. */
  suspect?: { name: string };
  offerReply: boolean;
  /** Injection phrases seen in the item; the verdict is not changed by them. */
  injection: string[];
  /** The mail held an access secret: it was redacted before any model saw it and must never be quoted. */
  private: boolean;
};

export type CatchUpSummary = { count: number; matterKeys: string[] };

export type PassDeps = {
  store: NoticeStore;
  versions: VersionStore;
  model: ReaderModel;
  person: Person;
  clock: Clock;
  /** The home's settings, time zone included: every day key and quiet-hours test in the pass uses them. */
  settings: NoticeSettings;
  history: CorrespondentHistory;
  /** A fresh boundary id per call (`randomMarkerId`); a constant one is refused. */
  randomId: () => string;
  /**
   * The last pass's time. Undefined is the first connect: nothing found then is pushed, it all waits for the brief, so a new
   * account does not announce a month of old mail.
   */
  lastRunAt?: Date;
  /** Loads the item behind a change (the full mail or the event); null when it is gone. */
  load: (change: Change) => Promise<ReadItem | null>;
};

export type PassResult = { decisions: Decision[]; catchUp?: CatchUpSummary };

const changeId = (change: Change) => (change.kind === 'mail' ? `gmail:${change.threadId}` : `calendar:${change.eventId}`);

/**
 * Live matters code offers the model to file a mail under: only a matter this very thread was already filed under. Never one that
 * merely shares the sender's domain: a look-alike or a fooled model must not fold a new alert into a matter the user was already told about.
 */
async function candidatesFor(store: NoticeStore, item: ReadItem, own: string): Promise<Candidate[]> {
  if (item.kind !== 'mail') return [];
  return (await store.listMatters())
    .filter(
      (matter) =>
        matter.matterKey !== own &&
        (matter.state === 'open' || matter.state === 'watching') &&
        matter.sources.some((source) => source.sourceId === 'gmail' && source.id === item.mail.threadId),
    )
    .slice(0, 5)
    .map((matter) => ({ key: matter.matterKey, title: matter.title }));
}

/** The item's text for the code signals (deadline, urgency), with the day it is read on. */
function signalsOf(item: ReadItem, today: string, timeZone: string): { deadline?: string; urgency: 1 | 2 | 3; expiresAt?: string } {
  if (item.kind === 'mail') {
    const text = `${item.mail.subject}\n${item.mail.body}`;
    const deadline = deadlineDay(text, today);
    return { ...(deadline ? { deadline } : {}), urgency: urgencyRank(text, deadline, today) };
  }
  const { start, end } = item.event;
  const startDay = start?.date ?? (start?.dateTime ? localTime(new Date(start.dateTime), timeZone).dayKey : undefined);
  const endAt = end?.dateTime ?? end?.date;
  return {
    ...(startDay && startDay >= today ? { deadline: startDay } : {}),
    urgency: urgencyRank('', startDay && startDay >= today ? startDay : undefined, today),
    ...(endAt ? { expiresAt: new Date(endAt).toISOString() } : {}),
  };
}

async function decide(deps: PassDeps, change: Change, mode: DeliveryMode): Promise<Decision | null> {
  const item = await deps.load(change);
  if (!item) return null;
  const at = deps.clock.now();
  const id = changeId(change);
  // a matter's key is derived here, in code, namespaced by its source
  const own = ownMatterKey(item);
  const base = {
    changeId: id,
    at: at.toISOString(),
    injection: injectionSignals(item),
    offerReply: true,
    private: item.kind === 'mail' && holdsAccessSecret(item.mail),
  };

  if (item.kind === 'mail') {
    const pre = preCheck(item.mail);
    if (pre) {
      // the user's own reply ends the matter
      if (pre.decidedBy === 'rule:sent') await resolveMatter(deps.store, own, at);
      return {
        ...base,
        decision: 'quiet',
        reason: pre.reason,
        matterKey: own,
        decidedBy: pre.decidedBy,
        outcome: 'quiet',
        private: pre.private,
      };
    }
  }

  const candidates = await candidatesFor(deps.store, item, own);
  const reading = await readItem(item, { model: deps.model, person: deps.person, now: at, randomId: deps.randomId, candidates });
  if (!reading.ok)
    return {
      ...base,
      decision: 'unsorted',
      reason: reading.error,
      matterKey: own,
      decidedBy: `model:${deps.model.name}`,
      outcome: 'unsorted',
    };

  const { answer, decidedBy } = reading;
  // the sender check runs before anything is decided about the push: a money or credential alert that fails it is shown as "may not be from", never as an alert
  // every tell-now and every watched mail is judged: a phish that talks about a parcel or an address is not a money alert by its words
  const sender = answer.verdict !== 'quiet' && item.kind === 'mail' ? judgeSender(item.mail, await deps.history.knownDomains()) : undefined;
  const sensitive = item.kind === 'mail' && (mentionsMoneyOrCredentials(item.mail) || hasRiskSignal(mailText(item.mail)));
  // money, credentials and risk wording need a known correspondent whose domain passed; any other mail is flagged when the check failed or the domain imitates one the user knows
  const suspect =
    sender !== undefined && (sensitive ? !mayOfferReply(sender) : sender.status === 'fail' || sender.lookalikeOf !== undefined);
  const suspectName = suspect && item.kind === 'mail' ? senderName(item.mail.from) : undefined;
  const shown = suspectName ? `This may not be from ${suspectName}.` : undefined;
  // the model may only pick among the matters code offered; anything else is the item's own matter
  const matterKey = !suspect && candidates.some((candidate) => candidate.key === answer.matterKey) ? answer.matterKey : own;
  const { timeZone } = deps.settings;
  const signals = signalsOf(item, localTime(at, timeZone).dayKey, timeZone);
  const fromDomainOf = item.kind === 'mail' ? fromDomain(item.mail.from) : null;
  // an automated sender's "please" and "do not reply" are boilerplate, never a request to the owner
  const ask = item.kind === 'mail' && !isAutomated(item.mail) ? askOf(mailText(item.mail)) : undefined;
  const outcome = await applyLimits(deps.store, deps.settings, at, {
    answer: shown ? { ...answer, reason: shown } : answer,
    matterKey,
    title: shown ?? cleanText(item.kind === 'mail' ? item.mail.subject : (item.event.summary ?? '(no title)'), 200),
    source: {
      sourceId: change.kind === 'mail' ? 'gmail' : 'calendar',
      id: change.kind === 'mail' ? change.threadId : change.eventId,
      version: change.version,
    },
    ...signals,
    mode,
    ...(fromDomainOf ? { fromDomain: fromDomainOf } : {}),
    ...(item.kind === 'mail' && ask ? { ask } : {}),
    ...(suspect ? { suspect } : {}),
  });
  return {
    ...base,
    decision: answer.verdict,
    reason: shown ?? answer.reason,
    ...(suspectName ? { suspect: { name: suspectName } } : {}),
    matterKey,
    decidedBy,
    outcome: outcome.action,
    ...(outcome.action === 'hold' ? { heldFor: outcome.why } : {}),
    ...(sender && (sensitive || suspect) ? { sender } : {}),
    ...(sender ? { senderStatus: sender.status } : {}),
    // a reply draft is for a sender that is known and passed when money or credentials are in play, and for any sender that did not fail
    offerReply: suspect ? false : sender && sensitive ? mayOfferReply(sender) : true,
  };
}

/**
 * Decides each change in turn. A change is marked seen only once it has a decision; one whose reading failed stays unseen, so the
 * next pass reads it again and the brief lists it meanwhile. After a sleep, tell-nows come back as one catch-up summary
 * (outside the daily cap) instead of one push each; on the first connect they wait for the brief.
 */
export async function runNoticePass(deps: PassDeps, changes: Change[]): Promise<PassResult> {
  assertFreshIds(deps.randomId);
  const mode: DeliveryMode =
    deps.lastRunAt === undefined ? 'first_connect' : isCatchUp(deps.lastRunAt, deps.clock.now(), deps.settings) ? 'catch_up' : 'normal';
  const decisions: Decision[] = [];
  const caught: string[] = [];
  for (const change of changes) {
    const decision = await decide(deps, change, mode);
    if (!decision) {
      await markSeen(deps.versions, change);
      continue;
    }
    decisions.push(decision);
    if (decision.outcome === 'catch_up') caught.push(decision.matterKey);
    if (decision.outcome !== 'unsorted') await markSeen(deps.versions, change);
  }
  return { decisions, ...(caught.length ? { catchUp: { count: caught.length, matterKeys: caught } } : {}) };
}

/** True when every calendar event of the pass was decided: only then may the probe token and sync time be recorded (`markCalendarSynced`). */
export const calendarClean = (decisions: Decision[]): boolean =>
  !decisions.some((decision) => decision.changeId.startsWith('calendar:') && decision.outcome === 'unsorted');
