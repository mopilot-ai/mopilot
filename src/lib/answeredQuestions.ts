// What a question card was answered with, as the transcript keeps it: each question and the answer given (or none).
import type { AnsweredQuestion } from '../../shared/model/requests';
export type { AnsweredQuestion } from '../../shared/model/requests';

/*
 * What a question card answers with when the user gives no answer, word for word as Claude Code's own card (the
 * Claude desktop app's Code tab) sends them: the agent reads them as the answer, so each says what to do next. Every
 * harness's card sends the same words.
 */
/** Skip on one question. */
export const NO_PREFERENCE = '[No preference]';
/** The card dismissed: every question. */
export const DISMISSED_ANSWER = '[User dismissed — do not proceed, wait for next instruction]';
/** "Other" picked with nothing typed. */
export const OTHER_UNTYPED = 'Something else';

/** The questions a card asked (Codex's request_user_input, Claude's AskUserQuestion, through QuestionCard). */
export interface AskedQuestion {
  id: string;
  question: string;
  /** a password or token: what was typed is never kept, only that it was given */
  isSecret?: boolean;
}

/** What a secret answer reads as in the transcript and the chat's file. */
export const HIDDEN_ANSWER = 'Hidden';

/** The card's answer: each question's chosen options and written text, by question id. */
export type QuestionResult = { answers: Record<string, { answers: string[] }> };

/** A given answer that stands for none: skipped (blank too) or dismissed, else null. */
export function unanswered(answer: string | null | undefined): 'skipped' | 'dismissed' | null {
  const a = answer?.trim();
  if (!a || a === NO_PREFERENCE) return 'skipped';
  return a === DISMISSED_ANSWER ? 'dismissed' : null;
}

/**
 * Each asked question paired with what was answered, in the order asked. Several choices read as one list; a
 * question left blank or skipped reads as skipped, and a dismissed card as dismissed; a secret answer is kept only
 * as given, never its text. Questions without text are left out.
 */
export function answeredQuestions(questions: readonly AskedQuestion[], result: QuestionResult): AnsweredQuestion[] {
  return questions
    .filter((q) => q.question?.trim())
    .map((q) => {
      const given = (Object.hasOwn(result.answers, q.id) ? result.answers[q.id].answers : []).map((a) => a.trim()).filter(Boolean);
      const none = given.length > 1 ? null : unanswered(given[0]);
      if (none) return { question: q.question.trim(), answer: null, ...(none === 'dismissed' ? { dismissed: true } : {}) };
      return { question: q.question.trim(), answer: q.isSecret ? HIDDEN_ANSWER : given.join(', ') };
    });
}

/** The note's text where only words fit (search, a plain export): how many were answered. */
export function answeredSummary(answered: readonly AnsweredQuestion[]): string {
  const n = answered.filter((a) => a.answer !== null).length;
  if (!n && answered.some((a) => a.dismissed)) return answered.length === 1 ? 'Dismissed a question' : 'Dismissed the questions';
  if (!n) return answered.length === 1 ? 'Skipped a question' : 'Skipped the questions';
  return n === 1 ? 'Answered a question' : `Answered ${n} questions`;
}
