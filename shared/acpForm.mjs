// Bounded ACP form schemas and typed answers, shared by the renderer and authoritative main owner.
const LIMIT = 65536;
const TEXT = 4096;
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = () => {
  throw new Error('This form uses an unsupported or invalid schema.');
};
const string = (v) => typeof v === 'string' && v.length <= TEXT;
const number = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER;
const present = (v) => v !== undefined && v !== null;
const CREDENTIAL =
  /pass ?word|pass ?phrase|api ?key|\b(?:bearer|access|refresh|auth(?:entication|orization)?|session|personal(?: access)?|identity|id|security) token\b(?! (?:budget|limit|count|usage|length|cost)\b)|private ?key|recovery ?code|credit ?card|card ?number|\bcvv\b/i;
const credential = (text) => {
  const normalized = String(text ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\s-]+/g, ' ');
  return (
    CREDENTIAL.test(normalized) ||
    (/\b(?:paste|enter|provide|supply|submit|type)\b.{0,80}\btoken\b(?! (?:budget|limit|count|usage|length|cost|type|name|format)\b)/i.test(
      normalized,
    ) &&
      /\b(?:sign ?in|log ?in|authenticat(?:e|ion)|authoriz(?:e|ation))\b/i.test(normalized))
  );
};
const inBounds = (field, size) => (field.min === null || size >= field.min) && (field.max === null || size <= field.max);

function keys(value, allowed) {
  if (!record(value) || Object.keys(value).some((k) => !allowed.includes(k))) fail();
}
function optionalText(value) {
  if (present(value) && !string(value)) fail();
  return value ?? null;
}
function bounds(s, low, high, integer = false) {
  for (const k of [low, high]) if (present(s[k]) && (!number(s[k]) || (integer && (!Number.isInteger(s[k]) || s[k] < 0)))) fail();
  if (present(s[low]) && present(s[high]) && s[low] > s[high]) fail();
}
function options(plain, titled) {
  if (present(plain) && present(titled)) fail();
  const source = plain ?? titled;
  if (!Array.isArray(source) || !source.length || source.length > 64) fail();
  const choices = source.map((o) => {
    if (present(plain)) {
      if (!string(o)) fail();
      return { value: o, label: o, description: null };
    }
    keys(o, ['const', 'title', 'description', '_meta']);
    if (!string(o.const) || !string(o.title)) fail();
    return { value: o.const, label: o.title, description: optionalText(o.description) };
  });
  if (new Set(choices.map((o) => o.value)).size !== choices.length) fail();
  return choices;
}

/** Reject unsupported semantics instead of silently treating a constrained field as unrestricted text. */
export function parseAcpForm(schema, message = '') {
  if (!string(message) || JSON.stringify(schema)?.length > LIMIT) fail();
  keys(schema, ['type', 'properties', 'required', 'title', 'description', '_meta']);
  if (schema.type !== 'object' || !record(schema.properties)) fail();
  optionalText(schema.title);
  optionalText(schema.description);
  const entries = Object.entries(schema.properties);
  if (!entries.length || entries.length > 24) fail();
  const required = schema.required ?? [];
  if (
    !Array.isArray(required) ||
    required.some((k) => typeof k !== 'string' || !Object.hasOwn(schema.properties, k)) ||
    new Set(required).size !== required.length
  )
    fail();
  const fields = entries.map(([key, s]) => {
    if (!string(key) || !record(s)) fail();
    if (!['string', 'array', 'number', 'integer', 'boolean'].includes(s.type)) fail();
    keys(s, [
      'type',
      'title',
      'description',
      'default',
      '_meta',
      ...{
        string: ['enum', 'oneOf', 'minLength', 'maxLength', 'format', 'pattern'],
        array: ['items', 'minItems', 'maxItems'],
        number: ['minimum', 'maximum'],
        integer: ['minimum', 'maximum'],
        boolean: [],
      }[s.type],
    ]);
    const field = {
      key,
      type: s.type,
      title: optionalText(s.title) ?? key,
      description: optionalText(s.description),
      required: required.includes(key),
      options: null,
      min: null,
      max: null,
      format: null,
    };
    if (credential([key, field.title, field.description, schema.title, schema.description, message].join(' ')))
      throw new Error('Credential forms are not supported.');
    if (s.type === 'string') {
      bounds(s, 'minLength', 'maxLength', true);
      field.min = s.minLength ?? null;
      field.max = s.maxLength ?? null;
      if (field.min > TEXT) fail();
      field.format = optionalText(s.format);
      if (present(s.pattern) || credential(field.format)) fail();
      if (present(s.enum) || present(s.oneOf)) field.options = options(s.enum, s.oneOf);
      if (field.options && !field.options.some((o) => inBounds(field, Array.from(o.value).length))) fail();
    } else if (s.type === 'array') {
      bounds(s, 'minItems', 'maxItems', true);
      keys(s.items, ['type', 'enum', 'anyOf', '_meta']);
      if (present(s.items.type) && s.items.type !== 'string') fail();
      field.options = options(s.items.enum, s.items.anyOf);
      field.min = s.minItems ?? null;
      field.max = s.maxItems ?? null;
      if (field.min > field.options.length) fail();
    } else if (s.type === 'number' || s.type === 'integer') {
      bounds(s, 'minimum', 'maximum');
      if (s.type === 'integer' && [s.minimum, s.maximum].some((v) => present(v) && !Number.isSafeInteger(v))) fail();
      field.min = s.minimum ?? null;
      field.max = s.maximum ?? null;
    }
    if (present(s.default)) {
      validateField(field, s.default);
      field.default = structuredClone(s.default);
    }
    return field;
  });
  return { fields };
}

function validateField(f, value) {
  let size;
  if (f.type === 'string') {
    if (!string(value) || (f.options && !f.options.some((o) => o.value === value))) fail();
    size = Array.from(value).length;
  } else if (f.type === 'array') {
    if (
      !Array.isArray(value) ||
      value.length > 64 ||
      new Set(value).size !== value.length ||
      value.some((v) => !f.options.some((o) => o.value === v))
    )
      fail();
    size = value.length;
  } else if (f.type === 'boolean') {
    if (typeof value !== 'boolean') fail();
    return;
  } else {
    if (!number(value) || (f.type === 'integer' && !Number.isSafeInteger(value))) fail();
    size = value;
  }
  if (!inBounds(f, size)) fail();
}

/** No trimming, implicit defaults, missing-required coercion, or extra answer properties. */
export function validateAcpAnswer(form, answer) {
  keys(answer, ['action', 'content']);
  if (!['accept', 'decline', 'cancel'].includes(answer.action)) fail();
  if (answer.action !== 'accept') {
    if (present(answer.content)) fail();
    return { action: answer.action };
  }
  if (!record(answer.content) || JSON.stringify(answer.content).length > LIMIT) fail();
  const content = Object.create(null);
  if (Object.keys(answer.content).some((k) => !form.fields.some((f) => f.key === k))) fail();
  for (const f of form.fields) {
    if (!Object.hasOwn(answer.content, f.key)) {
      if (f.required) fail();
      continue;
    }
    validateField(f, answer.content[f.key]);
    content[f.key] = structuredClone(answer.content[f.key]);
  }
  return { action: 'accept', content };
}

/** Defaults are visible drafts only; accepting them always requires a deliberate Submit. */
export function acpFormDefaults(form) {
  return Object.fromEntries(form.fields.filter((f) => Object.hasOwn(f, 'default')).map((f) => [f.key, structuredClone(f.default)]));
}
