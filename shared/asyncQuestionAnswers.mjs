// Shared detection, history matching and delivery text for asynchronous questions, used by the app and Chrome panel.
const hasAsyncQuestions = (item) =>
  !!item &&
  item.type === 'agentMessage' &&
  Array.isArray(item.questions) &&
  item.questions.length > 0 &&
  item.questions.every(
    (q) =>
      q &&
      typeof q.title === 'string' &&
      (q.options == null || (Array.isArray(q.options) && q.options.every((option) => typeof option === 'string'))),
  );
const asyncAnswersReady = (questions, answers) => questions.length > 0 && questions.every((_, i) => !!answers[i]?.trim());
async function sendAsyncAnswers(questions, answers, send) {
  if (!asyncAnswersReady(questions, answers)) throw new Error('Answer every question before sending');
  await send(
    questions
      .map(
        (q, i) => `${q.title}
${answers[i].trim()}`,
      )
      .join('\n\n'),
  );
}
const answerSteps = /* @__PURE__ */ new WeakMap();
const NO_PENDING = [];
function submittedAsyncAnswers(turns) {
  const submitted = /* @__PURE__ */ new Map();
  let pending = NO_PENDING;
  for (const turn of turns) {
    let step = answerSteps.get(turn);
    if (step?.before !== pending) answerSteps.set(turn, (step = answerStep(turn.items ?? [], pending)));
    for (const [id, answers] of step.submitted) submitted.set(id, answers);
    pending = step.after;
  }
  return submitted;
}
function answerStep(items, before) {
  const pending = [...before];
  const submitted = [];
  for (const item of items) {
    if (hasAsyncQuestions(item)) {
      pending.push({ id: item.id, questions: item.questions });
    } else if (item.type === 'userMessage') {
      const text = item.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
        .trim();
      for (let p = pending.length - 1; p >= 0; p--) {
        const { id, questions } = pending[p];
        const answers = {};
        let remaining = text;
        let matches = true;
        for (let i = 0; i < questions.length; i++) {
          const prefix = `${questions[i].title}
`;
          if (!remaining.startsWith(prefix)) {
            matches = false;
            break;
          }
          remaining = remaining.slice(prefix.length);
          const end =
            i + 1 < questions.length
              ? remaining.indexOf(`

${questions[i + 1].title}
`)
              : remaining.length;
          if (end < 0) {
            matches = false;
            break;
          }
          answers[i] = remaining.slice(0, end).trim();
          remaining = remaining.slice(end + 2);
        }
        if (matches && asyncAnswersReady(questions, answers)) {
          submitted.push([id, answers]);
          pending.splice(p, 1);
          break;
        }
      }
    }
  }
  return { before, after: pending, submitted };
}
export { asyncAnswersReady, hasAsyncQuestions, sendAsyncAnswers, submittedAsyncAnswers };
