// The triage evaluation: loads the 62 labelled mails, runs the pre-checks and the reading turn on each, summarises misses and over-alerts, and gates a change on the numbers.
import { assertFreshIds } from '../envelope.ts';
import { preCheck } from '../preChecks.ts';
import { readItem, type Person } from '../reading.ts';
import type { MailMessage, ReaderModel, Verdict } from '../types.d.ts';

/*
 * The 62 invented mails in triage-62.jsonl come from OpenDuet (CopilotKit/openduet, evals/triage/emails.jsonl, MIT License,
 * Copyright (c) 2026 CopilotKit), re-labelled from needs_you / can_wait to tell_now / track / quiet by us; the runner follows the
 * shape of its evals/triage/run.ts. Notices are in ../THIRD_PARTY.md. The set's README calls it a regression check, not
 * proof of accuracy on a real inbox; a person's own labelled mail is the next set.
 */

export type EvalCase = { id: string; expected: Verdict; openduetLabel: string; why: string; hard: boolean; mail: MailMessage };

/** The person and the morning the set was written for. */
export const EVAL_PERSON: Person = {
  name: 'Maya Okafor',
  email: 'maya@marlowceramics.com',
  about: 'Runs Marlow Ceramics, a small studio that makes mugs and tableware for shops such as Hearth & Co.',
};
export const EVAL_NOW = new Date('2026-10-22T07:30:00-07:00');

/** Parses the JSONL text; throws on a line that is not an eval case, on a repeated id, or (when `count` is given) on a different number of cases, so a broken set cannot pass as a small one. */
export function loadTriageSet(text: string, count?: number): EvalCase[] {
  const cases = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      const value = JSON.parse(line) as EvalCase;
      if (!['tell_now', 'track', 'quiet'].includes(value.expected) || typeof value.mail?.body !== 'string')
        throw new Error(`Line ${index + 1} is not an eval case.`);
      return value;
    });
  if (new Set(cases.map((c) => c.id)).size !== cases.length) throw new Error('The set repeats an id.');
  if (count !== undefined && cases.length !== count) throw new Error(`The set has ${cases.length} cases, not ${count}.`);
  return cases;
}

export type VerdictLine = {
  id: string;
  expected: Verdict;
  got: Verdict | 'unsorted' | 'needs_model';
  decidedBy: string;
  reason: string;
  /** Right: the same verdict. In a pre-check run, "needs_model" is right unless the mail should not be quiet-only... see `checkLine`. */
  ok: boolean;
  hard: boolean;
};

/** Pre-checks only: each mail is either quiet by a rule or left for the model. A rule may never silence mail that is not expected to be quiet. */
export function runPreCheckEval(cases: EvalCase[]): VerdictLine[] {
  return cases.map((c) => {
    const pre = preCheck(c.mail);
    return pre
      ? {
          id: c.id,
          expected: c.expected,
          got: 'quiet',
          decidedBy: pre.decidedBy,
          reason: pre.reason,
          ok: c.expected === 'quiet',
          hard: c.hard,
        }
      : {
          id: c.id,
          expected: c.expected,
          got: 'needs_model',
          decidedBy: 'none',
          reason: 'No rule applies; the reading turn decides.',
          ok: true,
          hard: c.hard,
        };
  });
}

/** The full triage: pre-checks first, then the model for what they leave. A model failure is `unsorted` and never counts as right. */
export async function runTriageEval(cases: EvalCase[], deps: { model: ReaderModel; randomId: () => string }): Promise<VerdictLine[]> {
  assertFreshIds(deps.randomId);
  const lines: VerdictLine[] = [];
  for (const c of cases) {
    const pre = preCheck(c.mail);
    if (pre) {
      lines.push({
        id: c.id,
        expected: c.expected,
        got: 'quiet',
        decidedBy: pre.decidedBy,
        reason: pre.reason,
        ok: c.expected === 'quiet',
        hard: c.hard,
      });
      continue;
    }
    const reading = await readItem(
      { kind: 'mail', mail: c.mail },
      { model: deps.model, person: EVAL_PERSON, now: EVAL_NOW, randomId: deps.randomId },
    );
    lines.push(
      reading.ok
        ? {
            id: c.id,
            expected: c.expected,
            got: reading.answer.verdict,
            decidedBy: reading.decidedBy,
            reason: reading.answer.reason,
            ok: reading.answer.verdict === c.expected,
            hard: c.hard,
          }
        : {
            id: c.id,
            expected: c.expected,
            got: 'unsorted',
            decidedBy: `model:${deps.model.name}`,
            reason: reading.error,
            ok: false,
            hard: c.hard,
          },
    );
  }
  return lines;
}

