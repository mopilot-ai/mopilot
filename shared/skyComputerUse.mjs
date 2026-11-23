// What Codex's computer use and browser, and Claude in Chrome, report back when a control step stops. Codex
// runs computer use on OpenAI's own Sky service (Codex Computer Use.app, SkyComputerUseService) and drives
// the user's Chrome with its Browser plugin, both reached through the app-server's cua_repl plugin. A stop
// reaches MoPilot only as the text of the call's error or output: the vendor's own message (what Codex
// App shows), and, when the program printed the error object, Sky's numeric code and error name or the
// Browser plugin's refusal reason. This module reads that text into one problem through the vendor error
// table (vendorErrors.mjs: code first, wording second): the vendor's message kept verbatim but for the
// sentences it addresses to the model, the code and name when present, and MoPilot's own short title,
// hint and fix around it. A code, name or stop it does not know is still a problem with a next step, never dropped.
//
// A vendor message that tells the user to open or relaunch a vendor desktop app (ChatGPT, the Claude app)
// is never passed on as sent: those sentences read as MoPilot's advice (vendorAppWording.mjs) and the
// problem offers Try again and Computer use settings; vendorAppProblem() does the same for any vendor tool.
// The tool result the model reads is not changed: vendors' "do not work around this" instructions reach it.
//
// Used by the thread narration (src/lib/agentNarration.ts), and by the Codex lifecycle in main
// (electron/capabilities/contract/codexLifecycle.cjs) so the Computer use settings can react when Sky reports
// a version it doesn't support or a missing permission.

/** Sky's server error codes by name, as its mac client reports them (read from the installed plugin). */
export const SKY_ERROR_CODES = Object.freeze({
  senderProcessNotAuthenticated: -10000,
  couldNotGetRequestData: -10001,
  couldNotGetRequestTypeName: -10002,
  couldNotResolveRequestType: -10003,
  unhandledEvent: -10004,
  unknownError: -10005,
  appNotAllowed: -10006,
  runningApplicationNotFound: -10007,
  accessibilityError: -10008,
  permissionsNotGranted: -10009,
  invalidApp: -10010,
  noActiveSession: -10011,
  userStoppedSession: -10012,
  incompatibleClientVersion: -10013,
  permissionsPending: -10014,
  blockedURL: -10015,
  userIntervened: -10016,
  couldNotGetSenderPID: -10017,
  ambiguousApp: -10018,
  couldNotGetBootstrapPort: -10019,
  screenLocked: -10020,
});
import { rewordVendorApp } from './vendorAppWording.mjs';
import { parseJson } from './jsonRecord.mjs';
import { isVendorInstructions } from './vendorInstructions.mjs';
import { SKY_MODEL_RECOVERS, VENDOR_SOURCES, vendorErrorByCode, vendorErrorByWording } from './vendorErrors.mjs';
import { prefixUnits } from './textPrefix.mjs';
import { staleGrantHint } from './staleGrant.mjs';

const NAME_OF = new Map(Object.entries(SKY_ERROR_CODES).map(([name, code]) => [code, name]));
/** Sky's numeric code for an error name, or null (a name that is not Sky's own, such as `constructor`, has none). */
const skyCode = (name) => (name != null && Object.hasOwn(SKY_ERROR_CODES, name) ? SKY_ERROR_CODES[name] : null);

/** System Settings → Privacy & Security panes Sky needs for "Codex Computer Use". */
export const PRIVACY_PANES = Object.freeze({
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
});

