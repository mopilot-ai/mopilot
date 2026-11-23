// Validates a panel's question or MCP form values against the live request, returning only its protocol's answer shape.
const { elicitationAnswer } = require('../../../shared/elicitation.mjs');
const { offersOther } = require('../../../shared/questionOptions.mjs');
const record = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const invalid = (name) => {
  throw new Error(`Check the answer for ${name}.`);
};

/** MCP's titled enum variants share one normalized representation for display and validation. */
function formSchema(schema, depth = 0) {
  if (!record(schema) || depth > 8) return schema;
  const out = { ...schema };
  const choices = Array.isArray(schema.oneOf) ? schema.oneOf : schema.anyOf;
  if (Array.isArray(choices) && choices.length && choices.every((c) => record(c) && Object.hasOwn(c, 'const'))) {
    out.enum = choices.map((c) => c.const);
    out.enumLabels = choices.map((c) => c.title ?? String(c.const));
  } else if (Array.isArray(schema.enumNames)) out.enumLabels = schema.enumNames;
  if (record(schema.properties))
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, formSchema(value, depth + 1)]));
  if (schema.items) out.items = formSchema(schema.items, depth + 1);
  return out;
}

/** JSON form constraints stay at main's boundary, including nested values entered through a JSON field. */
function validate(schema, value, name = 'this form', depth = 0) {
  if (!record(schema) || depth > 8) return invalid(name);
  if (schema.enum && (!Array.isArray(schema.enum) || !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value)))) invalid(name);
  if (Array.isArray(schema.type)) {
    let last;
    for (const type of schema.type) {
      try {
        validate({ ...schema, type }, value, name, depth + 1);
        return;
      } catch (error) {
        last = error;
      }
    }
    if (last) throw last;
    return invalid(name);
  }
  const types = [schema.type];
  if (value === null && types.includes('null')) return;
  if (schema.type === 'null') return invalid(name);
  switch (types.find((t) => t !== 'null')) {
    case 'object': {
      if (!record(value)) invalid(name);
      const props = record(schema.properties) ? schema.properties : {};
      if (Object.keys(value).length > 100) invalid(name);
      for (const key of Array.isArray(schema.required) ? schema.required : []) if (!Object.hasOwn(value, key)) invalid(key);
      for (const [key, v] of Object.entries(value)) {
        if (Object.hasOwn(props, key)) validate(props[key], v, key, depth + 1);
        else if (schema.additionalProperties === false) invalid(key);
        else if (record(schema.additionalProperties)) validate(schema.additionalProperties, v, key, depth + 1);
      }
      break;
    }
    case 'array':
      if (!Array.isArray(value) || value.length > 100 || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 100))
        invalid(name);
      if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) invalid(name);
      for (const v of value) validate(schema.items ?? {}, v, name, depth + 1);
      break;
    case 'number':
    case 'integer':
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (schema.type === 'integer' && !Number.isInteger(value)) ||
        value < (schema.minimum ?? -Infinity) ||
        value > (schema.maximum ?? Infinity)
      )
        invalid(name);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') invalid(name);
      break;
    case 'string':
      if (
        typeof value !== 'string' ||
        value.length > 100_000 ||
        value.length < (schema.minLength ?? 0) ||
        value.length > (schema.maxLength ?? Infinity)
      )
        invalid(name);
      // MCP's string schema has length and format annotations, not executable regular expressions.
      break;
    case undefined:
      break;
    default:
      invalid(name);
  }
}

/** A card's data entry fields and protocol choices. */
function formCard(method, p) {
  if (method === 'item/tool/requestUserInput')
    return {
      title: 'A question for you',
      questions: Array.isArray(p.questions) ? p.questions.map((q) => ({ ...q, isOther: offersOther(q) })) : [],
      choices: [
        { key: 'submit', label: 'Send' },
        { key: 'skip', label: 'Skip' },
      ],
      results: {},
    };
  if (method === 'mcpServer/elicitation/request')
    return {
      title: String(p.message || `${p.serverName || 'A tool'} needs input`),
      ...(p.mode === 'url' ? { url: p.url } : { schema: formSchema(p.requestedSchema ?? { type: 'object', properties: {} }) }),
      choices: [
        { key: 'submit', label: p.mode === 'url' ? 'Done' : 'Submit' },
        { key: 'decline', label: 'Decline' },
        { key: 'cancel', label: 'Cancel' },
      ],
      results: {},
    };
  return null;
}

/** null means this is not a form choice; invalid current values throw a readable error and leave the card pending. */
function formAnswer(method, p, key, values) {
  if (method === 'item/tool/requestUserInput') {
    if (key === 'skip') return { answers: {} };
    if (key !== 'submit') return null;
    if (!record(values)) invalid('these questions');
    if (!Array.isArray(p.questions) || !p.questions.length) invalid('these questions');
    const questions = p.questions;
    const entries = questions.map((q) => {
      const answers = values[q.id] ?? [];
      if (
        !Array.isArray(answers) ||
        answers.length === 0 ||
        answers.length > 100 ||
        answers.some((v) => typeof v !== 'string' || !v.trim() || v.length > 100_000) ||
        (!q.multiSelect && answers.length > 1)
      )
        invalid(q.header || q.question);
      const offered = (Array.isArray(q.options) ? q.options : []).map((o) => o.label);
      if (offered.length && !offersOther(q) && answers.some((a) => !offered.includes(a))) invalid(q.header || q.question);
      return [q.id, { answers }];
    });
    if (Object.keys(values).some((id) => !questions.some((q) => q.id === id))) invalid('these questions');
    return { answers: Object.fromEntries(entries) };
  }
  if (method !== 'mcpServer/elicitation/request' || !['submit', 'decline', 'cancel'].includes(key)) return null;
  if (key !== 'submit') return elicitationAnswer(key, null, p.mode);
  if (p.mode !== 'url') validate(formSchema(p.requestedSchema ?? { type: 'object' }), values);
  return elicitationAnswer('accept', values, p.mode);
}

module.exports = { formCard, formAnswer, validate };
