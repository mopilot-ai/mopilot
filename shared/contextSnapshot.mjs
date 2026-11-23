// A chat's context snapshot, the same on every harness: what fills its context window (Claude Code's own categories, or an estimated split from token counts), the tokens of its last request and session, and how fresh it is.

/**
 * @typedef {{ inputTokens: number, cachedInputTokens: number, cacheWriteInputTokens: number, outputTokens: number,
 *   reasoningOutputTokens: number, totalTokens: number }} TokenBreakdown
 * @typedef {'used' | 'free' | 'buffer' | 'deferred'} CategoryKind
 * @typedef {'instructions' | 'tools' | 'memory' | 'skills' | 'conversation' | 'other'} CategoryTone
 * @typedef {{ name: string, tokens: number }} NamedTokens
 * @typedef {{ id: string, label: string, tokens: number, kind: CategoryKind, estimated?: true, tone?: CategoryTone,
 *   parts?: NamedTokens[] }} ContextCategory
 * @typedef {{ memoryFiles: { path: string, tokens: number }[], mcpTools: { server: string, name: string, tokens: number,
 *   deferred?: true }[], agents: NamedTokens[], skills: NamedTokens[] }} ContextLists
 * @typedef {{ systemPrompt: NamedTokens[], systemTools: NamedTokens[], messages: NamedTokens[],
 *   toolCalls: { name: string, callTokens: number, resultTokens: number }[] }} ContextDetails
 * @typedef {{
 *   owner: string, at: number, model: string | null,
 *   used: number | null, window: number | null,
 *   quality: 'breakdown' | 'tokens',
 *   categories: ContextCategory[],
 *   breakdownAt: number | null, breakdownUsed: number | null,
 *   lists: ContextLists | null,
 *   details: ContextDetails | null,
 *   autoCompact: { enabled: boolean, threshold: number | null } | null,
 *   lastRequest: TokenBreakdown | null,
 *   session: TokenBreakdown | null,
 *   cost: { amount: number, currency: string } | null,
 *   baseline: number | null,
 *   stale: null | 'compacted' | 'refresh-failed',
 * }} ContextSnapshot
 */

export const TOKEN_FIELDS = /** @type {const} */ ([
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
  'totalTokens',
]);
const KINDS = new Set(['used', 'free', 'buffer', 'deferred']);
/** What fills a window, in the palette's order: the bar, the legend and the dialog's grid draw them in this order. */
export const TONES = /** @type {const} */ (['instructions', 'tools', 'memory', 'skills', 'conversation', 'other']);
/** Claude Code's category names (get_context_usage) and the plain group each joins; any other keeps its own name. */
const PLAIN = new Map([
  ['System prompt', 'instructions'],
  ['System tools', 'tools'],
  ['MCP tools', 'tools'],
  ['Memory files', 'memory'],
  ['Skills', 'skills'],
  ['Custom agents', 'skills'],
  ['Messages', 'conversation'],
]);
/** The plain names: of a group of content, and of what is not content (the reserve, deferred tools). */
const PLAIN_LABEL = {
  instructions: 'Instructions',
  tools: 'Tools',
  memory: 'Memory',
  skills: 'Skills & agents',
  conversation: 'Conversation',
  buffer: 'Reserved for compaction',
  deferred: 'Deferred tools (not counted)',
};
/** Characters per token, for the one estimate made here: the first message's share of the first request. */
const CHARS_PER_TOKEN = 4;

/** A real non-negative count, else null: an unknown value never reads as 0. */
export const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const text = (v) => (typeof v === 'string' && v ? v : null);
const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);

/** A harness's token breakdown with every field a count (a missing one is 0), or null when it is not one. */
export function tokenBreakdown(v) {
  if (!v || typeof v !== 'object') return null;
  const out = /** @type {TokenBreakdown} */ ({});
  let any = false;
  for (const k of TOKEN_FIELDS) {
    const n = count(v[k]);
    any ||= n !== null;
    out[k] = n ?? 0;
  }
  return any ? out : null;
}

/** An empty snapshot for an owner: nothing measured yet. */
export function emptySnapshot(owner, at) {
  return /** @type {ContextSnapshot} */ ({
    owner,
    at,
    model: null,
    used: null,
    window: null,
    quality: 'tokens',
    categories: [],
    breakdownAt: null,
    breakdownUsed: null,
    lists: null,
    details: null,
    autoCompact: null,
    lastRequest: null,
    session: null,
    cost: null,
    baseline: null,
    stale: null,
  });
}

/**
 * The instructions and tools a session carries before any conversation: its first request's input less the first
 * message (estimated from its length), never below 0. Null when the first request's input is unknown.
 */
export function baselineOf(firstInput, firstMessageChars) {
  const input = count(firstInput);
  if (input === null) return null;
  return Math.max(0, Math.round(input - (count(firstMessageChars) ?? 0) / CHARS_PER_TOKEN));
}

