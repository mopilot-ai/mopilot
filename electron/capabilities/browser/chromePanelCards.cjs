// The approval cards Chrome's side panel can answer: each waiting approval as a title and its choices, and the answer a picked choice sends, the same as the app's card for it sends (src/components/thread/Approvals.tsx).
//
// The panel gets only titles, detail and choice keys, and sends back a key: main maps it to the answer here, so a
// panel can never send an answer of its own making. Questions and forms are validated against the live request. The cards are keyed on
// the request each harness's approval reads as (shared/approvalRequest.mjs), the same the window's cards are built
// from, never on what main stores: Claude Code's `claude/permission` is a command, an edit or a tool's request (#2114).
const { permissionChoices } = require('../../../shared/acpItems/permissionChoices.mjs');
const { approvalRequest } = require('../../../shared/approvalRequest.mjs');
const { nativeAppApproval, nativeAppAnswer, browserUseApproval, browserUseAnswer } = require('../../../shared/elicitation.mjs');
const { chromeApproval, chromeSuggestion } = require('../../../shared/chromeApproval.mjs');
const { formCard, formAnswer } = require('./chromePanelForm.cjs');
const { hostCard, hostAnswer } = require('./chromePanelHostCard.cjs');
const { FRAME, ALLOW_ACTION, DECLINE, alwaysFor } = require('./chromePanelPermissionCard.cjs');

/** Claude in Chrome's tools, which the app answers with its own card (src/harness/chromeApproval.ts chromeTool). */
const CHROME_TOOL = /^mcp__claude-in-chrome__/;
const MAX_DETAIL = 2000;
const MAX_PLAN = 20000;

/** @typedef {{ key: string, label: string, deny?: boolean }} Choice */
/** @typedef {{ id: string | number, title: string, detail: string | null, choices: Choice[] } | { id: string | number, title: string, inApp: true }} Card */

const s = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : '');
const detail = (/** @type {string} */ t) => (t ? t.slice(0, MAX_DETAIL) : null);
/** A card's detail from its parts, the ones it has. */
const lines = (/** @type {string[]} */ ...parts) => parts.filter(Boolean).join('\n\n');
/** Allow once, Allow for this session (unless left out), Deny: the choices most cards offer. */
const ALLOW = Object.freeze({ key: 'once', label: 'Allow once' });
const SESSION = Object.freeze({ key: 'session', label: 'Allow for this session' });
const DENY = Object.freeze({ key: 'deny', label: 'Deny', deny: true });

/** The plan an ExitPlanMode request carries, for a client to read before approving: its text (clipped to one read), and its file's name. */
function planOf(/** @type {any} */ input) {
  const text = s(input?.plan);
  const file = s(input?.planFilePath);
  return {
    // never ends on half of a surrogate pair
    text: text.slice(0, MAX_PLAN).replace(/[\uD800-\uDBFF]$/, ''),
    ...(text.length > MAX_PLAN ? { clipped: true } : {}),
    ...(file ? { file: file.split(/[\\/]/).pop() } : {}),
  };
}

/**
 * Each card the panel answers: how it reads, and each choice's answer.
 * @type {Record<string, (p: any, agent: string) => any>}
 */