const SETTINGS = { kind: 'settings', label: 'Computer use settings', section: 'computer' };
/** Check computer use again (native.availability.retry): reinstalls a failed Codex Computer Use, forgets a missing permission. */
const RETRY = { kind: 'retry', label: 'Try again' };
const PERMISSION_ACTIONS = [
  { kind: 'url', label: 'Open Accessibility settings', url: PRIVACY_PANES.accessibility },
  { kind: 'url', label: 'Open Screen Recording settings', url: PRIVACY_PANES.screenRecording },
  RETRY,
];
/** Asks the chat's agent to run the step again (a message in the chat), for a stop that passes on its own. */
const AGAIN = { kind: 'send', label: 'Try again', text: 'Try that step again.' };
const BROWSER_SETTINGS = { kind: 'settings', label: 'Browser settings', section: 'browser' };
/** Restarts the Codex app-server, which lets go of what an earlier turn held. */
const RESTART_CODEX = { kind: 'restartCodex', label: 'Restart Codex' };

/** The next step for a stop MoPilot does not recognize: what usually gets past it. */
const UNRECOGNIZED_HINT = 'Try again. If it stops again, bring another tab or app to the front, or do this step yourself.';
/** The next step for a page the browser agent may not use. */
const OTHER_PAGE_HINT = 'Bring another tab or page to the front and try again, or open this page and do this step yourself.';

