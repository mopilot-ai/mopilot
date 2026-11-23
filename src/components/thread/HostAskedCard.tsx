// A question the agent on a machine asks (Codex request_user_input, Claude Code AskUserQuestion) drawn as the app's own question card and settled like a This Mac chat's: the card leaves at once, the answers stay in the transcript as the answered-questions record.
import { useEffect, useRef, useState } from 'react';
import type { AcpQuestion } from '../../../shared/acpForm.mjs';
import type { AskedQuestion } from '../../../shared/hostAsked.mjs';
import { answersNote } from '../../store/answersNote';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import type { QuestionResult } from '../../lib/answeredQuestions';
import { QuestionCard } from './QuestionCard';

export function HostAskedCard({
  question: q,
  asked,
  threadId,
  readOnly,
}: {
  question: AcpQuestion;
  asked: AskedQuestion[];
  threadId: string;
  readOnly: boolean;
}) {
  // the answer is on its way (or taken): the card is gone, as when a This Mac card is answered
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const given = useRef<QuestionResult | null>(null);
  const noted = useRef(false);
  useEffect(() => {
    // the machine could not take the answer: main put the question back to pending with the cause, so the card is back to answer again
    if (q.status === 'pending' && q.retried) setSent(false);
    if (q.status === 'answered' && given.current && !noted.current) {
      noted.current = true;
      answersNote(threadId, asked, given.current);
    }
  }, [q.status, q.retried, asked, threadId]);
  const answer = async (_id: number | string, result: QuestionResult) => {
    given.current = result;
    setSent(true);
    setError('');
    try {
      const done = await native.session.answerQuestion(threadId, q.id, {
        action: 'accept',
        // the card's answers by question (shared/hostAsked.mjs), which the form's typed values do not describe
        content: { answers: result.answers } as unknown as Record<string, string>,
      });
      if (done.status === 'pending' || done.status === 'failed' || done.status === 'retired') {
        setSent(false);
        setError(done.error ?? 'This question is no longer available.');
      }
    } catch (e) {
      setSent(false);
      setError(`Couldn't send your answer: ${errorText(e)}`);
    }
  };
  // a question the machine lost or could not deliver says so, as a card that failed always did
  if ((q.status === 'failed' || q.status === 'retired') && q.error) return <p role="alert">{q.error}</p>;
  if (q.status !== 'pending' || sent) return null;
  const why = error || q.error;
  return (
    <>
      <QuestionCard req={{ id: q.id, params: { questions: asked } }} agent={q.harness} onAnswer={answer} disabled={readOnly} />
      {why && <p role="alert">{why}</p>}
    </>
  );
}
