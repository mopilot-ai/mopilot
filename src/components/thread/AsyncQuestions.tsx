// Async chat questions use the shared question card and preserve retryable delivery and answered history; unanswered, the latest wait docked where the composer is.

import { useId, useRef, useState } from 'react';
import type { AsyncUserInputQuestion } from '../../protocol/v2/AsyncUserInputQuestion';
import { unanswered, type QuestionResult } from '../../lib/answeredQuestions';
import { chatProxy } from '../../harness/adapters/proxy';
import { useSession } from '../../store/session/useSession';
import { sendAsyncAnswers } from '../../lib/asyncQuestions';
import { errorText } from '../../lib/ignored';
import { QuestionCard } from './QuestionCard';
import { AnsweredQuestions } from './AnsweredQuestions';

type Props = {
  questions: AsyncUserInputQuestion[];
  threadId: string;
  cwd: string;
  readOnly: boolean;
  submittedAnswers?: Record<number, string>;
  /** docked above the composer: it takes the window's keys, and once sent it leaves for the transcript's summary */
  docked?: boolean;
};

export function AsyncQuestions(props: Props) {
  // A reused view must not carry drafts, pending delivery or completion into another chat/question.
  return <AsyncQuestionState key={JSON.stringify([props.threadId, props.questions])} {...props} />;
}

function AsyncQuestionState({ questions, threadId, readOnly, submittedAnswers, docked = false }: Props) {
  const session = useSession(threadId);
  const formId = useId();
  const busy = useRef(false);
  const [sending, setSending] = useState(false);
  const [sentAnswers, setSent] = useState<Record<number, string> | null>(null);
  const [error, setError] = useState('');
  const answers = submittedAnswers ?? sentAnswers;
  const disabled = readOnly || session.runningElsewhere || sending || !!answers;
  const submit = async (result: QuestionResult) => {
    if (disabled || busy.current) return;
    busy.current = true;
    setSending(true);
    setError('');
    // the card always answers every question (a skipped one with its own words), so none goes out blank
    const values = Object.fromEntries(questions.map((_, i) => [i, result.answers[String(i)].answers.join(', ')]));
    try {
      // Steer the current turn, or start the next one if it has ended; failures leave the card's draft intact.
      await sendAsyncAnswers(questions, values, (text) => chatProxy.send(threadId, text, [], { human: true }, 'steer'));
      setSent(values);
    } catch (e) {
      setError(`Couldn't send: ${errorText(e)}`);
    } finally {
      busy.current = false;
      setSending(false);
    }
  };
  if (answers)
    return docked ? null : (
      <AnsweredQuestions
        answers={questions.map((q, i) => {
          const none = unanswered(answers[i]) ?? (answers[i] === 'Skipped' ? 'skipped' : null);
          return { question: q.title, answer: none ? null : answers[i], ...(none === 'dismissed' ? { dismissed: true } : {}) };
        })}
      />
    );
  return (
    <div className={docked ? 'async-questions docked' : 'async-questions'}>
      <QuestionCard
        req={{
          id: formId,
          params: {
            questions: questions.map((q, i) => ({
              id: String(i),
              question: q.title,
              options: q.options?.map((label) => ({ label })),
            })),
          },
        }}
        agent="Agent"
        disabled={disabled}
        sendLabel={sending ? 'Sending…' : undefined}
        ownKeysOnly={!docked}
        onAnswer={(_id, result) => void submit(result)}
      />
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