/** MoPilot's copy for each kind: a short title, what to do, and the steps that fix it. */
export const PROBLEM_KINDS = Object.freeze({
  permissions: {
    title: 'Codex Computer Use needs permission',
    // an update replaces the installed copy, so a switch that is already on can still belong to the old one
    hint: `In System Settings → Privacy & Security, turn on “Codex Computer Use” under Accessibility and Screen & System Audio Recording, then try again. ${staleGrantHint('Codex Computer Use', 'both lists', 'try again')}`,
    actions: PERMISSION_ACTIONS,
  },
  permissionsPending: {
    title: 'Codex Computer Use is waiting for permission',
    hint: 'Finish granting “Codex Computer Use” Accessibility and Screen & System Audio Recording in System Settings → Privacy & Security, then try again.',
    actions: PERMISSION_ACTIONS,
  },
  appBlocked: {
    title: 'Blocked by your organization',
    hint: "Your organization's policy doesn't let Codex Computer Use control this app. Do this step yourself.",
    actions: [],
  },
  appRefused: {
    title: "Codex Computer Use won't control this app",
    hint: "Codex Computer Use doesn't control this app for safety reasons. Do this step yourself.",
    actions: [],
  },
  notApproved: {
    title: 'Not approved',
    hint: 'Codex Computer Use was not allowed to use this app. Allow it when asked and try again, or do this step yourself.',
    actions: [],
  },
  blockedUrl: {
    title: 'Stopped at a blocked page',
    hint: `Codex Computer Use isn't allowed on the browser page in front, even when you open it yourself. ${OTHER_PAGE_HINT}`,
    actions: [],
  },
  serviceMissing: {
    title: "Codex Computer Use isn't installed",
    hint: "MoPilot installs Codex Computer Use when a copy of it is on this Mac. Until then, MoPilot's own computer use is the fallback.",
    actions: [SETTINGS],
  },
  serviceUnavailable: {
    title: "Codex Computer Use isn't running",
    hint: "Codex Computer Use didn't start. Try again; MoPilot's own computer use is the fallback.",
    actions: [SETTINGS],
  },
  versionMismatch: {
    title: 'Codex Computer Use needs an update',
    hint: "This Codex Computer Use version doesn't match the Codex plugin. MoPilot updates it when a newer copy is on this Mac; until then, new chats use MoPilot's own computer use.",
    actions: [SETTINGS],
  },
  screenLocked: { title: 'Your Mac is locked', hint: 'Unlock your Mac, then try again.', actions: [AGAIN] },
  userStopped: { title: 'Stopped by you', hint: 'Send a message when you want the agent to continue.', actions: [] },
  turnEnded: { title: 'Turn ended', hint: 'Codex Computer Use works again after the next message.', actions: [] },
  disabled: {
    title: 'Codex Computer Use is turned off',
    hint: 'Your Codex configuration turns off computer use. Turn it on there, or do this step yourself.',
    actions: [{ kind: 'settings', label: 'Codex settings', section: 'codex' }],
  },
  siteBlocked: {
    title: 'This site is blocked for browser control',
    hint: `The browser agent isn't allowed on this page. ${OTHER_PAGE_HINT}`,
    actions: [],
  },
  browserPolicy: {
    title: 'Blocked by a browser setting',
    hint: 'A browser, organization or saved permission setting blocks this action. Do this step yourself, or change that setting and try again.',
    actions: [BROWSER_SETTINGS, AGAIN],
  },
  browserDeclined: {
    title: 'Not allowed on this site',
    hint: 'The browser agent was not allowed to do this here. Allow it when asked and try again, or do this step yourself.',
    actions: [],
  },
  browserCheckUnavailable: {
    title: 'Safety check unavailable',
    hint: "The browser couldn't confirm this action is allowed. Try again in a moment.",
    actions: [AGAIN],
  },
  codexAppBrowser: {
    title: "Opened in the Codex app's browser, not your Chrome",
    hint: "Codex picked the ChatGPT extension inside the Codex app's own browser instead of your Chrome. Ask it to try again in your Chrome. If it happens again, quit the ChatGPT app, or remove the ChatGPT extension from its own browser.",
    actions: [],
  },
  chromeExtensionMissing: {
    title: "Your Chrome isn't set up",
    hint: "Your Chrome needs the Playwright Extension in the Chrome profile MoPilot uses, and it isn't installed there. Install it from Browser settings, or use the built-in browser.",
    actions: [BROWSER_SETTINGS],
  },
  chromePromptTimedOut: {
    title: 'Confirm in Chrome',
    hint: 'Claude in Chrome asks for permission in a small Claude window in Chrome, and nobody answered it in time. Keep Chrome visible, click Allow there when it asks, then try again.',
    actions: [AGAIN],
  },
  chromePromptUnavailable: {
    title: "Chrome couldn't ask for permission",
    hint: "Claude in Chrome couldn't open its permission window. Make sure Chrome is open and can show new windows, then try again.",
    actions: [AGAIN],
  },
  chromeDisconnected: {
    title: "Claude in Chrome isn't connected",
    hint: 'Make sure Chrome is open with the Claude extension, signed in to the same claude.ai account as Claude Code, then try again.',
    actions: [BROWSER_SETTINGS, AGAIN],
  },
  chromeConnectionLost: {
    title: 'Lost the connection to Chrome',
    hint: 'Claude in Chrome lost its connection during this step, so it may or may not have run. Keep Chrome open and awake, then try again.',
    actions: [AGAIN, BROWSER_SETTINGS],
  },
  chromeNoResponse: {
    title: "Chrome didn't respond",
    hint: 'The page or Chrome may be busy, or Chrome may be waiting for you. Check Chrome, then try again.',
    actions: [AGAIN],
  },
  cleanupBlocked: {
    title: 'Blocked until Codex lets go',
    hint: "Codex didn't confirm it released your browser or computer after an earlier turn, so MoPilot didn't let this step run. Restart Codex, then try again.",
    actions: [RESTART_CODEX],
  },
  requestStopped: {
    title: 'Stopped with the turn',
    hint: 'The turn ended while this step waited for Codex to release the computer, so it never ran. Send a message to try it again.',
    actions: [AGAIN],
  },
  stopped: { title: 'Control stopped', hint: UNRECOGNIZED_HINT, actions: [AGAIN] },
  unknown: { title: 'Codex Computer Use error', hint: UNRECOGNIZED_HINT, actions: [AGAIN] },
  vendorApp: { title: "Computer use couldn't continue", hint: null, actions: [RETRY, SETTINGS] },
});

