// Acting on a review's findings: asking the chat to fix them, running the review again, and walking them in the Changes pane. @store-slice: tests' store stub replaces it whole (tests/support/stubs.ts).
import { applyFixesRequest, type ReviewFinding } from '../../shared/reviewFindings.mjs';
import { HARNESS_TRAITS } from '../harness/family';
import { fixAnchorOf, type ReviewMarks } from '../lib/reviewState';
import { get, set } from './core';
import { chatFamily } from './chats';
import { sendOrDraft } from './send';
import { openChanges } from './panes';
import { startReview } from './actions';
import { answerReviewRequest, type PrRef } from '../lib/prReviewThreads';

const marksOf = (chatId: string, reviewId: string): ReviewMarks => get().reviewMarks[chatId]?.[reviewId] ?? { status: {} };
function setMarks(chatId: string, reviewId: string, fn: (m: ReviewMarks) => ReviewMarks) {
  set((s) => ({
    reviewMarks: { ...s.reviewMarks, [chatId]: { ...s.reviewMarks[chatId], [reviewId]: fn(marksOf(chatId, reviewId)) } },
  }));
}

/** Findings no longer fixing: their fix request didn't go out. */
export function reopenFindings(chatId: string, reviewId: string, indexes: number[]) {
  setMarks(chatId, reviewId, (m) => ({
    ...m,
    status: Object.fromEntries(Object.entries(m.status).filter(([i, st]) => !(st === 'fixing' && indexes.includes(Number(i))))),
  }));
}

/**
 * Ask the chat to fix findings ("Apply fixes", "Fix this one"): they show as fixing until the fix turn ends or reports
 * their outcomes. A request main didn't take waits in the composer and the findings open again.
 */
export function askFixes(chatId: string, reviewId: string, findings: ReviewFinding[], indexes: number[]) {
  if (!indexes.length) return;
  const fixAfter = fixAnchorOf(get().runtime[chatId]?.turns);
  setMarks(chatId, reviewId, (m) => ({
    ...m,
    fixAfter,
    status: { ...m.status, ...Object.fromEntries(indexes.map((i) => [i, 'fixing' as const])) },
  }));
  const text = applyFixesRequest(
    indexes.map((i) => findings[i]),
    { reportTool: HARNESS_TRAITS[chatFamily(chatId)].reportsFindings },
  );
  // sendOrDraft resolves false for any request main didn't take, having said why
  void sendOrDraft(chatId, text, { human: true }).then((sent) => {
    if (sent === false) reopenFindings(chatId, reviewId, indexes);
  });
}

/** "Answer review comments" in the Changes pane: the chat is asked to address the PR's unresolved review comments. */
export function answerReviewComments(chatId: string, pr: PrRef) {
  void sendOrDraft(chatId, answerReviewRequest(pr), { human: true });
}

/**
 * "Re-run review": the harness's own review again, at the level it ran at (Claude Code), or on the target the chat's
 * last review had (the working tree when it had none).
 */
export function rerunReview(chatId: string, level: string | null) {
  if (HARNESS_TRAITS[chatFamily(chatId)].reportsFindings)
    void sendOrDraft(chatId, level ? `/code-review ${level}` : '/code-review', { human: true });
  else void startReview(chatId, get().reviewTargets[chatId] ?? { type: 'uncommittedChanges' });
}

/** Show a review's findings in the Changes pane, with `current` in focus. */
export function openFindingsWalk(chatId: string, reviewId: string, current: number, scope: string) {
  openChanges({ scope, walk: { chatId, reviewId, current } });
}

/**
 * A walk whose scope lacks a finding's file (fixes committed since an uncommitted-changes review) moves to Branch, which
 * holds every change on the branch: once, so the user's own pick of a scope stays.
 */
export function widenFindingsWalk() {
  const s = get();
  const walk = s.diffPanel.walk;
  if (walk && !walk.settled) set({ diffPanel: { ...s.diffPanel, scope: 'branch', walk: { ...walk, settled: true } } });
}

/** Put the findings walk away: the Changes pane shows its diff alone again. Another chat's walk stays. */
export function closeFindingsWalk(chatId: string) {
  const s = get();
  if (s.diffPanel.walk?.chatId === chatId) set({ diffPanel: { ...s.diffPanel, walk: undefined } });
}

/** Put another finding in focus in the Changes pane. */
export function focusFinding(current: number) {
  const s = get();
  const walk = s.diffPanel.walk;
  if (walk) set({ diffPanel: { ...s.diffPanel, walk: { ...walk, current } } });
}

/** Dismiss a finding in the diff: it leaves the pane and its row reads Dismissed. */
export function dismissFinding(chatId: string, reviewId: string, index: number) {
  setMarks(chatId, reviewId, (m) => ({ ...m, status: { ...m.status, [index]: 'dismissed' } }));
}

/** Which findings' files have no changes in the pane's diff, for the rows' "Not in the current diff". */
export function setUnanchored(chatId: string, reviewId: string, indexes: number[]) {
  const before = marksOf(chatId, reviewId).unanchored ?? [];
  if (before.length === indexes.length && before.every((i, n) => i === indexes[n])) return;
  setMarks(chatId, reviewId, (m) => ({ ...m, unanchored: indexes }));
}