export type Summary = {
  total: number;
  correct: number;
  accuracy: number;
  /** Expected tell_now or track, answered quiet: something that mattered was silenced. */
  missed: string[];
  /** Expected quiet, answered tell_now: a push the user did not need. */
  overAlerts: string[];
  unsorted: string[];
  byRule: number;
  /** Hard cases that are not right. */
  hardFailed: string[];
};

export function summarize(lines: VerdictLine[]): Summary {
  const ids = (pick: (line: VerdictLine) => boolean) => lines.filter(pick).map((line) => line.id);
  const correct = lines.filter((line) => line.ok).length;
  return {
    total: lines.length,
    correct,
    accuracy: lines.length ? correct / lines.length : 0,
    missed: ids((l) => l.expected !== 'quiet' && l.got === 'quiet'),
    overAlerts: ids((l) => l.expected === 'quiet' && l.got === 'tell_now'),
    unsorted: ids((l) => l.got === 'unsorted'),
    byRule: lines.filter((l) => l.decidedBy.startsWith('rule:')).length,
    hardFailed: ids((l) => l.hard && !l.ok),
  };
}

export type VerdictScore = { expected: number; answered: number; right: number; precision: number | null; recall: number | null };

/** Precision and recall of each verdict: of the mails answered X, how many were X; of the mails that were X, how many were answered X. Null when none was answered (precision) or expected (recall). */
export function verdictScores(lines: VerdictLine[]): Record<Verdict, VerdictScore> {
  const score = (verdict: Verdict): VerdictScore => {
    const expected = lines.filter((l) => l.expected === verdict).length;
    const answered = lines.filter((l) => l.got === verdict).length;
    const right = lines.filter((l) => l.expected === verdict && l.got === verdict).length;
    return { expected, answered, right, precision: answered ? right / answered : null, recall: expected ? right / expected : null };
  };
  return { tell_now: score('tell_now'), track: score('track'), quiet: score('quiet') };
}

export type GateLimits = { accuracyMin: number; missedMax: number; overAlertsMax: number; unsortedMax: number };

/** Proposed limits for a model run (not yet measured on a real model): nothing that matters may be silenced. */
export const MODEL_GATE: GateLimits = { accuracyMin: 0.85, missedMax: 0, overAlertsMax: 2, unsortedMax: 0 };
/** The pre-check run has no model: it only has to silence nothing that matters. */
export const PRECHECK_GATE: GateLimits = { accuracyMin: 1, missedMax: 0, overAlertsMax: 0, unsortedMax: 0 };

/** Whether a run may pass: the failures it would block on, in words. Empty means the gate is open. */
export function gate(summary: Summary, limits: GateLimits, baselineHardPassed: string[] = []): string[] {
  const failures: string[] = [];
  if (summary.accuracy < limits.accuracyMin) failures.push(`Accuracy ${summary.accuracy.toFixed(3)} is below ${limits.accuracyMin}.`);
  if (summary.missed.length > limits.missedMax) failures.push(`Silenced mail that matters: ${summary.missed.join(', ')}.`);
  if (summary.overAlerts.length > limits.overAlertsMax) failures.push(`Too many pushes for quiet mail: ${summary.overAlerts.join(', ')}.`);
  if (summary.unsorted.length > limits.unsortedMax) failures.push(`Could not be sorted: ${summary.unsorted.join(', ')}.`);
  const regressed = baselineHardPassed.filter((id) => summary.hardFailed.includes(id));
  if (regressed.length) failures.push(`Hard cases that passed before now fail: ${regressed.join(', ')}.`);
  return failures;
}

/** One JSON line per verdict, so a person can read what changed. */
export const toJsonl = (lines: unknown[]): string => lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
