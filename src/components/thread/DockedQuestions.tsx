// The agent's latest unanswered questions docked above the composer, as Claude Code docks its question card.
import type { AsyncQuestionsItem } from '../../lib/asyncQuestions';
import { AsyncQuestions } from './AsyncQuestions';

export function DockedQuestions({ threadId, cwd, item }: { threadId: string; cwd: string; item: AsyncQuestionsItem }) {
  return (
    <div className="approval-stack docked-questions">
      <AsyncQuestions key={item.id} questions={item.questions} threadId={threadId} cwd={cwd} readOnly={false} docked />
    </div>
  );
}