/** A problem's message and actions once a request to open a vendor desktop app is in MoPilot's words. */
function mopilotWording(message, actions) {
  const reworded = rewordVendorApp(message);
  if (reworded === null) return { message, actions };
  const settings = actions.some((a) => a.kind === 'settings');
  // one Try again, first, whether the kind already offers one
  return { message: reworded, actions: [RETRY, ...actions.filter((a) => a.kind !== 'retry'), ...(settings ? [] : [SETTINGS])] };
}

/**
 * Sentences vendors address to the model, not the user (Sky's "Stop your work and send a final message",
 * the Browser plugin's "The agent must not attempt … workaround"). The model still reads them in the tool
 * result; the step shows the rest.
 */
const TO_MODEL =
  /^(?:Stop your work\b|The agent (?:must|may)\b|Proceed only with\b|Call this tool again\b|Do not end your turn\b|This failure may be temporary\b)/;
/** Vendor instructions that end the model's control work: a stop even when no row knows the message. */
const STOP_INSTRUCTION = /\bStop your work and send a final message\b|\bmust not attempt to achieve the same outcome via workaround\b/i;

/** A vendor message without the sentences meant for the model; the message as sent when nothing else is left. */
function forUser(message) {
  const kept = message
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !TO_MODEL.test(sentence))
    .join(' ')
    .trim();
  return kept || message;
}

/** Text that names Sky without a message this module knows: an unknown Sky problem when the call failed. */
const SKY_MENTION = /\bSkyComputerUse(?:Transport)?Error\b|\bSky Computer Use\b|\bComputer Use\b/;
/** Text that names the Codex Browser plugin: a stop when the call failed. */
const BROWSER_MENTION = /\bBrowser Use\b/;

const MAX_MESSAGE = 400;
const clip = (s) => (s.length > MAX_MESSAGE ? `${prefixUnits(s, MAX_MESSAGE - 1)}…` : s);
/** The line of `text` a pattern matched, trimmed: the vendor's message as it was sent. */
function lineOf(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end < 0 ? text.length : end).trim();
}
/** The first non-empty line of a text (one that is not blank). */
const firstLine = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);

