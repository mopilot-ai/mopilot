// Computer-use policy: which grant level a call needs, which actions can't be undone, and what to do
// with a call (run it, ask the user, ask for a confirmation, or refuse it). Pure functions only; the
// tool handlers (electron/capabilities/tools/computer.cjs) do the asking.

const { prefixUnits } = require('../../../shared/textPrefix.mjs');
const { acpCurrentMode } = require('../../../shared/acpMode.mjs');
const { keySequence } = require('./desktopPolicy.cjs');

/** Grant levels, weakest first. View only: screenshots and the element list. Click: plain clicks and scrolling. */
const LEVELS = ['view', 'click', 'full'];
const LEVEL_LABEL = { view: 'View only', click: 'Click', full: 'Full control' };
/** How long a grant lasts: this call, this chat, or every chat (Settings → Computer use). */
const SCOPES = ['once', 'chat', 'always'];
/** No physical input for this long and nobody is watching (WP8-8). */
const IDLE_MS = 10 * 60_000;

const rank = (level) => LEVELS.indexOf(level);

/** The level a call needs. Right clicks, typing and key presses can do anything a person can. */
function requiredLevel(tool, args = {}) {
  switch (tool) {
    case 'computer_screenshot':
    case 'computer_elements':
    case 'computer_locate':
    case 'computer_describe':
      return 'view';
    case 'computer_scroll':
      return 'click';
    case 'computer_click':
      return args.button && args.button !== 'left' ? 'full' : 'click';
    default:
      return 'full';
  }
}

/** The strongest level any of the grants gives this app, or null. */
function grantedLevel(grants, bundleId) {
  if (!bundleId) return null;
  const id = String(bundleId).toLowerCase();
  let best = null;
  for (const g of grants || []) {
    if (!g || String(g.bundleId).toLowerCase() !== id || rank(g.level) < 0) continue;
    if (best === null || rank(g.level) > rank(best)) best = g.level;
  }
  return best;
}

/** Whether a user-added deny-list entry (a bundle id, or "prefix.*") covers the app. */
function denied(deny, bundleId) {
  if (!bundleId) return false;
  const id = String(bundleId).toLowerCase();
  return (deny || []).some((p) => {
    const pat = String(p).toLowerCase();
    if (pat.endsWith('.*')) {
      const stem = pat.slice(0, -2);
      return id === stem || id.startsWith(stem + '.');
    }
    return id === pat;
  });
}

/* -- irreversible actions ------------------------------------------- */
// What a control's label says it does. Order matters: "Send payment" is a payment.
/** @type {[verb: string, re: RegExp][]} */
const VERBS = [
  [
    'pay',
    /\b(pay|payment|purchase|buy|check ?out|place (an )?order|order now|subscribe|donate|transfer( money)?|send money)\b|付款|支付|购买|下单|转账/i,
  ],
  ['delete', /\b(delete|remove|erase|discard|empty trash|destroy|uninstall|wipe|move to trash|clear all)\b|删除|移除|清空|抹掉/i],
  ['send', /\b(send|post|publish|submit|tweet|invite)\b|发送|发布|提交/i],
  ['change permissions', /\b(grant access|revoke|make public|change permissions?)\b|授权|权限/i],
];
/** Apps where Return sends what was typed. */
const MESSAGING = new Set(
  [
    'com.apple.MobileSMS',
    'com.apple.mail',
    'com.tinyspeck.slackmacgap',
    'com.tencent.xinWeChat',
    'com.tencent.qq',
    'ru.keepcoder.Telegram',
    'org.telegram.desktop',
    'net.whatsapp.WhatsApp',
    'desktop.WhatsApp',
    'com.microsoft.teams2',
    'com.microsoft.Outlook',
    'com.hnc.Discord',
    'com.facebook.archon',
    'com.electron.lark',
    'com.bytedance.lark',
  ].map((s) => s.toLowerCase()),
);

/**
 * Roles whose label is content or a state, not an action: a text field's value is what the user wrote (a reminder
 * called "Buy milk"), a row or cell shows an item, and a toggle, tab or slider changes something a second click
 * changes back. A click on one of these never reads as irreversible from its label; the model's own flag still asks.
 */
