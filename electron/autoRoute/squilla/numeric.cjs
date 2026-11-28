// SquillaRouter numeric88 features ported from OpenSquilla features/numeric.py with Python regex and string semantics.
'use strict';

const LEXICON = require('./lexicon.json');
const { canonicalizeText, extractTextSegments, pyLen, pySplit } = require('./text.cjs');

// Python `re` on str: \s is str.isspace(), \w is alphanumeric or underscore, \d any decimal digit; `^` under
// MULTILINE follows only "\n" and `.` excludes only "\n". JavaScript differs on each, so the patterns spell them out.
const S = '[\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const NS = '[^\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const W = '[\\p{L}\\p{N}_]';
const D = '\\p{Nd}';
const DOT = '[^\\n]';
const BOL = '(?:^|(?<=\\n))';
const re = (source, flags = '') => new RegExp(source, `u${flags}`);

const CODE_BLOCK = re('```[\\s\\S]*?```', 'g');
const JSON_LIKE = re(`\\{[\\s\\S]*?["']${W}+["']${S}*:`);
const YAML = re(`${BOL}[\\p{L}\\p{N}_]+:${S}+${NS}`);
const CSV = re(`${BOL}[^,\\n]+,[^,\\n]+,[^,\\n]+`);
const TABLE = re(`\\|${DOT}*\\|${DOT}*\\|`);
const FILE_PATH = re(
  `(?:${BOL}|[\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000"'\`(])([a-zA-Z_][\\p{L}\\p{N}_.-]*/[\\p{L}\\p{N}_./-]+\\.${W}+)`,
  'g',
);
const URL_LIKE = re(`https?://${NS}+`);
const LOG = re(
  `(${D}{4}[-/]${D}{2}[-/]${D}{2}(?:${S}|T)${D}{2}:${D}{2}${DOT}*\\n){3,}|(${BOL}\\[?(INFO|WARN|ERROR|DEBUG)\\]?${S}${DOT}*\\n){3,}`,
);
const SHELL = re(`${BOL}\\$${S}+${W}|${BOL}>${S}+${W}|\`\`\`(?:bash|sh|shell)`);
const TRACEBACK = re(`Traceback \\(most recent|stderr:|\\.py", line ${D}+`);
const BULLET = re(`${BOL}${S}*[-*]${S}`, 'g');
const NUMBERED = re(`${BOL}${S}*${D}+[.)${LEXICON.marks.enumeration}]${S}`, 'g');
const INLINE_CODE = re('`[^`]{4,}`');
const STEPS = re(`${BOL}${S}*${D}+[.${LEXICON.marks.enumeration}]${S}`);
const QUOTED = re(`["'\`](${DOT}*?)["'\`]`, 'g');

// Chinese and English word lists and patterns live in lexicon.json (source files keep user-visible strings English).
const KEYWORDS = LEXICON.keywords;
const pattern = (name, flags) => re(LEXICON.patterns[name].replaceAll('{S}', S).replaceAll('{DOT}', DOT), flags);
const CLARIFY = pattern('clarify', 'i');
const REFUSAL = pattern('refusal', 'i');
const SELF_DOUBT = pattern('selfDoubt', 'i');
const CONTINUE = pattern('continue', 'i');
const REASONING = pattern('reasoning', 'i');
const { question: FULL_QUESTION, exclamation: FULL_EXCLAMATION } = LEXICON.marks;

const TIER_INDEX = { C0: 0, C1: 1, C2: 2, C3: 3, R0: 0, R1: 1, R2: 2, R3: 3 };
const TRAJECTORIES = ['cold_start', 'stable_low', 'stable_high', 'escalating', 'descalating', 'oscillating', 'unclear', 'mixed'];
const CODE_CHARS = new Set('{}[]();=<>|&!@#$%^*~`\\');

const countMatches = (pattern, text) => [...text.matchAll(pattern)].length;
const keywordCount = (text, name) => {
  const lowered = text.toLowerCase();
  return KEYWORDS[name].reduce((n, k) => n + (lowered.includes(k.toLowerCase()) ? 1 : 0), 0);
};
const countChar = (text, ch) => text.split(ch).length - 1;

/** _char_ratios of a non-empty text (every caller checks that first). */
function charRatios(text) {
  let size = 0;
  let zh = 0;
  let latin = 0;
  let code = 0;
  for (const ch of text) {
    size++;
    if (ch >= '\u4e00' && ch <= '\u9fff') zh++;
    if (/^[A-Za-z]$/.test(ch)) latin++;
    if (CODE_CHARS.has(ch)) code++;
  }
  return [zh / size, latin / size, code / size];
}

const PY_FLOAT = /^[+-]?(?:(?:\d(?:_?\d)*)(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/;
const PY_SPECIAL = /^[+-]?(?:inf|infinity|nan)$/i;

/** Python float(value) for JSON values; null when float() would raise. */
function pyFloat(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  // inf/nan parse in Python but are never finite, so every caller treats them like any other non-finite value
  if (PY_SPECIAL.test(text)) return Number.NaN;
  return PY_FLOAT.test(text) ? Number(text.replaceAll('_', '')) : null;
}

/** _as_nonnegative: falsy and booleans count as zero; anything not a positive finite number is zero. */
function asNonnegative(value) {
  if (typeof value === 'boolean') return 0;
  const n = pyFloat(value || 0);
  return n !== null && Number.isFinite(n) && n > 0 ? n : 0;
}

/** _finite_number. */
function finiteNumber(value, fallback = 0) {
  if (typeof value === 'boolean') return fallback;
  const n = pyFloat(value);
  return n !== null && Number.isFinite(n) ? n : fallback;
}

const logUsage = (usage, key) => Math.log1p(asNonnegative(usage[key])) / 10;

/** rules48 of the current request. */
function extractRules48(currentRequest) {
  const text = canonicalizeText(currentRequest);
  const length = pyLen(text);
  const words = pySplit(text);
  const lines = text.split('\n');
  const [zh, latin, code] = charRatios(text);
  const codeBlocks = text.match(CODE_BLOCK) ?? [];
  const fileRefs = new Set([...text.matchAll(FILE_PATH)].map((m) => m[1]));
  /** @type {Record<string, number>} */
  const kw = {};
  for (const name of Object.keys(KEYWORDS)) kw[name] = keywordCount(text, name);
  const quoted = [...text.matchAll(QUOTED)].map((m) => m[1]);
  const diversity = new Set(words.map((w) => w.toLowerCase())).size / Math.max(words.length, 1);
  const core = ['debug', 'research', 'architecture', 'compare', 'planning', 'strict', 'risk'].reduce((n, k) => n + kw[k], 0);
  const values = [
    length,
    words.length,
    lines.length,
    length / Math.max(lines.length, 1),
    zh,
    latin,
    code,
    Number(zh > 0.1 && latin > 0.1),
    Number(codeBlocks.length > 0),
    codeBlocks.length,
    codeBlocks.reduce((n, b) => n + pyLen(b), 0),
    Number(JSON_LIKE.test(text)),
    Number(YAML.test(text)),
    Number(CSV.test(text)),
    Number(TABLE.test(text)),
    countChar(text, '?') + countChar(text, FULL_QUESTION),
    countChar(text, '!') + countChar(text, FULL_EXCLAMATION),
    countMatches(BULLET, text),
    countMatches(NUMBERED, text),
    kw.debug,
    kw.research,
    kw.architecture,
    kw.compare,
    kw.planning,
    kw.strict,
    kw.risk,
    kw.production,
    kw.customer,
    kw.delete,
    kw.formal,
    Number(fileRefs.size > 0),
    Number(URL_LIKE.test(text)),
    Number(LOG.test(text)),
    Number(SHELL.test(text)),
    Number(TRACEBACK.test(text)),
    kw.constraint,
    quoted.reduce((n, q) => n + pyLen(q), 0) / Math.max(length, 1),
    diversity,
    kw.teaching,
    kw.implementation,
    Number(fileRefs.size === 0),
    Number(fileRefs.size >= 1 && fileRefs.size <= 2),
    Number(fileRefs.size >= 3),
    Number(codeBlocks.length > 0 && kw.debug === 0),
    Number(length < 200),
    Number(length >= 200 && length <= 1000),
    Number(length > 1000),
    Number(core < 2),
  ];
  return Float32Array.from(values);
}

function routeIndex(entry) {
  const value = entry.tier_id || entry.tier || entry.route_class;
  const normalized = (value === undefined || value === null ? 'None' : String(value)).toUpperCase();
  if (!Object.hasOwn(TIER_INDEX, normalized)) throw new RangeError(`route history entry has invalid tier: ${value}`);
  return TIER_INDEX[/** @type {keyof typeof TIER_INDEX} */ (normalized)];
}

function trajectory(indices, difficulties) {
  if (!indices.length) return 'cold_start';
  if (indices.length < 2) return 'unclear';
  if (indices.every((i) => i <= 1)) return 'stable_low';
  if (indices.every((i) => i >= 2)) return 'stable_high';
  const signs = [];
  for (let i = 1; i < difficulties.length; i++) {
    const delta = difficulties[i] - difficulties[i - 1];
    signs.push(delta > 0.3 ? 1 : delta < -0.3 ? -1 : 0);
  }
  const nonzero = signs.filter(Boolean);
  if (nonzero.length >= 2 && nonzero.every((s) => s === 1)) return 'escalating';
  if (nonzero.length >= 2 && nonzero.every((s) => s === -1)) return 'descalating';
  let changes = 0;
  for (let i = 1; i < nonzero.length; i++) if (nonzero[i] !== nonzero[i - 1]) changes++;
  return changes >= 2 ? 'oscillating' : 'mixed';
}

/** route_history16 from the last five routing decisions. */
function extractRouteHistory16(routeHistory) {
  if (routeHistory !== null && routeHistory !== undefined && !Array.isArray(routeHistory))
    throw new TypeError('input.route_history must be a sequence');
  const entries = (routeHistory ?? []).slice(-5);
  for (const e of entries)
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new TypeError('each route_history entry must be a mapping');
  const indices = entries.map(routeIndex);
  const difficulties = entries.map((e) =>
    finiteNumber(Object.hasOwn(e, 'difficulty') ? e.difficulty : Object.hasOwn(e, 'difficulty_score') ? e.difficulty_score : 0),
  );
  const margins = entries.map((e) => finiteNumber(Object.hasOwn(e, 'margin') ? e.margin : 0));
  const result = new Float32Array(16);
  if (entries.length) {
    result[0] = indices[indices.length - 1];
    result[1] = difficulties[difficulties.length - 1];
    result[2] = margins[margins.length - 1];
    result[3] = Math.max(...indices);
    result[4] = entries.length;
    result[5] = entries.length;
    /** @type {Map<number, number>} */
    const counts = new Map();
    for (const i of indices) counts.set(i, (counts.get(i) ?? 0) + 1);
    const top = Math.max(...counts.values());
    result[6] = Math.max(...[...counts].filter(([, c]) => c === top).map(([i]) => i));
    let changes = 0;
    for (let i = 1; i < indices.length; i++) if (indices[i] !== indices[i - 1]) changes++;
    result[7] = changes;
  } else {
    result[0] = -1;
    result[3] = -1;
    result[6] = -1;
  }
  result[8 + TRAJECTORIES.indexOf(trajectory(indices, difficulties))] = 1;
  return result;
}

/** previous_signals19: the previous answer, its usage, and continuation/reasoning cues in the current request. */
function extractPreviousSignals19(currentRequest, previousAnswer, previousUsage) {
  const current = canonicalizeText(currentRequest);
  const previous = canonicalizeText(previousAnswer);
  if (previousUsage !== null && previousUsage !== undefined && (typeof previousUsage !== 'object' || Array.isArray(previousUsage)))
    throw new TypeError('input.previous_usage must be a mapping or null');
  const usage = previousUsage ?? {};
  const assistant = new Array(12).fill(0);
  if (previous) {
    const inputTokens = Math.max(asNonnegative(usage.input_tokens), 1);
    assistant.splice(
      0,
      12,
      1,
      Number(CLARIFY.test(previous)),
      Number(REFUSAL.test(previous)),
      Number(SELF_DOUBT.test(previous)),
      Number(previous.includes('```') || INLINE_CODE.test(previous)),
      Number(STEPS.test(previous)),
      logUsage(usage, 'output_tokens'),
      logUsage(usage, 'reasoning_tokens'),
      logUsage(usage, 'duration_ms'),
      Math.min(pyLen(previous) / Math.max(pyLen(current), 1), 5) / 5,
      charRatios(previous)[0],
      Math.min(asNonnegative(usage.cached_tokens) / inputTokens, 1),
    );
  }
  const stripped = current;
  const strippedLength = pyLen(stripped);
  const qmarks = countChar(current, '?') + countChar(current, FULL_QUESTION);
  const currentLength = pyLen(current);
  return Float32Array.from([
    ...assistant,
    Number(strippedLength > 0 && strippedLength <= 24 && CONTINUE.test(stripped)),
    logUsage(usage, 'output_tokens'),
    Number(REASONING.test(current)),
    Math.min((qmarks / Math.max(currentLength, 1)) * 20, 1),
    Math.log1p(currentLength) / 10,
    logUsage(usage, 'reasoning_tokens'),
    logUsage(usage, 'duration_ms'),
  ]);
}

/** context5: turn index and the context size estimate. */
function extractContext5(input) {
  const segments = extractTextSegments(input);
  const routeHistory = input.route_history ?? [];
  if (!Array.isArray(routeHistory)) throw new TypeError('input.route_history must be a sequence');
  const turnIndex = Math.min(routeHistory.slice(-5).length, 20);
  const context = input.context ?? {};
  if (typeof context !== 'object' || Array.isArray(context)) throw new TypeError('input.context must be a mapping or null');
  const estimated = context.context_tokens_est;
  let tokens;
  if (estimated === undefined || estimated === null) {
    const historyChars = (input.history_user ?? []).reduce((n, v) => n + pyLen(canonicalizeText(v)), 0);
    tokens = Math.floor((pyLen(segments.current_request) + historyChars + pyLen(segments.previous_answer)) / 4);
  } else tokens = Math.trunc(Math.max(finiteNumber(estimated), 0));
  return Float32Array.from([
    turnIndex / 20,
    Math.min(tokens, 20_000) / 20_000,
    Number(segments.current_request.includes('```')),
    Number(turnIndex >= 4),
    Number(tokens > 2_000),
  ]);
}

/** numeric88 = rules48 + route_history16 + previous_signals19 + context5. */
function extractNumeric88(input) {
  const segments = extractTextSegments(input);
  const out = new Float32Array(88);
  out.set(extractRules48(segments.current_request), 0);
  out.set(extractRouteHistory16(input.route_history), 48);
  out.set(extractPreviousSignals19(segments.current_request, input.previous_answer, input.previous_usage), 64);
  out.set(extractContext5(input), 83);
  if (!out.every(Number.isFinite)) throw new RangeError('numeric88 contains a non-finite value');
  return out;
}

module.exports = {
  CODE_BLOCK,
  FILE_PATH,
  KEYWORDS,
  LOG_BLOCK: re(LOG.source, 'g'),
  asNonnegative,
  extractContext5,
  extractNumeric88,
  extractPreviousSignals19,
  extractRouteHistory16,
  extractRules48,
  finiteNumber,
  pyFloat,
};