/** Every JSON object a text holds: the whole text, or one per line. */
function objects(text) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    out.push(v);
    Object.values(v).forEach(walk);
  };
  const whole = parseJson(text);
  if (whole.ok) walk(whole.value);
  else
    for (const line of text.split('\n')) {
      if (!/^\s*[[{]/.test(line)) continue;
      // a line that is not JSON carries no structured problem
      const parsed = parseJson(line);
      if (parsed.ok) walk(parsed.value);
    }
  return out;
}

const isSkyCode = (n) => Number.isInteger(n) && n <= -10000 && n > -10100;
const messageOf = (o) => (typeof o.message === 'string' ? o.message.trim() : '');

/**
 * A Sky error the program printed: an object with Sky's error name or a code in Sky's range (JSON), or the
 * fields Node prints for a SkyComputerUseError (`code: -10009`, `errorName: 'permissionsNotGranted'`).
 */
function structured(text) {
  for (const o of objects(text)) {
    const name = typeof o.errorName === 'string' && o.errorName ? o.errorName : null;
    const code = isSkyCode(o.code) ? o.code : null;
    if (name || code != null || o.name === 'SkyComputerUseError') {
      return { code: code ?? skyCode(name), name: name ?? NAME_OF.get(code) ?? null, message: messageOf(o) };
    }
  }
  if (!/\bSkyComputerUseError\b/.test(text)) return null;
  const code = /\bcode['"]?\s*[:=]\s*(-1\d{4})\b/.exec(text);
  const name = /\berrorName['"]?\s*[:=]\s*['"]?([A-Za-z]+)/.exec(text);
  const n = code ? Number(code[1]) : null;
  return { code: isSkyCode(n) ? n : null, name: name?.[1] ?? (isSkyCode(n) ? (NAME_OF.get(n) ?? null) : null), message: '' };
}

/**
 * A BrowserUseSecurityError the program printed (the Codex Browser plugin's refusal): its reason, from the
 * JSON object or the `reason: 'site_status_blocked'` field Node prints, and its own message. Null for any other text.
 */
function browserError(text, failed) {
  const at = text.search(/\bBrowserUseSecurityError\b/);
  if (at < 0) return null;
  for (const o of objects(text))
    if (o.name === 'BrowserUseSecurityError') return { reason: typeof o.reason === 'string' ? o.reason : null, message: messageOf(o) };
  // Node's printout only in a failed call (a program that caught the error and went on prints its name too),
  // and its reason only from the printout's own fields, not from page text after it
  if (!failed) return null;
  const end = text.indexOf('\n}', at);
  const reason = /\breason['"]?\s*[:=]\s*['"]([a-z_]+)['"]/.exec(text.slice(at, end < 0 ? text.length : end));
  return { reason: reason?.[1] ?? null, message: '' };
}

/** A problem of `kind` with its copy, the vendor's message for the user, and MoPilot's actions. */
function problemOf(kind, code, name, message) {
  const copy = PROBLEM_KINDS[kind];
  const worded = mopilotWording(clip(forUser(message)), copy.actions);
  return {
    kind,
    code,
    name,
    message: worded.message,
    title: copy.title,
    hint: copy.hint,
    actions: worded.actions.map((a) => ({ ...a })),
  };
}

/**
 * The problem a cua_repl call's text reports (Sky's computer use or the Codex Browser plugin), or null.
 * A printed error's code or reason decides first, then the vendor's wording; a vendor stop instruction or
 * a printed BrowserUseSecurityError with neither is a generic stop. `failed`: the call itself failed, so
 * text that only mentions Sky reads as an unknown Sky problem, and one that mentions Browser Use as a stop;
 * a call that completed reports a problem only through a printed error object or a one-line vendor message.
 * The returned message is the vendor's own (clipped at 400 characters, without its sentences to the
 * model); title, hint and actions are MoPilot's.
 * @param {unknown} text
 * @param {{ failed?: boolean }} [o]
 */
export function skyProblem(text, { failed = false } = {}) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const s = structured(text);
  const b = s ? null : browserError(text, failed);
  // a program that worked can print page text with the vendor's words in it: its output counts only when
  // it is the vendor's one-line message itself, or a printed error object
  const vendorSaid = failed || !!s || !!b || !text.trim().includes('\n');
  const byCode = vendorErrorByCode([s?.name, b?.reason], VENDOR_SOURCES.cua);
  const byWording = vendorSaid ? vendorErrorByWording(text, VENDOR_SOURCES.cua) : null;
  const stop = vendorSaid ? STOP_INSTRUCTION.exec(text) : null;
  let kind = byCode?.kind ?? byWording?.row.kind ?? null;
  if (!kind) {
    // a pause the model recovers from by itself, even with Sky's error name on it
    if (SKY_MODEL_RECOVERS.some((re) => re.test(text))) return null;
    if (s) kind = 'unknown';
    else if (b || stop) kind = 'stopped';
    else if (failed && SKY_MENTION.test(text)) kind = 'unknown';
    else if (failed && BROWSER_MENTION.test(text)) kind = 'stopped';
    else return null;
  }
  const name = s?.name ?? b?.reason ?? byWording?.row.name ?? null;
  const at = byWording?.index ?? stop?.index;
  const message = s?.message || b?.message || (at != null ? lineOf(text, at) : firstLine(text));
  return problemOf(kind, s?.code ?? skyCode(name), name, message);
}

/**
 * A stop MoPilot itself caused, rather than the vendor or the user: a step whose approval MoPilot
 * declined because the plugin's last release failed (`cleanupBlocked`), or because its turn ended while the
 * request waited for that release (`requestStopped`). `message` is the step's own text.
 * @param {'cleanupBlocked' | 'requestStopped'} kind
 * @param {string} message
 */
export function hostProblem(kind, message) {
  return problemOf(kind, null, null, message);
}

/**
 * Another vendor's control tool reporting a stop the vendor error table knows (Claude in Chrome: `sources`
 * VENDOR_SOURCES.claudeInChrome), or null. A page's own text can say the same words, so only a failed
 * call counts, or a result that starts with the vendor's sentence from a tool that does not read pages (`read`).
 * @param {unknown} text
 * @param {{ sources: readonly string[], failed?: boolean, read?: boolean }} o
 */
export function vendorProblem(text, { sources, failed = false, read = false }) {
  if (typeof text !== 'string') return null;
  const hit = vendorErrorByWording(text, sources);
  if (!hit || (!failed && (read || text.slice(0, hit.index).trim()))) return null;
  return problemOf(hit.row.kind, null, hit.row.name, lineOf(text, hit.index));
}

/**
 * Any vendor control tool's text that sends the user to a vendor desktop app (Claude in Chrome, Claude's
 * computer use, Codex's plugins), as a problem in MoPilot's words; null for any other text.
 * @param {unknown} text
 */
export function vendorAppProblem(text) {
  const message = rewordVendorApp(text);
  if (message === null) return null;
  const copy = PROBLEM_KINDS.vendorApp;
  return {
    kind: 'vendorApp',
    code: null,
    name: null,
    message: clip(message),
    title: copy.title,
    hint: null,
    actions: copy.actions.map((a) => ({ ...a })),
  };
}

/** What a problem reads as in one line: the vendor's message, with the raw code and name for an unknown one. */
export function skyProblemText(p) {
  if (p.kind !== 'unknown') return p.message;
  const id = [p.name, p.code].filter((x) => x != null).join(' ');
  return `${p.title}${id ? ` (${id})` : ''}: ${p.message}`;
}

/** The text of a cua_repl tool call item (Codex mcpToolCall): its error, or its output's text blocks without the plugin's instructions. */
function itemText(item) {
  if (typeof item?.error?.message === 'string' && item.error.message) return item.error.message;
  const blocks = Array.isArray(item?.result?.content) ? item.result.content : [];
  return blocks
    .filter((b) => typeof b?.text === 'string' && !isVendorInstructions(b.text))
    .map((b) => b.text)
    .join('\n');
}

/** The Sky problem a finished cua_repl call item reports, or null. */
export function skyProblemOfItem(item) {
  const failed = item?.status === 'failed' || !!item?.error || item?.result?.isError === true;
  return skyProblem(itemText(item), { failed });
}

/**
 * Whether a finished cua_repl call item completed without an error, and nothing in its output reads as a stop
 * (read as strictly as a failed call's: a program can catch Sky's error and print it among other lines): for a
 * program that acted on the desktop, proof Codex Computer Use had the permissions it needs.
 */
export function skyStepWorked(item) {
  return item?.status === 'completed' && !item.error && item.result?.isError !== true && !skyProblem(itemText(item), { failed: true });
}

/** The CFBundleShortVersionString of an XML Info.plist, or null (a binary plist reads as unknown). */
export function plistVersion(xml) {
  if (typeof xml !== 'string') return null;
  const m = /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>\s*([^<]*?)\s*<\/string>/.exec(xml);
  return m && m[1] ? m[1] : null;
}

/** Compares dotted numeric versions ("26.1005.1001425"); null when either is not one. */
export function compareVersions(a, b) {
  const parse = (v) => (typeof v === 'string' && /^\d+(?:\.\d+)*$/.test(v) ? v.split('.').map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Version folder names newest first by numeric comparison ("26.10" after "26.9"); names that are not a
 * dotted version (a `latest` link, a staging folder) are left out, never sorted in as text.
 * @param {string[]} names
 */
export function versionsNewestFirst(names) {
  return names.filter((n) => compareVersions(n, n) === 0).sort((a, b) => /** @type {number} */ (compareVersions(b, a)));
}