const CARDS = {
  'item/commandExecution/requestApproval': (p) => {
    const proposed = p.proposedExecpolicyAmendment;
    const valid = Array.isArray(proposed) && proposed.length > 0 && proposed.every((v) => typeof v === 'string');
    // Never offer a persistent rule whose complete scope cannot fit in the displayed detail.
    const amendment = valid && JSON.stringify(proposed).length < MAX_DETAIL - 100 ? proposed : null;
    const prefix = amendment ? JSON.stringify(amendment) : '';
    return {
      title: 'Run this command?',
      detail: lines(
        prefix ? `Permanent command prefix: ${prefix}` : '',
        Array.isArray(p.command) ? p.command.join(' ') : s(p.command),
        s(p.reason),
      ),
      choices: amendment
        ? [
            ALLOW,
            { key: 'similar', label: 'Always allow this prefix', confirm: `Permanently allow commands starting with ${prefix}?` },
            DENY,
          ]
        : proposed != null
          ? [ALLOW, DENY]
          : [ALLOW, SESSION, DENY],
      results: {
        once: { decision: 'accept' },
        session: { decision: 'acceptForSession' },
        similar: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } } },
        deny: { decision: 'decline' },
      },
    };
  },
  'item/fileChange/requestApproval': (p, agent) => ({
    title: `Allow ${agent} to edit files?`,
    // the file (Claude Code names it; Codex's request says where it would write, if outside the folder) and why
    detail: lines(s(p._claude?.input?.file_path) || s(p._claude?.input?.notebook_path) || s(p.grantRoot), s(p.reason)),
    choices: [ALLOW, SESSION, DENY],
    results: { once: { decision: 'accept' }, session: { decision: 'acceptForSession' }, deny: { decision: 'decline' } },
  }),
  'claude/toolApproval': (p, agent) => {
    // Claude in Chrome's tools have their own card (sites and levels): the app's
    if (CHROME_TOOL.test(s(p.toolName))) {
      const info = chromeApproval(p.toolName, p.input);
      const saved = chromeSuggestion(p._claude?.suggestions);
      return {
        ...FRAME,
        title: `Allow ${agent} to ${info?.action || 'use Chrome'}${info?.host ? ` on ${info.host}` : ''}?`,
        detail: lines(...(info?.rows ?? []).map((r) => `${r.label}: ${r.value}`), info?.block || ''),
        choices: [ALLOW_ACTION, ...(saved ? [alwaysFor('session', saved.label)] : []), DECLINE],
        results: { once: { decision: 'accept' }, session: { decision: 'acceptForSession' }, deny: { decision: 'decline' } },
      };
    }
    if (p.toolName === 'ExitPlanMode')
      return {
        title: 'Ready to start on this plan?',
        kind: 'plan',
        plan: planOf(p.input),
        choices: [{ key: 'once', label: 'Approve plan' }, DENY],
        results: { once: { decision: 'accept' }, deny: { decision: 'decline' } },
      };
    const name = s(p.toolName).startsWith('mcp__') ? s(p.toolName).split('__').slice(1).join(' · ') : s(p.toolName);
    const url = p.toolName === 'WebFetch' ? s(p.input?.url) : '';
    return {
      title: s(p.title) || s(p.reason) || (url ? `Allow ${agent} to fetch ${url}?` : `Allow ${agent} to use ${name}?`),
      detail: url ? '' : JSON.stringify(p.input ?? {}, null, 2),
      choices: [ALLOW, SESSION, DENY],
      results: { once: { decision: 'accept' }, session: { decision: 'acceptForSession' }, deny: { decision: 'decline' } },
    };
  },
  'acp/permission': (p, agent) => {
    const { primary, more, deny } = permissionChoices(p.options);
    const all = [primary, ...more];
    const tc = p.toolCall ?? {};
    return {
      title: s(tc.title) ? `${agent} wants to: ${s(tc.title)}` : `${agent} is asking for permission`,
      choices: [...all.map((c, i) => ({ key: `o${i}`, label: c.label })), DENY],
      results: { ...Object.fromEntries(all.map((c, i) => [`o${i}`, c.result])), deny },
    };
  },
  'sage/approval': hostCard,
};

