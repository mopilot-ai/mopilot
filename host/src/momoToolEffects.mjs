// What each tool MoMo's chats may call does, for the gate (#5474): the effect it has, whether a read sends model-chosen text to a third party, where its result comes from (MoMo's own state is trusted, anything else taints the chat), and the one line a card shows. A tool that is not listed here is treated as a change of settings, which always asks, and its result as outside content: an unknown tool fails closed.

/** @typedef {{ effect: import('../../shared/momoCore/gateRules.ts').Effect, egress: 'none' | 'network', source: 'owner_state' | 'outside', scope: string, summary: string }} ToolEffect */

/** @type {Record<string, ToolEffect>} MoMo's own tools (host/src/momoTools.mjs): its notes and open loops, all on this Host. */
export const MOMO_TOOL_EFFECTS = Object.freeze({
  momo_memory_search: { effect: 'read', egress: 'none', source: 'owner_state', scope: 'memory', summary: 'Look in MoMo’s memory' },
  momo_memory_save: { effect: 'notes', egress: 'none', source: 'owner_state', scope: 'memory', summary: 'Save a fact to MoMo’s memory' },
  momo_memory_forget: {
    effect: 'notes',
    egress: 'none',
    source: 'owner_state',
    scope: 'memory',
    summary: 'Forget a fact in MoMo’s memory',
  },
  momo_notes: { effect: 'notes', egress: 'none', source: 'owner_state', scope: 'notes', summary: 'Change a line of MoMo’s notes' },
  momo_ask: { effect: 'read', egress: 'none', source: 'owner_state', scope: 'questions', summary: 'Ask the owner a question' },
  momo_open_loops: { effect: 'notes', egress: 'none', source: 'owner_state', scope: 'open loops', summary: 'Update MoMo’s open loops' },
});

/** In a chat that holds outside content, saving or forgetting what MoMo remembers is what planted text would ask for: it needs a card, so what is kept was approved by the owner and reading it back is safe. */
const TAINTED_CLASS = Object.freeze({
  momo_memory_save: 'write',
  momo_memory_forget: 'delete',
  momo_notes: 'write',
  momo_open_loops: 'write',
});

/**
 * The tools other lanes add to the gate (a mail send, a calendar change, a browser): each says what it does, and the gate treats its results as outside content. A lane cannot claim the free class of MoMo's own notes, cannot take the name of one of MoMo's own tools, and cannot say its results are trusted: what it can do is say how risky its tool is, and a tool that is not registered is "settings", which always asks.
 * @typedef {{ tool: string, effect: Exclude<import('../../shared/momoCore/gateRules.ts').Effect, 'notes'>, egress?: 'none' | 'network', scope?: (args: any) => string, summary?: (args: any) => string }} ExtraTool
 */
const EXTRA_EFFECTS = ['read', 'write', 'send', 'delete', 'spend', 'settings'];
const TOOL_NAME = /^[a-z][a-z0-9_.:-]{0,63}$/;

/** One home's extra tools. */
export function createExtraTools() {
  /** @type {Map<string, ExtraTool>} */
  const tools = new Map();
  return {
    /**
     * Adds a tool to the gate. Refused (it throws) for a name that is not a plain tool name, one of MoMo's own tools, a tool registered with another meaning, or an effect that is not one a lane may claim. Returns how to take it out again.
     * @param {ExtraTool} t
     */
    register(t) {
      if (!TOOL_NAME.test(String(t?.tool))) throw new Error('That is not a tool name.');
      if (t.tool in MOMO_TOOL_EFFECTS) throw new Error(`${t.tool} is one of MoMo's own tools.`);
      if (!EXTRA_EFFECTS.includes(t.effect)) throw new Error(`${t.effect} is not an effect a tool may claim.`);
      const have = tools.get(t.tool);
      if (have && (have.effect !== t.effect || have.egress !== (t.egress ?? 'none')))
        throw new Error(`${t.tool} is already registered as something else.`);
      tools.set(t.tool, { ...t, egress: t.egress ?? 'none' });
      return () => void tools.delete(t.tool);
    },
    /** @param {string} tool */
    has: (tool) => tools.has(tool),
    /** @param {string} tool */
    get: (tool) => tools.get(tool),
  };
}

