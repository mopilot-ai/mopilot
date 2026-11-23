// What Codex asks a person besides an approval (its `item/tool/requestUserInput` questions and an MCP server's `mcpServer/elicitation/request`), as the form card the app already draws, and the answer each takes back. Pure: a request in, a form out; a card and the person's answer in, the app-server's reply out.
import { parseAcpForm, validateAcpAnswer } from '../../shared/acpForm.mjs';
import { elicitationAnswer } from '../../shared/elicitation.mjs';
import { askedAnswers, askedQuestions } from '../../shared/hostAsked.mjs';

export const USER_INPUT = 'item/tool/requestUserInput';
export const ELICITATION = 'mcpServer/elicitation/request';
/** The requests this module can put to a person. @param {string} method */
export const isAsk = (method) => method === USER_INPUT || method === ELICITATION;

/** The answers a sign-in link's card offers: the person opened it and came back, or did not. */
export const LINK_OPTIONS = Object.freeze([
  { optionId: 'done', name: 'I opened it', kind: 'allow_once' },
  { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
]);

const isObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (/** @type {unknown} */ v) => (typeof v === 'string' && v.trim() ? v.trim() : '');

/** A questions list as the schema of one form: a choice is a menu of its options (one, or several), a free question a line of text. @param {any[]} questions */
function schemaOfQuestions(questions) {
  /** @type {Record<string, any>} */
  const properties = {};
  for (const q of questions) {
    const title = text(q?.header) || text(q?.question);
    const options = (Array.isArray(q?.options) ? q.options : []).map((/** @type {any} */ o) => text(o?.label)).filter(Boolean);
    const base = { title, ...(text(q?.header) && text(q?.question) ? { description: text(q.question) } : {}) };
    properties[String(q.id)] = !options.length
      ? { ...base, type: 'string', maxLength: 2000 }
      : q.multiSelect === true
        ? { ...base, type: 'array', items: { type: 'string', enum: options } }
        : { ...base, type: 'string', enum: options };
  }
  return { type: 'object', properties, required: questions.map((/** @type {any} */ q) => String(q.id)) };
}

/**
 * The card a request makes: a form (`form`, drawn as a question), a link to show (`link`), or null when this Host cannot ask it (a form it cannot draw, an approval for the computer or a browser this machine does not have).
 * @param {string} method @param {any} p
 * @returns {{ said: string, form?: import('../../shared/acpForm.mjs').AcpForm, link?: string | null, questions?: any[], asked?: import('../../shared/hostAsked.mjs').AskedQuestion[] } | null}
 */
export function askOf(method, p) {
  try {
    if (method === USER_INPUT) {
      const questions = Array.isArray(p?.questions) ? p.questions.filter((/** @type {any} */ q) => isObject(q) && q.id != null) : [];
      if (!questions.length) return null;
      const said = 'A question for you';
      return { said, questions, asked: askedQuestions(questions), form: parseAcpForm(schemaOfQuestions(questions), said) };
    }
    const said = text(p?.message) || `${text(p?.serverName) || 'A tool'} needs input`;
    if (p?.mode === 'url') return { said, link: typeof p.url === 'string' ? p.url : null };
    return { said, form: parseAcpForm(p?.requestedSchema, said) };
  } catch {
    return null;
  }
}

/** What each kind of request is told when the person cannot be asked, or declines. @param {string} method */
export const unanswered = (method) => (method === USER_INPUT ? { answers: {} } : elicitationAnswer('decline', null, 'form'));

/**
 * The app-server's reply to a card from the person's answer: a form's values checked against the form that was asked (anything that does not fit declines), a link's "I opened it" accepts.
 * @param {{ method: string, ask: NonNullable<ReturnType<typeof askOf>> }} card
 * @param {{ optionId?: string, form?: any }} given
 */
export function replyOf({ method, ask }, { optionId, form }) {
  if (ask.form === undefined) return elicitationAnswer(optionId === 'done' ? 'accept' : 'cancel', null, 'url');
  // a question This Mac's card draws is answered in its own words (an off-list answer, a skip): the card's answers go to the agent as they are
  if (method === USER_INPUT && ask.asked?.length && form?.action === 'accept') {
    const own = askedAnswers(ask.asked, form.content);
    if (own) return { answers: own };
  }
  /** @type {{ action: 'accept' | 'decline' | 'cancel', content?: any }} */
  let answer;
  try {
    answer = validateAcpAnswer(ask.form, form);
  } catch {
    return unanswered(method);
  }
  if (method === ELICITATION) return elicitationAnswer(answer.action, answer.content ?? null, 'form');
  if (answer.action !== 'accept') return { answers: {} };
  const values = answer.content;
  return {
    answers: Object.fromEntries(
      /** @type {any[]} */ (ask.questions).map((q) => {
        const v = values[String(q.id)];
        return [String(q.id), { answers: Array.isArray(v) ? v : [v] }];
      }),
    ),
  };
}
