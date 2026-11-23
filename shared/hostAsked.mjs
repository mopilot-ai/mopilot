// The questions a chat's agent asks on a Host (Codex request_user_input, Claude Code AskUserQuestion) in the shape This Mac's question card draws, and the answers that card gives back; both bounded, carried as `asked` on the Host's question and `content.answers` on the app's answer.
const MAX_QUESTIONS = 16;
const MAX_OPTIONS = 32;
const MAX_ANSWERS = 32;
const MAX_TEXT = 4096;

const isObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (/** @type {unknown} */ v) => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '');

/**
 * The questions as the card reads them: an id, the question, an optional header, its options, whether several may be picked, whether the person may answer in their own words (every question may unless it says not), and whether the answer is a secret. Questions without an id or text are left out.
 * @param {unknown} questions
 * @returns {{ id: string, question: string, header: string | null, options: { label: string, description?: string }[], multiSelect: boolean, isOther: boolean, isSecret: boolean }[]}
 */
export function askedQuestions(questions) {
  if (!Array.isArray(questions)) return [];
  return questions
    .filter((q) => isObject(q) && q.id != null && text(q.question).trim())
    .slice(0, MAX_QUESTIONS)
    .map((q) => ({
      id: String(q.id).slice(0, 128),
      question: text(q.question),
      header: text(q.header).trim() ? text(q.header) : null,
      options: (Array.isArray(q.options) ? q.options : [])
        .filter((/** @type {any} */ o) => isObject(o) && text(o.label).trim())
        .slice(0, MAX_OPTIONS)
        .map((/** @type {any} */ o) => ({
          label: text(o.label),
          ...(text(o.description).trim() ? { description: text(o.description) } : {}),
        })),
      multiSelect: q.multiSelect === true,
      isOther: q.isOther !== false,
      isSecret: q.isSecret === true,
    }));
}

/**
 * What the person answered, by question id, as the card sends it (`content.answers`): only the asked questions, each a short list of texts. Null when the answer carries none.
 * @param {{ id: string }[]} asked @param {unknown} content
 * @returns {Record<string, { answers: string[] }> | null}
 */
export function askedAnswers(asked, content) {
  const given = isObject(content) ? content.answers : null;
  if (!isObject(given)) return null;
  /** @type {Record<string, { answers: string[] }>} */
  const out = {};
  for (const q of asked) {
    const entry = given[q.id];
    const list = isObject(entry) && Array.isArray(entry.answers) ? entry.answers : null;
    if (list)
      out[q.id] = {
        answers: list
          .filter((a) => typeof a === 'string')
          .slice(0, MAX_ANSWERS)
          .map((a) => a.slice(0, MAX_TEXT)),
      };
  }
  return Object.keys(out).length ? out : null;
}
