// A chat's review findings as its turns hold them: the review, its later re-reports and fix requests, each finding's status.
import {
  findingStatuses,
  fixRequestFindings,
  isFixRequest,
  isReReport,
  reviewFindingsOf,
  type FindingStatus,
  type ReviewFinding,
} from '../../shared/reviewFindings.mjs';
import type { FixAnchor, ReviewMarks } from '../../shared/model/window';
export type { FixAnchor, ReviewMarks } from '../../shared/model/window';

/** Whether a finding is still to act on in the diff: not dismissed there, nor fixed or settled by a re-report. */
export const leftToActOn = (status: FindingStatus) => status !== 'dismissed' && status !== 'addressed';

type ItemLike = {
  id: string;
  type: string;
  review?: unknown;
  findings?: unknown;
  level?: unknown;
  content?: unknown;
};
type TurnLike = { id?: string; status: string; items: ItemLike[] };
type ReviewEntry = { at: number; id: string; list: NonNullable<ReturnType<typeof reviewFindingsOf>>; reReport: boolean };

// a turn's reviews, read once per turn object: a streamed delta replaces one turn, so the others are not read again
const reviewsCache = new WeakMap<TurnLike, ReviewEntry[]>();
function reviewsIn(turn: TurnLike): ReviewEntry[] {
  let entries = reviewsCache.get(turn);
  if (!entries) {
    entries = [];
    turn.items.forEach((item, at) => {
      const list = item.type === 'exitedReviewMode' ? reviewFindingsOf(item) : null;
      if (list) entries!.push({ at, id: item.id, list, reReport: isReReport(list.findings) });
    });
    reviewsCache.set(turn, entries);
  }
  return entries;
}

/** The chat's latest review card with findings to act on: its last review that is not a re-report. */
export function latestReviewId(turns: TurnLike[] | undefined): string | null {
  for (let t = (turns?.length ?? 0) - 1; t >= 0; t--) {
    const own = reviewsIn((turns as TurnLike[])[t]).filter((e) => !e.reReport);
    if (own.length) return own[own.length - 1].id;
  }
  return null;
}

/** Where the chat stands now: after the last item of its last turn. */
export function fixAnchorOf(turns: TurnLike[] | undefined): FixAnchor {
  const last = turns?.at(-1);
  return { turnId: last?.id ?? null, items: last?.items.length ?? 0 };
}

export interface ReviewState {
  level: string | null;
  intro: string;
  findings: ReviewFinding[];
  statuses: FindingStatus[];
}

/**
 * The fix turn, as Claude Code's app finds it: the turn holding the first message sent after the fix was asked (the
 * request itself, or one steered into the running turn). Its end settles the findings; a missing anchor (that part of
 * the chat was rewound) ends the fix without them.
 */
function fixTurn(turns: TurnLike[], anchor: FixAnchor): { ended: boolean; ok: boolean; reported: boolean } | null {
  const start = anchor.turnId === null ? 0 : turns.findIndex((t) => t.id === anchor.turnId);
  if (start < 0) return { ended: true, ok: false, reported: false };
  for (let t = start; t < turns.length; t++) {
    const from = anchor.turnId !== null && t === start ? anchor.items : 0;
    const asked = turns[t].items.findIndex((item, at) => at >= from && item.type === 'userMessage');
    if (asked < 0) continue;
    const turn = turns[t];
    return {
      ended: turn.status !== 'inProgress',
      ok: turn.status === 'completed',
      reported: reviewsIn(turn).some((e) => e.reReport && e.at > asked),
    };
  }
  return null;
}

/** A fix of some of a review's findings: where it was asked and which findings it asked for. */
interface FixAsk {
  /** null: marked fixing with no place it was asked */
  anchor: FixAnchor | null;
  indexes: number[];
}

/** A user message's text: its text parts, joined. */
const textOf = (item: ItemLike) =>
  (Array.isArray(item.content) ? (item.content as { type?: unknown; text?: unknown }[]) : [])
    .filter((c) => c?.type === 'text')
    .map((c) => String(c.text ?? ''))
    .join('\n');

// a turn's fix requests (their item and text), read once per turn object like its reviews
const requestsCache = new WeakMap<TurnLike, { at: number; text: string }[]>();
function requestsIn(turn: TurnLike): { at: number; text: string }[] {
  let found = requestsCache.get(turn);
  if (!found) {
    found = [];
    turn.items.forEach((item, at) => {
      const text = item.type === 'userMessage' ? textOf(item) : '';
      if (text && isFixRequest(text)) found!.push({ at, text });
    });
    requestsCache.set(turn, found);
  }
  return found;
}

