// The answer a person gives to a form card (a question an agent asks), as `chat.answer` carries it: an action and, for an accept, the values. Bounded here; the Host checks the values against the form it asked.
import { SchemaError } from '../remote/schema.mjs';
/** A form's answer: an action and, for an accept, the values (bounded; the Host checks them against its own form). @param {any} v */
export function formAnswerOf(v) {
  if (typeof v !== 'object' || v === null || Array.isArray(v) || !['accept', 'decline', 'cancel'].includes(v.action))
    throw new SchemaError('That form answer is not one this host reads.');
  if (v.content != null && (typeof v.content !== 'object' || Array.isArray(v.content) || JSON.stringify(v.content).length > 64_000))
    throw new SchemaError('That form answer is too large or not a set of values.');
  return { action: v.action, ...(v.content == null ? {} : { content: v.content }) };
}