/**
 * The estimated split of a window a harness reports only token counts for: the baseline (instructions and tools), the
 * rest of what is used (the conversation), and what is free. With no baseline it is one "Used" row.
 */
export function estimatedCategories(used, window, baseline) {
  if (used === null) return [];
  const base = baseline === null ? null : Math.min(baseline, used);
  /** @type {ContextCategory[]} */
  const rows =
    base === null
      ? [{ id: 'used', label: 'Used', tokens: used, kind: 'used', tone: 'other' }]
      : [
          { id: 'instructions', label: 'Instructions & tools', tokens: base, kind: 'used', estimated: true, tone: 'instructions' },
          { id: 'conversation', label: 'Conversation', tokens: used - base, kind: 'used', estimated: true, tone: 'conversation' },
        ];
  if (window !== null && window > used) rows.push({ id: 'free', label: 'Free space', tokens: window - used, kind: 'free' });
  return rows.filter((r) => r.tokens > 0);
}

/**
 * The snapshot after a token report: what is used now, and (when no breakdown stands) the estimated split. A field the
 * report leaves out keeps its value.
 * @param {ContextSnapshot} prev
 * @param {{ at: number, used?: number | null, window?: number | null, lastRequest?: TokenBreakdown | null,
 *   session?: TokenBreakdown | null, model?: string | null }} report
 * @returns {ContextSnapshot}
 */
export function withTokens(prev, { used, window, lastRequest, session, model, at }) {
  const next = { ...prev, at };
  if (used !== undefined) next.used = count(used);
  if (window !== undefined) next.window = count(window) || null;
  if (lastRequest !== undefined) next.lastRequest = lastRequest;
  if (session !== undefined) next.session = session;
  if (model) next.model = model;
  if (next.quality === 'tokens') {
    next.categories = estimatedCategories(next.used, next.window, next.baseline);
    // a report after a compaction measures what is left: nothing it shows predates the compaction
    if (used !== undefined) next.stale = null;
  }
  return next;
}

/** A Codex-shaped ThreadTokenUsage ({ total, last, modelContextWindow }) as a token report. */
export function fromTokenUsage(usage) {
  const last = tokenBreakdown(usage?.last);
  return {
    used: last ? last.totalTokens : null,
    window: count(usage?.modelContextWindow),
    lastRequest: last,
    session: tokenBreakdown(usage?.total),
  };
}

/** An ACP PromptResponse.usage (unstable: totalTokens, inputTokens, outputTokens, thoughtTokens, cachedRead/WriteTokens). */
export function fromAcpUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const input = count(u.inputTokens);
  const output = count(u.outputTokens);
  if (input === null && output === null && count(u.totalTokens) === null) return null;
  const cached = count(u.cachedReadTokens) ?? 0;
  return {
    // the ledger's rule (electron/ledger/acpTap.cjs): inputTokens is what was sent; the cached part is told apart
    inputTokens: (input ?? 0) + cached,
    cachedInputTokens: cached,
    cacheWriteInputTokens: count(u.cachedWriteTokens) ?? 0,
    outputTokens: output ?? 0,
    reasoningOutputTokens: count(u.thoughtTokens) ?? 0,
    totalTokens: count(u.totalTokens) ?? (input ?? 0) + cached + (output ?? 0),
  };
}

/** Two breakdowns added field by field (a session total plus one more turn). */
export function addBreakdowns(a, b) {
  if (!a) return b;
  if (!b) return a;
  return /** @type {TokenBreakdown} */ (Object.fromEntries(TOKEN_FIELDS.map((k) => [k, a[k] + b[k]])));
}

/** An ACP usage_update's cost ({ amount, currency }), when it sends a real one. */
export function costOf(v) {
  const amount = typeof v?.amount === 'number' && Number.isFinite(v.amount) ? v.amount : null;
  const currency = text(v?.currency);
  return amount === null || !currency ? null : { amount, currency };
}

/** Claude Code's MCP tool name for a row: `server · tool`, without the mcp__server__ prefix. */
function mcpTool(t) {
  const server = text(t.serverName) ?? '';
  const raw = text(t.name) ?? '';
  const prefix = `mcp__${server}__`;
  const name = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  return { server, name, tokens: count(t.tokens) ?? 0, ...(t.isLoaded === false ? { deferred: /** @type {true} */ (true) } : {}) };
}

const named = (rows, key = 'name') =>
  list(rows)
    .map((r) => ({ name: text(r[key]) ?? '', tokens: count(r.tokens) ?? 0 }))
    .filter((r) => r.name);

