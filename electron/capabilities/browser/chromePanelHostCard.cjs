// Every MoPilot-owned site, desktop, screen, terminal and paired-computer card as panel controls with the app's grant scopes and held irreversible confirmation.
const deny = { key: 'deny', label: 'Deny', deny: true };
const { momoActionCard, momoConnectCard } = require('../../remote/momoCard.cjs');
const { FRAME, ALLOW_ACTION, DECLINE, alwaysFor } = require('./chromePanelPermissionCard.cjs');
const choice = (key, label, hold = false) => ({ key, label, ...(hold ? { hold: true } : {}) });
/** What a phone says a Mac-only confirmation waits for (browserSiteTables.cjs MAC_ONLY_KINDS). */
const MAC_ONLY_ASK = {
  payment: 'confirm the payment',
  payment_entry: 'confirm the payment',
  purchase: 'confirm the payment',
  transfer: 'confirm the transfer',
  password_change: 'confirm the password change',
};

/**
 * Where a browser confirmation's action goes, as a phone says it: the label the Mac made and sanitised (originAction.cjs), a
 * plain string and never the url (userinfo in a url can pass for another site); '' when the confirmation has no usable label.
 * @param {any} p
 */
const targetLabel = (p) => {
  const label = p.actionTarget?.label;
  return typeof label === 'string' && label.trim() ? label : '';
};

