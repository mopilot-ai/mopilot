// MoMo's approval card (momoAction, momo/actionAsk.cjs) as a phone's card: what it asks, in one line, the exact detail and the scopes its rule allows, plus Deny; nothing the call read.
const SCOPE_LABEL = {
  once: 'Allow once',
  chat: 'Allow for this chat',
  today: 'Allow today',
  '30d': 'Allow for 30 days',
  site: 'Always allow this site',
};
/** A scope's label on this card: "Always allow <host>" names the one host it opens (src/lib/momoActionCopy.ts siteScopeLabel). */
const labelOf = (/** @type {keyof typeof SCOPE_LABEL} */ s, /** @type {any} */ m) =>
  s === 'site' && typeof m.hosts?.[0] === 'string' ? `Always allow ${m.hosts[0]}` : SCOPE_LABEL[s];

/** How many places a card reaches in all (a cut list still carries its full count), and the "To" line naming them. */
function reachOf(/** @type {any} */ m) {
  const names = [...(m.recipients ?? []), ...(m.hosts ?? [])];
  const count =
    Math.max(Number.isSafeInteger(m.recipientCount) ? m.recipientCount : 0, (m.recipients ?? []).length) + (m.hosts ?? []).length;
  return { names, count, line: count > names.length ? `${names.join(', ')} and ${count - names.length} more` : names.join(', ') };
}

/** The card for a momoAction approval's `momo` params. A card that reaches people it can't name has no allow, only Dismiss. */
function momoActionCard(/** @type {any} */ m) {
  const blocked = m.blocked === 'no-recipients' || m.blocked === 'unreadable-recipients' ? m.blocked : '';
  const scopes = blocked
    ? []
    : (Array.isArray(m.scopes) ? m.scopes : []).filter((/** @type {string} */ s) => Object.hasOwn(SCOPE_LABEL, s));
  const { names: to, count, line } = reachOf(m);
  const title = blocked
    ? "MoMo can't tell who this reaches"
    : to.length
      ? `Allow MoMo to ${m.opens === true ? 'open' : 'send to'} ${to[0]}${count > 1 ? ` and ${count - 1} more` : ''}?`
      : m.unknown
        ? 'Allow MoMo to send data out?'
        : `Allow MoMo to ${m.action === 'read' ? 'read' : 'change'} ${m.source || 'this source'}?`;
  return {
    title,
    detail: [
      blocked === 'no-recipients' ? "This reaches people but names none, so MoMo can't allow it." : '',
      blocked === 'unreadable-recipients' ? "MoMo can't read who this reaches, so it can't allow it." : '',
      m.summary,
      m.account ? `Account: ${m.account}` : '',
      to.length ? `To${count > 1 ? ` (${count})` : ''}: ${line}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    choices: [
      ...scopes.map((/** @type {string} */ s) => ({ key: s, label: labelOf(/** @type {keyof typeof SCOPE_LABEL} */ (s), m) })),
      { key: 'deny', label: blocked ? 'Dismiss' : 'Deny', deny: true },
      ...(m.denyAlways && !blocked ? [{ key: 'denyAlways', label: 'Always deny', deny: true }] : []),
    ],
    results: {
      ...Object.fromEntries(scopes.map((/** @type {string} */ s) => [s, { decision: 'allow', scope: s }])),
      deny: { decision: 'deny' },
      denyAlways: { decision: 'deny', always: true },
    },
  };
}

/** The names of the sources a connect card can ask for; any other value is never echoed. */
const CONNECT_LABEL = { calendar: 'Calendar', reminders: 'Reminders' };

/**
 * MoMo's connect card (momoConnect, momo/sources/connectAsk.cjs) as a phone's card: fixed text and the source's name, nothing the
 * tool read, and no choices. Only a click on the Mac connects (macOS shows its own prompt there), so it is a card to finish on the Mac.
 */
function momoConnectCard(/** @type {any} */ m) {
  const label = Object.hasOwn(CONNECT_LABEL, m?.source)
    ? CONNECT_LABEL[/** @type {keyof typeof CONNECT_LABEL} */ (m.source)]
    : 'Calendar or Reminders';
  return { title: `MoMo needs ${label}. Allow it on your Mac.`, inApp: true };
}

module.exports = { momoActionCard, momoConnectCard };
