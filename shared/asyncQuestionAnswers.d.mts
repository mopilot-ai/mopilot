// Types for shared asynchronous question detection, history matching and delivery.
import type { AsyncUserInputQuestion } from '../src/protocol/v2/AsyncUserInputQuestion';
import type { ThreadItem } from '../src/protocol/v2/ThreadItem';
/** A reply that asks the user questions (at least one, so a reply without any never narrows to this). */
export type AsyncQuestionsItem = Extract<
  ThreadItem,
  {
    type: 'agentMessage';
  }
> & {
  questions: [AsyncUserInputQuestion, ...AsyncUserInputQuestion[]];
};
export declare const hasAsyncQuestions: (item: unknown) => item is AsyncQuestionsItem;
/** No answer is sent until the user explicitly supplies one for every question. */
export declare const asyncAnswersReady: (questions: AsyncUserInputQuestion[], answers: Record<number, string>) => boolean;
export declare function sendAsyncAnswers(
  questions: AsyncUserInputQuestion[],
  answers: Record<number, string>,
  send: (text: string) => Promise<unknown>,
): Promise<void>;
/**
 * Recover submissions from history, including replies sent by another client or in a later turn. Each turn's
 * share is kept by turn object and the questions waiting before it, so a delta recomputes only its own turn.
 */
export declare function submittedAsyncAnswers(
  turns: {
    items: ThreadItem[];
  }[],
): Map<string, Record<number, string>>;
