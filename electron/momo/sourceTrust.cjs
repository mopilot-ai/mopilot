// How the sources hub's reads, and the connector hub's calls (#2999), reach MoMo's trust layer (#2139): the sentinel decides each read as a read of that source, at the level the hub holds for it and as private data (so the chat's egress taint follows it), and the audit log records how it went: a refusal as a refusal, an allowed read as an intent and its outcome, each with the chat's harness and account and the read's arguments (a path or a range, kept only as the log's keyed digest, #2284). Never what was read: the hub hands over counts and its summary only.
const { LABELS } = require('./sources/hub.cjs');
const { recipientsOf } = require('./recipients.cjs');

/** @typedef {(chatId: string) => { harness?: string, account?: string }} Identity a chat's harness and account (toolTrust.cjs chatIdentity) */

const nobody = /** @type {Identity} */ (() => ({}));

/** What a read names, for the sentinel's fingerprint and the audit log's digest: its action and its own arguments. */
const readArgs = (/** @type {any} */ e) => ({ action: e.action, args: e.args ?? null });

/**
 * The hub's `decide`: the sentinel's decision on one read, with the source's level as the hub holds it now (a level
 * changed in Settings counts from the next read).
 * @param {Pick<InstanceType<typeof import('./sentinel.cjs').Sentinel>, 'setSource' | 'decide'>} sentinel
 * @param {Identity} [identity]
 * @returns {(call: any) => Promise<{ allow: boolean, reason?: string }>}
 */
function sourceDecide(sentinel, identity = nobody) {
  return async (call) => {
    sentinel.setSource(call.source, { level: call.level, private: true, name: LABELS[/** @type {keyof typeof LABELS} */ (call.source)] });
    const d = await sentinel.decide({
      chatId: call.chatId,
      tool: `momo_${call.source}`,
      source: call.source,
      kind: 'read',
      summary: call.summary,
      args: readArgs(call),
      ...identity(call.chatId),
    });
    return d.allow ? { allow: true } : { allow: false, reason: d.reason };
  };
}

/**
 * The hub's `audit`: each entry it appends as the audit log's own entries. A refused read is a refusal (its reason as
 * the decision); an allowed one an intent, then its outcome: done, or not sent (nothing left this Mac) with why. Each
 * names the chat's harness and account and carries the read's arguments, which the log keeps as a keyed digest.
 * @param {{ refusal: (f: any) => Promise<unknown>, intent: (f: any) => Promise<{ id: string }>,
 *           outcome: (id: string, o: { result: string, note?: string }) => Promise<unknown> }} audit
 * @param {Identity} [identity]
 */
function sourceAudit(audit, identity = nobody) {
  return {
    async append(/** @type {any} */ e) {
      const fields = { action: `${e.source}.${e.action}`, chatId: e.chatId, ...identity(e.chatId), args: readArgs(e) };
      if (e.decision !== 'allowed') return audit.refusal({ ...fields, decision: e.reason ?? 'refused' });
      const { id } = await audit.intent({ ...fields, decision: 'allowed' });
      const done = e.result === 'done';
      return audit.outcome(id, { result: done ? 'done' : 'not sent', note: done ? '' : (e.reason ?? e.result) });
    },
  };
}

/** The sentinel's source id for a connector: its own, never one of the local sources'. */
const connectorSource = (/** @type {string} */ id) => `connector:${id}`;

/**
 * The connector hub's `decide` (#2999 C0): the sentinel's decision on one tool call, a connector's data private and at the
 * account's level (Read & ask to change unless set: a read runs, a change asks on the approval card), named on the card by
 * the connector's label.
 * @param {Pick<InstanceType<typeof import('./sentinel.cjs').Sentinel>, 'setSource' | 'decide'>} sentinel
 * @param {Identity} [identity]
 * @returns {(call: any) => Promise<{ allow: boolean, reason?: string }>}
 */
function connectorDecide(sentinel, identity = nobody) {
  return async (call) => {
    // a coding-side MCP server's tool (mcp/proxy.cjs) names its own source and tool
    const source = call.source ?? connectorSource(call.connector);
    sentinel.setSource(source, { level: call.level ?? 'ask', private: true, name: call.label });
    // a change that names people (to, cc, attendees...) sends to them; one that can reach people but names none is blocked
    const { reaches, recipients, unreadable } = recipientsOf(call.tool, call.args, call.kind);
    const d = await sentinel.decide({
      chatId: call.chatId,
      tool: call.toolName ?? `momo_${call.connector}_${call.tool}`,
      source,
      kind: call.kind,
      summary: call.summary,
      args: { action: call.tool, args: call.args ?? null },
      ...(recipients.length || unreadable ? { egress: { recipients, ...(unreadable ? { unknown: true } : {}) } } : {}),
      ...(reaches ? { reaches } : {}),
      ...identity(call.chatId),
    });
    return d.allow ? { allow: true } : { allow: false, reason: d.reason };
  };
}

/**
 * The connector hub's `audit`: a refusal as a refusal, an allowed call as an intent and its outcome, with the chat's
 * harness and account and the call's arguments (kept as the log's keyed digest). Never what the provider answered.
 * @param {Parameters<typeof sourceAudit>[0]} audit
 * @param {Identity} [identity]
 */
function connectorAudit(audit, identity = nobody) {
  return {
    async append(/** @type {any} */ e) {
      const fields = {
        action: `${e.connector}.${e.tool}`,
        chatId: e.chatId,
        ...identity(e.chatId),
        // a send the person pressed on a draft card names the draft and says so
        args: { action: e.tool, args: e.args ?? null, ...(e.draft ? { draft: e.draft } : {}) },
      };
      if (e.decision !== 'allowed') return audit.refusal({ ...fields, decision: e.decision });
      const { id } = await audit.intent({ ...fields, decision: e.via ? `allowed:${e.via}` : 'allowed' });
      const done = e.result === 'done';
      return audit.outcome(id, { result: done ? 'done' : 'not sent', note: done ? '' : (e.reason ?? '') });
    },
  };
}

module.exports = { sourceDecide, sourceAudit, connectorDecide, connectorAudit, connectorSource };