/** A place in the turns: turn `t`, item `at`. */
type Spot = { t: number; at: number };
const before = (a: Spot, b: Spot) => a.t < b.t || (a.t === b.t && a.at < b.at);

/**
 * The fix requests in the turns after a review and before a newer one, in order: each message that asks for some of its
 * findings in a fix request's words, whoever sent it (a click on this window, another window, or main applying the
 * review on its own).
 */
function askedFixes(turns: TurnLike[], from: Spot, until: Spot | null, findings: ReviewFinding[]): FixAsk[] {
  const asks: FixAsk[] = [];
  for (let t = from.t; t < turns.length; t++)
    for (const { at, text } of requestsIn(turns[t])) {
      if (!before(from, { t, at }) || (until && !before({ t, at }, until))) continue;
      const indexes = fixRequestFindings(text, findings);
      if (indexes.length) asks.push({ anchor: { turnId: turns[t].id ?? null, items: at }, indexes });
    }
  return asks;
}

/** Where an anchor is in the turns: its turn's index (-1 before every turn, or when it was rewound) and item count. */
const placeOf = (turns: TurnLike[], anchor: FixAnchor) => ({
  t: anchor.turnId === null ? -1 : turns.findIndex((x) => x.id === anchor.turnId),
  items: anchor.items,
});

/** The review `reviewId` in the chat's turns with each finding's status, or null when the turns don't hold it. */
export function reviewState(turns: TurnLike[] | undefined, reviewId: string, marks?: ReviewMarks): ReviewState | null {
  const all = turns ?? [];
  let review: ReviewEntry['list'] | null = null;
  let from: Spot = { t: -1, at: -1 };
  let until: Spot | null = null;
  const reReports: { findings: ReviewFinding[]; t: number; at: number }[] = [];
  all.forEach((turn, t) => {
    for (const entry of reviewsIn(turn)) {
      if (entry.id === reviewId) {
        review = entry.list;
        from = { t, at: entry.at };
      }
      // outcomes and fixes answer the review they follow; a newer review's are not this one's
      else if (review && !entry.reReport) until ??= { t, at: entry.at };
      else if (review && !until) reReports.push({ findings: entry.list.findings, t, at: entry.at });
    }
  });
  if (!review) return null;
  const { level, intro, findings } = review as ReviewEntry['list'];
  const asks = askedFixes(all, from, until, findings);
  // a fix marked here whose message the turns don't hold yet (or that never went out); one marked with no anchor stays fixing
  const pending = marks?.fixAfter ?? null;
  const marked = Object.entries(marks?.status ?? {}).flatMap(([i, st]) => (st === 'fixing' ? [Number(i)] : []));
  const at = pending ? placeOf(all, pending) : null;
  const beforeAll = pending?.turnId === null;
  // its message arrived: a request at or after where it was asked (one asked in a rewound part never arrives)
  const reached =
    !!at &&
    asks.some(({ anchor }) => {
      const p = placeOf(all, anchor as FixAnchor);
      return beforeAll || (at.t >= 0 && (p.t > at.t || (p.t === at.t && p.items >= at.items)));
    });
  if (marked.length && !reached) asks.push({ anchor: pending, indexes: marked });
  const dismissed = Object.fromEntries(Object.entries(marks?.status ?? {}).filter(([, st]) => st === 'dismissed')) as Record<
    number,
    FindingStatus
  >;
  // each fix in turn: what the one before it left, then what it asked for, its re-reports and its turn's end
  let statuses = findingStatuses(findings, {
    stored: dismissed,
    reReports: reReports.map((r) => ({ findings: r.findings, afterFix: false })),
  });
  for (const { anchor, indexes } of asks) {
    const stored: Record<number, FindingStatus> = { ...Object.fromEntries(statuses.map((st, i) => [i, st])) };
    for (const i of indexes) if (stored[i] !== 'dismissed') stored[i] = 'fixing';
    const place = anchor && placeOf(all, anchor);
    // a re-report the fix may have asked for: one after where it was asked
    const afterFix = (t: number, item: number) =>
      !!anchor && (anchor.turnId === null || (!!place && place.t >= 0 && (t > place.t || (t === place.t && item >= place.items))));
    statuses = findingStatuses(findings, {
      stored,
      reReports: reReports.map((r) => ({ findings: r.findings, afterFix: afterFix(r.t, r.at) })),
      fix: anchor ? fixTurn(all, anchor) : null,
    });
  }
  return { level, intro, findings, statuses };
}
