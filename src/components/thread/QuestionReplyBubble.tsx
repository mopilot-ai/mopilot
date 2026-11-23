// The answer bubble that keeps its question's context.

import type { ReactNode } from 'react';

/** Question context stays inside the answer bubble, with the full title available on hover. */
export function QuestionReplyBubble({ question, children }: { question: string; children: ReactNode }) {
  return (
    <div className="user-bubble question-reply-bubble">
      <div className="question-reply-summary" title={question}>
        {question}
      </div>
      {children}
    </div>
  );
}