const NOT_ACTIONS = new Set([
  'AXTextField',
  'AXTextArea',
  'AXSearchField',
  'AXComboBox',
  'AXRow',
  'AXCell',
  'AXOutline',
  'AXList',
  'AXTable',
  'AXCheckBox',
  'AXRadioButton',
  'AXSwitch',
  'AXTab',
  'AXDisclosureTriangle',
  'AXSlider',
  'AXIncrementor',
]);

const labelOf = (el) =>
  el
    ? [el.title, el.description, el.value, el.help]
        .filter((s) => typeof s === 'string' && s.trim())
        .join(' ')
        .trim()
    : '';
const clip = (s, n = 80) => (s.length > n ? `${prefixUnits(s, n - 1)}…` : s);

/**
 * Whether a call does something that can't be undone: {verb, summary}, or null.
 * `element` is the control a click lands on (from the last element list), when known, with its AX role: a role in
 * NOT_ACTIONS (content, toggles, selection) is never judged by its label.
 */
function irreversible(
  tool,
  args = {},
  /** @type {{ app?: { bundleId?: string } | null, element?: any }} */ { app = null, element = null } = {},
) {
  const messaging = !!app?.bundleId && MESSAGING.has(String(app.bundleId).toLowerCase());
  if (tool === 'computer_click') {
    const label = element && NOT_ACTIONS.has(element.role) ? '' : labelOf(element);
    for (const [verb, re] of VERBS) if (label && re.test(label)) return { verb, summary: clip(label) };
  } else if (tool === 'computer_key') {
    // key names as the helper reads them (meta, super and win are Command; backspace is delete), each combination
    // of a sequence ("cmd+a cmd+backspace")
    for (const combo of keySequence(String(args.key || '').replace(/\s*\+\s*/g, '+'))) {
      const mods = combo.split('+');
      const key = mods.pop();
      if ((key === 'delete' || key === 'forwarddelete') && mods.includes('cmd')) return { verb: 'delete', summary: `press ${args.key}` };
      if ((key === 'return' || key === 'enter') && messaging) return { verb: 'send', summary: 'press Return' };
    }
  } else if (tool === 'computer_type') {
    const text = String(args.text || '');
    if (messaging && /[\r\n]/.test(text)) return { verb: 'send', summary: clip(text.replace(/\s+/g, ' ').trim()) };
  }
  // the model can say so itself; that only ever adds a confirmation
  if (
    args.irreversible === true &&
    tool !== 'computer_screenshot' &&
    tool !== 'computer_elements' &&
    tool !== 'computer_locate' &&
    tool !== 'computer_describe'
  )
    return { verb: 'do this', summary: clip(String(args.summary || tool.replace('computer_', ''))) };
  return null;
}

/* -- attended or not ------------------------------------------------ */
/**
 * Why nobody is there to answer a card right now (a string), or null when someone is. Sage sent the
 * turn itself (a goal round, a re-sent /goal, a scheduled or background task, a sub-agent), or the
 * user hasn't touched the keyboard or mouse for ten minutes; on the basic tier, a tool call outside a
 * prompt is never attended.
 * @param {{ turn?: {human?: boolean, userEngaged?: boolean} | null, idleMs?: number, scheduled?: boolean, subagent?: boolean,
 *           basic?: boolean, promptActive?: boolean }} o
 */
function unattendedReason(o = {}) {
  if (o.scheduled) return 'a scheduled task';
  if (o.subagent) return 'a sub-agent';
  if (o.basic && !o.promptActive) return 'a tool call outside a prompt';
  if (!o.turn) return 'no turn you started';
  if (!o.turn.human && !o.turn.userEngaged) return 'a turn MoPilot started';
  if (typeof o.idleMs === 'number' && o.idleMs >= IDLE_MS) return 'no input for 10 minutes';
  return null;
}

/** Permission modes that only read: observe tools run, nothing else. */
const READ_ONLY = new Set(['plan', 'read-only', 'readOnly', 'dontAsk']);

/**
 * The authorization anchor of a chat: readOnly, ask, auto or full. Codex from the sandbox and approval
 * policy its turns run with (read-only sandbox is the read-only tier); Claude from the permission mode
 * it reports; a basic harness from its current mode id (session modes or a mode config option) through the
 * quirks anchors (unlisted: ask).
 * @param {{ harness?: string | null, permission?: string | null, acp?: { modes?: {currentModeId?: string | null} | null, configOptions?: unknown, anchors?: Record<string, string> | null } | null }} o
 * @returns {'readOnly' | 'ask' | 'auto' | 'full'}
 */