function hostCard(p, agent) {
  if (p.kind === 'momoAction') return momoActionCard(p.momo ?? {});
  if (p.kind === 'momoConnect') return momoConnectCard(p.momoConnect);
  // a card for a chat that lives on a Host's machine says which machine it is for (an answer there is not one for this Mac)
  const remote = p.remote ? ` on ${p.remote.hostName || p.remote.host}` : p.machine ? ` on ${p.machine}` : '';
  const where = p.origin || p.app?.name || 'this app';
  const detail = [p.risk?.label, p.risk?.explanation, p.summary, p.reason, p.command, p.cwd, p.remote ? `Acts${remote}` : '']
    .filter(Boolean)
    .join('\n\n');
  const allow = (scope, extra = {}) => ({ decision: 'allow', ...(scope ? { scope } : {}), ...extra });
  if (p.kind === 'computerConfirm')
    return {
      title: `Allow ${agent} to ${p.verb || 'act'} in ${where}${remote}?${p.task ? '' : " This can't be undone."}`,
      detail: [detail, p.commits ? `Asks every time: ${p.commits}.` : ''].filter(Boolean).join('\n\n'),
      ...(targetLabel(p) ? { to: targetLabel(p) } : {}),
      // a payment is confirmed on the Mac only: a phone shows that it waits there
      ...(p.macOnly
        ? { macOnly: true, waitingCopy: `Waiting for you on your Mac: ${MAC_ONLY_ASK[p.macOnly] ?? MAC_ONLY_ASK.payment} on ${where}` }
        : {}),
      choices: [
        ...(p.task ? [choice('task', 'Allow for this task')] : []),
        ...(p.errand ? [choice('errand', 'Allow messages for this errand')] : []),
        choice('once', 'Allow once', !p.task && !p.errand),
        // a high-risk site's ordinary actions, allowed for good (#5464): a click, as the app's card
        ...(p.siteAlways && !p.remote ? [choice('always', 'Always allow on this site')] : []),
        deny,
      ],
      results: { once: allow('once'), task: allow('task'), errand: allow('errand'), always: allow('always'), deny: { decision: 'deny' } },
    };
  if (p.kind === 'computerAccessSet')
    return {
      title: `Allow ${agent} to use these apps${remote}?`,
      detail: [
        detail,
        ...(p.apps ?? []).map((a) => `${a.name}: ${a.tierLabel || a.tier}${a.warning ? ` — ${a.warning}` : ''}`),
        ...(p.denied ?? []).map((a) => `${a.name}: unavailable — ${a.reason}`),
      ]
        .filter(Boolean)
        .join('\n'),
      apps: p.apps ?? [],
      choices: [choice('chat', 'Allow in this chat'), ...(!p.remote && p.apps?.length ? [choice('remember', 'Always allow')] : []), deny],
      results: { chat: allow(null), remember: allow(null, { remember: true }), deny: { decision: 'deny' } },
    };
  if (p.kind === 'computerTakeover')
    return {
      title: `Allow ${agent} to take over the screen${remote}?`,
      detail,
      choices: [choice('once', 'Allow'), deny],
      results: { once: allow(null), deny: { decision: 'deny' } },
    };
  if (p.kind === 'devServer' || p.kind === 'terminalTab')
    return {
      title: `Allow ${agent} to ${p.kind === 'devServer' ? 'start a dev server' : p.command ? 'run a command in a terminal' : 'open a terminal'}${remote}?`,
      detail,
      choices: [choice('chat', p.kind === 'terminalTab' && p.command ? 'Allow once' : 'Allow in this chat'), deny],
      results: { chat: allow('chat'), deny: { decision: 'deny' } },
    };
  if (p.kind === 'browserPermission')
    return {
      title: `Allow ${p.origin} to use your ${(p.permissions ?? []).join(' and ')}${remote}?`,
      detail,
      choices: [choice('once', 'Allow once'), choice('always', 'Always allow for this site'), deny],
      results: { once: allow('once'), always: allow('always'), deny: { decision: 'deny' } },
    };
  if (!['browserOrigin', 'computerAccess', 'visionConsent'].includes(p.kind)) return null;
  const always = !p.remote && p.allowAlways !== false && p.allowAlways !== 'read';
  // a site in the user's Chrome is Claude in Chrome's permission card: its wording, shortcuts and reminder
  const site = p.kind === 'browserOrigin';
  return {
    ...(site ? FRAME : {}),
    title:
      p.kind === 'visionConsent'
        ? `Allow ${p.vendor || 'the vision provider'} to read screenshots with ${p.model || 'its model'}${remote}?`
        : `Allow ${agent} to use ${where}${p.kind === 'browserOrigin' ? (p.browser === 'chrome' ? ' in your Chrome' : ' in the browser') : ''}${remote}?`,
    detail,
    levels: p.levels ?? [],
    level: p.level,
    choices: [
      site ? ALLOW_ACTION : choice('once', 'Allow once'),
      choice('chat', 'Allow in this chat'),
      ...(always ? [site ? alwaysFor('always', 'Always allow on this site') : choice('always', 'Always allow')] : []),
      ...(!p.remote && p.allowAlways === 'read'
        ? [site ? alwaysFor('alwaysRead', 'Always allow reading on this site') : choice('alwaysRead', 'Always allow reading')]
        : []),
      site ? DECLINE : deny,
    ],
    results: {
      once: allow('once', { level: p.level }),
      chat: allow('chat', { level: p.level }),
      always: allow('always', { level: p.level }),
      alwaysRead: allow('always', { level: 'read' }),
      deny: { decision: 'deny' },
    },
  };
}

/** Only apps and access levels actually offered by this live card can be returned. */
function hostAnswer(p, result, values) {
  if (result.decision !== 'allow') return result;
  if (p.kind === 'computerAccessSet') {
    const offered = (p.apps ?? []).map((a) => a.bundleId);
    const picked = values?.apps ?? offered;
    if (!Array.isArray(picked) || picked.some((id) => !offered.includes(id)) || (offered.length && !picked.length))
      throw new Error('Choose one of the requested apps.');
    return {
      ...result,
      apps: [...new Set(picked)],
      clipboardRead: p.clipboardRead,
      clipboardWrite: p.clipboardWrite,
      systemKeyCombos: p.systemKeyCombos,
    };
  }
  if (p.allowAlways === 'read' && result.scope === 'always') return { ...result, level: 'read' };
  if (values?.level !== undefined) {
    if (!(p.levels ?? []).some((l) => l.id === values.level)) throw new Error('Choose one of the offered access levels.');
    if (p.kind === 'computerAccess') {
      const levels = p.levels.map((l) => l.id);
      if (levels.indexOf(values.level) < levels.indexOf(p.level)) throw new Error('This action needs a higher access level.');
    }
    return { ...result, level: values.level };
  }
  return result;
}
module.exports = { hostCard, hostAnswer };