/** @param {string} tool @param {boolean} [tainted] @param {any} [args] @param {ReturnType<typeof createExtraTools>} [extras] @returns {ToolEffect} */
export function effectOf(tool, tainted = false, args = undefined, extras = undefined) {
  const extra = extras?.get(tool);
  if (extra)
    return {
      effect: extra.effect,
      egress: /** @type {'none' | 'network'} */ (extra.egress),
      // what comes back from another lane's tool is outside content: the chat that called it is tainted
      source: 'outside',
      scope: String(extra.scope?.(args) ?? tool).slice(0, 120),
      summary: String(extra.summary?.(args) ?? `Use ${tool.slice(0, 80)}`).slice(0, 120),
    };
  const known = MOMO_TOOL_EFFECTS[tool];
  if (!known)
    return { effect: 'settings', egress: 'none', source: 'outside', scope: tool.slice(0, 120), summary: `Use ${tool.slice(0, 80)}` };
  // listing the open loops reads them: it is a read in any chat
  if (tool === 'momo_open_loops' && args?.action === 'list') return { ...known, effect: 'read' };
  const raised = tainted
    ? /** @type {Record<string, import('../../shared/momoCore/gateRules.ts').Effect>} */ (TAINTED_CLASS)[tool]
    : undefined;
  return raised ? { ...known, effect: raised } : known;
}

const MAX_FIELDS = 10;
const MAX_VALUE = 1000;
/** The arguments the owner most needs to see (who, where, how much) come first, whatever order the model wrote them in. */
const PRIORITY = [
  'to',
  'cc',
  'bcc',
  'recipient',
  'recipients',
  'email',
  'address',
  'url',
  'amount',
  'price',
  'total',
  'currency',
  'target',
  'path',
  'destination',
  'subject',
  'title',
  'name',
  'id',
];
const rankOf = (/** @type {string} */ key) => {
  const at = PRIORITY.indexOf(key.toLowerCase());
  return at < 0 ? PRIORITY.length : at;
};
const UNUSUAL = /[^\x20-\x7e]/;

/**
 * What the card shows of the call's own arguments, so the owner sees who and what before tapping: the important ones first by a fixed rule, each value whole up to 1000 characters (then cut with a count), an object or list of objects named as not shown, a count of fields left out, and a warning on an address, link or name that holds characters that can look like others. `tooLong` says a value did not fit: the call must not be offered for a tap that cannot show all of it.
 * @param {unknown} args @returns {{ fields: { label: string, value: string }[], tooLong: boolean }}
 */
export function fieldsOf(args) {
  if (!args || typeof args !== 'object') return { fields: [], tooLong: false };
  const entries = Object.entries(/** @type {Record<string, unknown>} */ (args))
    .map(([key, v], index) => ({ key, v, index, rank: rankOf(key) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  let tooLong = false;
  const fields = entries.slice(0, MAX_FIELDS).map(({ key, v, rank }) => {
    const plain =
      ['string', 'number', 'boolean'].includes(typeof v) || (Array.isArray(v) && v.every((x) => ['string', 'number'].includes(typeof x)));
    let value = plain
      ? String(Array.isArray(v) ? v.join(', ') : v)
      : `(not shown: ${Array.isArray(v) ? `a list of ${v.length}` : 'an object'})`;
    if (value.length > MAX_VALUE) {
      tooLong = true;
      value = `${value.slice(0, MAX_VALUE)} … (${value.length - MAX_VALUE} more characters not shown)`;
    }
    if (rank < PRIORITY.length && UNUSUAL.test(value)) value += ' (contains characters that can look like others)';
    return { label: key.slice(0, 40), value };
  });
  if (entries.length > MAX_FIELDS) fields.push({ label: 'More', value: `+${entries.length - MAX_FIELDS} more fields not shown` });
  return { fields, tooLong };
}

/** What a person is told when a tool failed: the tool's own words, flattened and cut, never a stack or a path-length dump. @param {unknown} error */
export const causeOf = (error) =>
  String(error instanceof Error ? error.message : error)
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) || 'The action failed.';

/** The code the tool registry reports (`refused:<code>`) for each reason the gate refuses a call. @type {Record<string, string>} */
export const REFUSAL_CODES = Object.freeze({
  rule_deny: 'denied',
  unprompted_read_only: 'read_only',
  ask_unprompted: 'unprompted',
  repeats_denied: 'denied',
  not_home: 'unavailable',
  moved: 'unavailable',
  audit_unavailable: 'unavailable',
  unhashable_args: 'invalid',
  used: 'used',
  mismatch: 'refused',
  expired: 'refused',
  policy_denied: 'denied',
  not_allowed: 'denied',
  not_answered: 'refused',
  missing: 'refused',
});

/** What a model is told when a call needs the owner's tap. */
export const PENDING_TEXT =
  'This needs the owner’s OK first. A card is waiting on their phone and in the app; do not retry until they answer.';
