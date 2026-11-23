// What an MCP server says, as the chats offered its tools may see it (#2999 C0; MoMo's proxy so far): the server's words are its word, not instructions, so its descriptions and a schema's prose are quoted (one line, no control characters) and cut short, a schema with keys that aren't plain names or too long a text keeps its tool from being offered, and a call's answer is its text parts, cut at a limit, with the quote's tag unwritable by the server.
const { prefixUnits } = require('../../shared/textPrefix.mjs');

/** The longest description of a tool, or of one of its inputs, the chats are given. */
const DESCRIPTION_MAX = 300;
/** The longest answer a call returns. */
const RESULT_MAX = 50_000;

/** Text a server wrote, as the chats may see it: one line, no control characters, at most `max` characters. */
function quoted(/** @type {unknown} */ v, max = DESCRIPTION_MAX) {
  const s = [...String(v ?? '')]
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${prefixUnits(s, max - 1)}…` : s;
}

/** The longest input schema (as JSON) a tool may have to be offered. */
const SCHEMA_MAX = 20_000;
/** What an input's name, or any other key in a schema, may look like for the tool to be offered. */
const SCHEMA_KEY = /^[A-Za-z0-9_.$-]{1,64}$/;

/** The schema keys whose strings are the server's prose (quoted and cut short); values the server accepts stay as they are. */
const PROSE = new Set(['description', 'title', 'examples']);
/** The schema keys whose strings are values the server accepts: never changed, so a long one keeps its tool from being offered. */
const VALUES = new Set(['enum', 'const', 'default']);

/** A schema with its prose (descriptions, titles, examples) quoted and cut short; everything else as the server wrote it. */
function schemaOf(/** @type {unknown} */ v, prose = false) {
  if (typeof v === 'string') return prose ? quoted(v, 200) : v;
  if (Array.isArray(v)) return v.map((x) => schemaOf(x, prose));
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, schemaOf(x, PROSE.has(k))]));
}

/** Why a schema keeps its tool from being offered (a key that isn't a plain name, or too long), else null. */
function schemaProblem(/** @type {unknown} */ schema) {
  if (JSON.stringify(schema).length > SCHEMA_MAX) return 'its inputs are described at too great a length';
  /** @type {{ v: unknown, value: boolean }[]} value: under enum, const or default */
  const todo = [{ v: schema, value: false }];
  while (todo.length) {
    const { v, value } = /** @type {{ v: unknown, value: boolean }} */ (todo.pop());
    if (value && typeof v === 'string' && v.length > 200) return 'its inputs are described at too great a length';
    if (!v || typeof v !== 'object') continue;
    for (const [k, x] of Object.entries(v)) {
      if (!Array.isArray(v) && !SCHEMA_KEY.test(k)) return 'its inputs have names MoMo does not take';
      todo.push({ v: x, value: value || (!Array.isArray(v) && VALUES.has(k)) });
    }
  }
  return null;
}

/** An answer's text inside its quote: the quote's tag can't be written by the server, nested or not. */
const unquotable = (/** @type {string} */ text) => text.replace(/mcp_answer/gi, 'mcp-answer');

/** A call's answer as text: its text parts (and any text resource), a note for what isn't text, at most RESULT_MAX characters. */
function answerText(/** @type {any} */ r) {
  const parts = (Array.isArray(r?.content) ? r.content : []).map((/** @type {any} */ c) =>
    c?.type === 'text'
      ? String(c.text)
      : typeof c?.resource?.text === 'string'
        ? c.resource.text
        : `[${String(c?.type ?? 'unknown')} content left out]`,
  );
  if (!parts.length && r?.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
  const text = parts.join('\n');
  return text.length > RESULT_MAX ? `${prefixUnits(text, RESULT_MAX)}\n[cut at ${RESULT_MAX} characters]` : text;
}

module.exports = { quoted, schemaOf, schemaProblem, answerText, unquotable, DESCRIPTION_MAX, RESULT_MAX, SCHEMA_MAX };