/** The cards for native grants preserve the request's own offered scopes and metadata. */
function nativeCard(p, options) {
  const app = nativeAppApproval(p);
  if (app) {
    const scopes = [...app.scopes].sort((a, b) => Number(b.value === app.lead) - Number(a.value === app.lead));
    return {
      title: app.title,
      detail: lines(
        app.warning || '',
        app.risk ? `Risk: ${app.risk}` : '',
        ...app.details.map((r) => `${r.label}: ${r.value}`),
        ...app.unsupported,
      ),
      choices: [...scopes.map((c) => ({ key: c.value, label: c.label })), DENY],
      results: Object.fromEntries([
        ...app.scopes.map((c) => [c.value, nativeAppAnswer(p, c.value)]),
        ['deny', nativeAppAnswer(p, 'decline')],
      ]),
    };
  }
  const browser = browserUseApproval(p);
  if (!browser) return null;
  const offered = browser.choices.filter((c) => c.value !== 'allSites' || options.allowAllSites);
  return {
    title: p.message || `Allow browser ${browser.kind}${browser.host ? ` on ${browser.host}` : ''}?`,
    detail: lines(
      browser.reason || '',
      browser.highRisk ? 'High risk' : '',
      browser.sensitive ? 'Sensitive action' : '',
      ...browser.details.map((r) => `${r.label}: ${r.value}`),
    ),
    choices: [
      ...offered.map((c) => ({
        key: c.value,
        label: c.label,
        ...(c.value === 'allSites' ? { confirm: 'Allow browser access to every site? This permission applies beyond this page.' } : {}),
      })),
      DENY,
    ],
    results: Object.fromEntries([...offered.map((c) => [c.value, browserUseAnswer(p, c.value)]), ['deny', browserUseAnswer(p, 'decline')]]),
  };
}

function built(a, agent, options = {}) {
  const req = approvalRequest({ method: String(a.method), params: a.params }, null, null);
  const p = req.params;
  if (req.method === 'mcpServer/elicitation/request') return nativeCard(p, options) ?? formCard(req.method, p);
  const form = formCard(req.method, p);
  if (form) return form;
  if (req.method === 'item/permissions/requestApproval')
    return {
      title: p.reason || `Allow ${agent} additional permissions?`,
      detail: JSON.stringify(p.permissions ?? {}, null, 2),
      choices: [{ key: 'turn', label: 'Allow for this turn' }, SESSION, DENY],
      results: {
        turn: { permissions: p.permissions ?? {}, scope: 'turn' },
        session: { permissions: p.permissions ?? {}, scope: 'session' },
        deny: { permissions: {}, scope: 'turn' },
      },
    };
  if (req.method === 'execCommandApproval' || req.method === 'applyPatchApproval')
    return {
      title: req.method === 'execCommandApproval' ? 'Run this command?' : `Allow ${agent} to edit files?`,
      detail:
        req.method === 'execCommandApproval'
          ? Array.isArray(p.command)
            ? p.command.join(' ')
            : s(p.command)
          : JSON.stringify(p.fileChanges ?? {}, null, 2),
      choices: [ALLOW, SESSION, DENY],
      results: { once: { decision: 'approved' }, session: { decision: 'approved_for_session' }, deny: { decision: 'denied' } },
    };
  return CARDS[req.method.startsWith('sage/') ? 'sage/approval' : req.method]?.(p, agent) ?? null;
}

/** Main publishes controls only; protocol results remain private and are rebuilt against the live request on answer. */
function cardOf(a, agent, options = {}) {
  const card = built(a, agent, options);
  if (a.method === 'sage/hostAsk' && a.params?.macOnly === true)
    return { id: a.id, title: s(a.params.title), inApp: true, macOnly: true, waitingCopy: 'Approve this Mac action in MoPilot.' };
  if (!card) return { id: a.id, title: `${agent} is waiting for you in MoPilot.`, inApp: true };
  const { results, ...fields } = card;
  return { id: a.id, ...fields, detail: detail(card.detail ?? '') };
}

function answerOf(a, key, agent, values, options = {}) {
  const card = built(a, agent, options);
  if (!card || !card.choices?.some((c) => c.key === key)) return null;
  const req = approvalRequest({ method: String(a.method), params: a.params }, null, null);
  const result = card.results[key] ?? formAnswer(req.method, req.params, key, values);
  return result && req.method.startsWith('sage/') ? hostAnswer(req.params, result, values) : result;
}

module.exports = { cardOf, answerOf };
