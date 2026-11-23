// The answered-questions card in the transcript: each question an agent asked and what was answered, as Claude Code shows it.
import type { AnsweredQuestion } from '../../lib/answeredQuestions';
import { withKeys } from '../../lib/listKeys';

export function AnsweredQuestions({ answers }: { answers: readonly AnsweredQuestion[] }) {
  return (
    <div className="answered-card" role="group" aria-label="Answered questions">
      {withKeys(answers, (a) => a.question).map(({ key, item: a }) => (
        <div key={key} className="answered-row">
          <div className="answered-question">{a.question}</div>
          <div className={`answered-answer ${a.answer === null ? 'skipped' : ''}`}>
            {a.answer ?? (a.dismissed ? 'Dismissed' : 'Skipped')}
          </div>
        </div>
      ))}
    </div>
  );
}