/** The rows of a message breakdown worth a line: each kind of message with its tokens. */
function messageRows(b) {
  if (!b || typeof b !== 'object') return [];
  const rows = [
    ['Tool calls', b.toolCallTokens],
    ['Tool results', b.toolResultTokens],
    ['Attachments', b.attachmentTokens],
    ['Assistant messages', b.assistantMessageTokens],
    ['User messages', b.userMessageTokens],
    ['Redirected context', b.redirectedContextTokens],
    ['Unattributed', b.unattributedTokens],
  ];
  return rows.map(([name, tokens]) => ({ name, tokens: count(tokens) ?? 0 })).filter((r) => r.tokens > 0);
}

/**
 * A breakdown's categories in plain words, one row per group: System prompt is Instructions, System and MCP tools are
 * Tools, and so on (PLAIN), each keeping the names it was reported as in `parts`; the reserve and deferred tools are one
 * row each. A category already named (with a tone or parts) and free space pass through, so it can run again on a
 * snapshot saved before it existed; one it does not know keeps its own name in the neutral tone.
 * @param {ContextCategory[]} categories
 * @returns {ContextCategory[]}
 */
export function plainCategories(categories) {
  /** @type {Map<string, ContextCategory>} */
  const groups = new Map();
  for (const c of categories) {
    if (c.tone || c.parts || c.kind === 'free') {
      groups.set(c.id, c);
      continue;
    }
    const group = c.kind === 'used' ? PLAIN.get(c.label) : c.kind;
    if (!group) {
      groups.set(c.id, { ...c, tone: 'other' });
      continue;
    }
    const prev = groups.get(group);
    groups.set(group, {
      id: group,
      label: PLAIN_LABEL[/** @type {keyof typeof PLAIN_LABEL} */ (group)],
      tokens: (prev?.tokens ?? 0) + c.tokens,
      kind: c.kind,
      ...(c.kind === 'used' ? { tone: /** @type {CategoryTone} */ (group) } : {}),
      parts: [...(prev?.parts ?? []), { name: c.label, tokens: c.tokens }],
    });
  }
  return [...groups.values()];
}

/**
 * Claude Code's get_context_usage answer (SDKControlGetContextUsageResponse) on top of the snapshot: its categories
 * (classified by `kind`, then named plainly: plainCategories), per-item lists, auto-compact setting and, from a full read,
 * the system prompt, tools and message breakdown. Null when the answer is not one.
 */
export function withClaudeBreakdown(prev, reply, at) {
  if (!reply || typeof reply !== 'object') return null;
  const total = count(reply.totalTokens);
  const max = count(reply.rawMaxTokens) || count(reply.maxTokens);
  if (total === null || !max) return null;
  const categories = plainCategories(
    list(reply.categories)
      .map((c, i) => {
        const kind = KINDS.has(c.kind) ? c.kind : c.isDeferred ? 'deferred' : 'used';
        return { id: `c${i}`, label: text(c.name) ?? 'Other', tokens: count(c.tokens) ?? 0, kind };
      })
      .filter((c) => c.tokens > 0),
  );
  const skills = reply.skills && typeof reply.skills === 'object' ? named(reply.skills.skillFrontmatter) : [];
  const full = Array.isArray(reply.systemPromptSections) || Array.isArray(reply.systemTools) || !!reply.messageBreakdown;
  const threshold = count(reply.autoCompactThreshold);
  return {
    ...prev,
    at,
    model: text(reply.model) ?? prev.model,
    used: total,
    window: max,
    quality: 'breakdown',
    categories,
    breakdownAt: at,
    breakdownUsed: total,
    lists: {
      memoryFiles: list(reply.memoryFiles)
        .map((f) => ({ path: text(f.path) ?? '', tokens: count(f.tokens) ?? 0 }))
        .filter((f) => f.path),
      mcpTools: list(reply.mcpTools).map(mcpTool),
      agents: named(reply.agents, 'agentType'),
      skills,
    },
    details: full
      ? {
          systemPrompt: named(reply.systemPromptSections),
          systemTools: named(reply.systemTools),
          messages: messageRows(reply.messageBreakdown),
          toolCalls: list(reply.messageBreakdown?.toolCallsByType)
            .map((t) => ({ name: text(t.name) ?? '', callTokens: count(t.callTokens) ?? 0, resultTokens: count(t.resultTokens) ?? 0 }))
            .filter((t) => t.name),
        }
      : (prev.details ?? null),
    autoCompact: typeof reply.isAutoCompactEnabled === 'boolean' ? { enabled: reply.isAutoCompactEnabled, threshold } : prev.autoCompact,
    stale: null,
  };
}

/** Tokens reported after the breakdown was read (the bar shows them as Conversation while it updates), 0 when none or no breakdown stands. */
export function sinceBreakdown(s) {
  return s && s.quality === 'breakdown' && s.used !== null && s.breakdownUsed !== null ? Math.max(0, s.used - s.breakdownUsed) : 0;
}
