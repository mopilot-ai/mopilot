// Claude Code's `AskUserQuestion` tool as the form card the app already draws: its questions (a header, the question, options, one or several) become one form, and the person's values go back as the tool's own `answers` (question text -> chosen label, several joined by a comma) in the allowed call's input.
import { USER_INPUT, askOf } from './codexAsk.mjs';
import { claudeAnswer } from '../../shared/claudeAnswer.mjs';
import { askedAnswers } from '../../shared/hostAsked.mjs';

/** The form an AskUserQuestion call makes, or null when its input is not questions this Host can draw. @param {any} input */
export function claudeQuestionsOf(input) {
  if (!Array.isArray(input?.questions)) return null;
  const questions = input.questions.map((/** @type {any} */ q, /** @type {number} */ i) => ({ ...q, id: `q${i}` }));
  const ask = askOf(USER_INPUT, { questions });
  return ask?.form ? { form: ask.form, said: 'A question for you', questions, asked: /** @type {any[]} */ (ask.asked) } : null;
}

/**
 * The tool's input with the person's answers in it. @param {any} input @param {{ id: string, question?: string }[]} questions @param {Record<string, unknown>} values
 */
export function withAnswers(input, questions, values) {
  const answers = Object.fromEntries(
    questions.map((q) => {
      const v = values[q.id];
      return [String(q.question ?? q.id), Array.isArray(v) ? v.join(', ') : String(v)];
    }),
  );
  return { ...input, answers };
}

/**
 * The tool's reply when This Mac's card answered in its own words: its answers by question, as the tool takes them; null when the answer carries none.
 * @param {any} input @param {{ id: string }[]} asked the questions as asked, in the tool's order @param {unknown} content
 */
export function claudeAskedReply(input, asked, content) {
  const given = askedAnswers(asked, content);
  if (!given) return null;
  // by the question's own place in the tool's input (its id is `q<index>`): a question left out of `asked` (no text) does not shift the others
  return claudeAnswer('item/tool/requestUserInput', input, {
    answers: Object.fromEntries(asked.flatMap((q) => (/^q\d+$/.test(q.id) && given[q.id] ? [[q.id.slice(1), given[q.id]]] : []))),
  });
}