function anchorOf(o = {}) {
  const kind = String(o.harness || '');
  if (kind.startsWith('acp')) {
    const id = acpCurrentMode(o.acp);
    const a = id != null ? o.acp?.anchors?.[id] : null;
    return a === 'readOnly' || a === 'auto' || a === 'full' ? a : 'ask';
  }
  const m = o.permission;
  if (m && READ_ONLY.has(m)) return 'readOnly';
  if (m === 'full-access' || m === 'bypassPermissions') return 'full';
  if (m === 'auto-review' || m === 'auto' || m === 'acceptEdits') return 'auto';
  return 'ask';
}

/**
 * What to do with a call.
 * @param {{ tool: string, args?: any, app: {bundleId: string, name: string} | null, grants?: {bundleId: string, level: string}[],
 *           deny?: string[], unattended?: string | null, unattendedAllowed?: boolean, anchor?: string | null, permission?: string | null, irreversible?: {verb: string, summary: string} | null }} o
 * @returns {{ action: 'run' } | { action: 'ask', level: string } | { action: 'confirm' } |
 *           { action: 'refuse', code: string, message: string, pause?: boolean, grant?: string }}
 */
function decide(o) {
  const app = o.app;
  if (!app || !app.bundleId) return { action: 'refuse', code: 'unknown_app', message: "Couldn't tell which app this would reach" };
  if (denied(o.deny, app.bundleId))
    return { action: 'refuse', code: 'blocked', message: `${app.name} is blocked in Settings → Computer use` };
  const need = requiredLevel(o.tool, o.args);
  if (need !== 'view' && (o.anchor === 'readOnly' || (o.permission && READ_ONLY.has(o.permission))))
    return { action: 'refuse', code: 'read_only', message: 'This chat is in a read-only mode: computer use can only look' };
  // the remote switch: off, nothing runs without someone there, grant or not
  if (o.unattended && o.unattendedAllowed === false)
    return {
      action: 'refuse',
      code: 'unattended',
      pause: true,
      message: `Controlling ${app.name} with nobody here is switched off (${o.unattended}). MoPilot paused this chat and asked the user; don't retry.`,
    };
  const have = grantedLevel(o.grants, app.bundleId);
  if (have === null || rank(have) < rank(need)) {
    if (o.unattended)
      return {
        action: 'refuse',
        code: 'unattended',
        pause: true,
        message: `Controlling ${app.name} needs the user's OK, and nobody is here to give it (${o.unattended}). MoPilot paused this chat and asked the user; don't retry.`,
        grant: need,
      };
    return { action: 'ask', level: need };
  }
  if (o.irreversible) {
    if (o.unattended)
      return {
        action: 'refuse',
        code: 'unattended',
        pause: true,
        message: `This would ${o.irreversible.verb} in ${app.name}, which can't be undone, and nobody is here to confirm it (${o.unattended}). MoPilot paused this chat and asked the user; don't retry.`,
      };
    return { action: 'confirm' };
  }
  return { action: 'run' };
}

/**
 * The user's answer to a computerAccess card: {decision: 'allow'|'deny', scope, level}. Returns the
 * grant to use for this call and what to keep: null for deny or a level below what the call needs.
 */
function grantFromAnswer(answer, need) {
  if (!answer || answer.decision !== 'allow') return null;
  const scope = SCOPES.includes(answer.scope) ? answer.scope : 'once';
  const level = LEVELS.includes(answer.level) ? answer.level : need;
  if (rank(level) < rank(need)) return null;
  return { scope, level };
}

/** What the model gets back after an action: a screenshot, the element list, or both when the model's input is unknown. */
function observationKinds(modality) {
  if (modality === 'image') return ['screenshot'];
  if (modality === 'text') return ['elements'];
  return ['screenshot', 'elements'];
}

module.exports = {
  LEVELS,
  LEVEL_LABEL,
  SCOPES,
  IDLE_MS,
  rank,
  requiredLevel,
  grantedLevel,
  denied,
  irreversible,
  unattendedReason,
  anchorOf,
  decide,
  grantFromAnswer,
  observationKinds,
  READ_ONLY,
};
