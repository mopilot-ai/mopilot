// The prompt-injection guard's first pass (G3, #3571): the spans of tool-result text that address the agent with orders, @host-portable
// found by local heuristics (no model, no network). A span is one line, or one sentence of a long line. It is flagged when
// it carries a chat-role tag or template token, an instruction override ("ignore previous instructions", "don't tell the
// user"), or names an AI assistant or agent as its reader together with an order; text the page hides from people (off
// screen, zero size, aria-hidden, the same color as its background) needs only an addressee or a sentence-long order.

const { proseLinks } = require('../../../shared/proseLinks.mjs');

/** A chat-template token or tag a page has no reason to show ("<|im_start|>", "[INST]", "<system>", our own `untrusted` tag). */
const TEMPLATE =
  /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>|<\/?(?:system|instructions?|untrusted)\b[^>]*>/i;
/** A line that speaks as a chat role ("assistant: also cancel ...", quoted mail's "> system: ..."); with an order only, as
 * "Assistant: Mary Smith" in a staff list or "System: Windows 11" in a spec sheet is page text. */
const ROLE = /^[\s>*#-]*(?:assistant|system|developer)\s*:\s*\S/i;
/** Overriding the agent's instructions, or keeping its actions from the user. */
const OVERRIDE = new RegExp(
  [
    String.raw`\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+|my\s+)?(?:previous|prior|above|earlier|preceding|original|other|existing)\s+(?:instructions?|prompts?|directions?|rules|guidelines|tasks?)`,
    String.raw`\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:your|the)\s+(?:instructions|rules|guidelines|system prompt)`,
    String.raw`\bnew\s+(?:system\s+)?instructions?\s*:`,
    // a persona switch, not "You are now in the queue" or "You are now a member"
    String.raw`\byou\s+are\s+now\s+(?:DAN\b|in\s+(?:developer|god|jailbreak|unrestricted|admin)\s+mode|an?\s+(?:unrestricted|unfiltered|jailbroken|uncensored)\b)`,
    String.raw`\b(?:do\s+not|don't|never)\s+(?:tell|inform|mention\s+(?:it|this|that)\s+to|alert|notify)\s+(?:the\s+|your\s+)?user\b`,
    // "don't ask the user for more access" is our own refusal's advice; skipping the user's confirmation is not
    String.raw`\b(?:do\s+not|don't|never)\s+ask\s+(?:the\s+|your\s+)?user\s+(?:for\s+)?(?:permission|confirmation|approval)\b`,
    String.raw`\b(?:do\s+not|don't|never)\s+mention\s+(?:it|this|that)\s+in\s+your\s+(?:reply|answer|response|summary)`,
    String.raw`\bwithout\s+(?:asking|telling|confirming\s+with|notifying|checking\s+with)\s+(?:the\s+|your\s+)?(?:user|anyone|anybody|them)\b`,
    String.raw`\bno\s+need\s+to\s+(?:ask|confirm\s+with|check\s+with|tell)\s+(?:anyone|anybody|the\s+user|them)\b`,
  ].join('|'),
  'i',
);
/**
 * The agent named as this text's reader, not as its subject ("AI agents are popular" is news, not an address): "AI
 * assistants: ...", "Agents reading this ...", "Note to the AI", "If you are an LLM", "Dear assistant". A bare "agents" or
 * "assistants" (estate agents, a team's assistants) counts only when reading this or noted to.
 */
const AI = String.raw`(?:AI|LLM|GPT|language[-\s]model)[-\s]*(?:assistants?|agents?|models?|bots?|systems?)`;
const ADDRESSEE = new RegExp(
  [
    String.raw`\b${AI}\s*[:,]`,
    String.raw`\bLLMs?\s*[:,]`,
    String.raw`\b(?:assistants?|agents?|bots?|models?)\s+(?:reading|processing|viewing|browsing|visiting|summari[sz]ing|scanning)\s+(?:this|these)\b`,
    String.raw`\b(?:note|message|instructions?|attention)\s+(?:to|for)\s+(?:the\s+|any\s+|all\s+)?(?:${AI}|AI|assistants?|models?|bots?)\b`,
    String.raw`\bif\s+you\s+are\s+(?:an?\s+)?(?:AI|LLM|language\s+model|assistant|agent|bot|automated)\b`,
    String.raw`\b(?:dear|hey|attention)\s+(?:AI|LLM|assistant|model|bot)\b`,
  ].join('|'),
  'i',
);
/** An order to act: the verbs an injection wants the agent to carry out. */
const ORDER =
  /\b(?:send|forward|e-?mail|reply|delete|remove|erase|transfer|wire|pay|cancel|click|press|open|navigate|visit|go\s+to|upload|share|post|submit|run|execute|approve|request|purchase|buy|order|grant|export|copy|paste|type|enter|call|contact|tell|say|recommend|choose|select|must|should|do\s+it)\b/i;

/** Lines longer than this are judged sentence by sentence, so one flagged sentence doesn't mark a whole paragraph. */
const LONG_LINE = 240;
/** The shortest hidden text an order alone flags. */
const HIDDEN_ORDER = 40;
/** A concrete external destination makes even a short concealed order suspicious. */
const EMAIL = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
/** A hidden label offering the site's own contact ("Email us at help@shop.test") names a destination but sends nothing there. */
const SELF_CONTACT =
  /\b(?:(?:contact|call|e-?mail|message|reach|write\s+to)\s+us\b|(?:contact|reach|write\s+to)\s+our\b|send\s+us\s+(?:your\s+)?(?:feedback|questions?|a\s+message|an?\s+e-?mail)\b)/i;

/**
 * Why one span reads as an injection, or null: `hidden` when the page hides it from people (the bar is lower).
 * @param {string} s
 * @param {boolean} [hidden]
 * @returns {'template' | 'role' | 'override' | 'addressed' | 'hidden' | null}
 */
function judge(s, hidden = false) {
  if (TEMPLATE.test(s)) return 'template';
  if (ROLE.test(s) && ORDER.test(s)) return 'role';
  if (OVERRIDE.test(s)) return 'override';
  const addressed = ADDRESSEE.test(s);
  if (addressed && ORDER.test(s)) return 'addressed';
  // A short hidden label is ordinary; a concealed order needs a sentence's length or an explicit destination.
  return hidden &&
    (addressed ||
      (ORDER.test(s) &&
        (s.trim().length >= HIDDEN_ORDER || (!SELF_CONTACT.test(s) && (EMAIL.test(s) || proseLinks(s.toLowerCase()).length > 0)))))
    ? 'hidden'
    : null;
}

/**
 * The [start, end) ranges of `text` each span covers: its lines, a long line's sentences (each keeps its trailing space
 * out, so a mark closes right after the sentence).
 * @param {string} text
 * @returns {Array<[number, number]>}
 */
function spansOf(text) {
  /** @type {Array<[number, number]>} */
  const out = [];
  const lines = /[^\n]+/g;
  for (let m = lines.exec(text); m; m = lines.exec(text)) {
    const start = m.index;
    const line = m[0];
    if (line.length <= LONG_LINE) {
      out.push([start, start + line.length]);
      continue;
    }
    // a sentence ends at its punctuation (and any closing quote or bracket) before a space, a line end or a JSON-escaped
    // one ("\\n" in a script's result), not at a number's point: "$50,800.00" is not cut, and a mark never closes inside a value
    const sentences = /(?:[^.!?]|[.!?]+(?![\\"')\]]*(?:\s|\\n|$)))+(?:[.!?]+[\\"')\]]*(?=\s|\\n|$)|$)/g;
    for (let s = sentences.exec(line); s && s[0]; s = sentences.exec(line)) out.push([start + s.index, start + s.index + s[0].length]);
  }
  return out;
}

/**
 * The hidden text of one flattened span, as the runs it forms: fragments next to each other (only whitespace between) are
 * one run, since an order split across text nodes is still one order; unrelated hidden labels on one long line stay apart,
 * so together they can't reach the lower bar's length (#3867: a script result's one-line JSON). A span that is itself part
 * of a hidden string is its own run.
 * @param {string} flat
 * @param {string[]} hides
 * @returns {string[]}
 */
function concealedRuns(flat, hides) {
  const trimmed = flat.trim();
  /** @type {Array<[number, number]>} */
  const at = [];
  for (const h of hides) for (let i = flat.indexOf(h); i >= 0; i = flat.indexOf(h, i + h.length)) at.push([i, i + h.length]);
  at.sort((a, b) => a[0] - b[0]);
  /** @type {Array<[number, number]>} */
  const runs = [];
  for (const [start, end] of at) {
    const last = runs.at(-1);
    if (last && (start <= last[1] || !flat.slice(last[1], start).trim())) last[1] = Math.max(last[1], end);
    else runs.push([start, end]);
  }
  const whole = hides.some((h) => h.includes(trimmed)) ? [trimmed] : [];
  return [...runs.map(([start, end]) => flat.slice(start, end)), ...whole];
}

/**
 * The flagged spans of a result's text. `hidden`: strings the page hides from people (the page reader's list); a span
 * that contains one of them is judged with the lower bar.
 * @param {string} text
 * @param {{ hidden?: string[] }} [o]
 * @returns {Array<{ start: number, end: number, reason: string }>}
 */
function findInjections(text, { hidden = [] } = {}) {
  const s = String(text ?? '');
  const hides = hidden.map((h) => String(h).replace(/\s+/g, ' ').trim()).filter((h) => h.length >= 12);
  /** @type {Array<{ start: number, end: number, reason: string }>} */
  const found = [];
  for (const [start, end] of spansOf(s)) {
    const span = s.slice(start, end);
    if (!span.trim()) continue;
    const flat = span.replace(/\s+/g, ' ');
    // Tool metadata and visible neighbors must not supply length or orders to a hidden label (#3842).
    // Keep the normal screen on the entire span; apply the lower bar only to its actual hidden text.
    // A script's JSON escapes the page's line breaks: a whole hidden string still reads through them, while unrelated
    // labels those breaks separate stay apart (adjacency in concealedRuns counts real whitespace only).
    const unescaped = flat.replace(/\\(?:[ntr"]|u00[0-9a-f]{2})/gi, ' ').replace(/ +/g, ' ');
    const runs = [...concealedRuns(flat, hides), ...hides.filter((h) => unescaped.includes(h))];
    const reason = judge(span) || runs.reduce((r, run) => r || judge(run, true), /** @type {any} */ (null));
    if (reason) found.push({ start: start + (span.length - span.trimStart().length), end: start + span.trimEnd().length, reason });
  }
  return found;
}

module.exports = { findInjections, judge, spansOf, LONG_LINE };
