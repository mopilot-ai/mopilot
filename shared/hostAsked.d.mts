// Types of shared/hostAsked.mjs.
export interface AskedQuestion {
  id: string;
  question: string;
  header: string | null;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
  isOther: boolean;
  isSecret: boolean;
}
export function askedQuestions(questions: unknown): AskedQuestion[];
export function askedAnswers(asked: { id: string }[], content: unknown): Record<string, { answers: string[] }> | null;
