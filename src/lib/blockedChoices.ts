// Ways forward when browser or desktop control was refused: which one-click choices a refusal offers
// (allow the site, open it in your browser, take over, allow the app or screen control) and what each tells the agent.
//
// Read from the turn's tool items: MoPilot's own browser_* tools explain a refusal in a <refusal
// reason=…> block (electron/capabilities/browser/refusals.cjs); the desktop_* tools say an app or screen
// control was not allowed. The tools are named the same under every harness (Codex dynamic tools,
// Claude Code and ACP MCP calls; Claude Code's mopilot_browser and mopilot_computer servers by short names), so
// every harness gets the same choices. The Codex Browser plugin's
// programs (cua_repl) carry the same block when MoPilot's in-app browser backend refused them. A
// blocked risk class offers none: it only says why. A chat in a read-only mode offers to change the mode (the
// composer's permission menu), the one way on there.
//
// A refusal names its browser (browser="chrome" for Your Chrome, "iab" for the plugin's backend): "Allow this
// site" allows it in that browser's own site table, and a refusal in the user's Chrome offers no in-app tab
// to take over and no "open in Chrome": the user does the step themselves there. A site the user blocked in Codex
// Browser Use (which applies in every chat, #1319 G13) offers its settings; a policy's block names its owner only.
import { ownTable } from '../../shared/ownTable.mjs';
import { toolInvocation } from '../../shared/toolInvocation.mjs';
import { proseLinks } from '../../shared/proseLinks.mjs';
import { controlStep, cuaProgram, hostOf, ownBrowserTool, ownChromeTool, ownDesktopTool } from './agentNarration';
import type { SiteBrowser } from './native';
import { toolOutput } from './toolOutput';

export type BlockedChoice =
  | 'allowSite'
  | 'allowWrite'
  | 'openInBrowser'
  | 'takeOver'
  | 'allowApps'
  | 'allowScreen'
  | 'doItMyself'
  | 'siteSettings'
  | 'changeMode';
/** The choices about a site, which need the site the refusal names. */
const SITE_CHOICES = new Set<BlockedChoice>(['allowSite', 'allowWrite', 'openInBrowser']);

export interface Blocked {
  /** the tool item that was refused */
  id: string;
  surface: 'browser' | 'desktop';
  /** the refusal's stable reason (refusals.cjs), or the desktop one: app_denied, app_not_granted, screen_denied */
  reason: string;
  /** the site refused (an origin), when the refusal names one */
  origin: string | null;
  /** the browser refused (each keeps its own site table): the in-app browser unless the refusal names the user's Chrome */
  browser: SiteBrowser;
  /** the apps refused */
  apps: string[];
  /** what happened, in one line */
  text: string;
  /** what the user can do about it, in order; none: only the reason shows */
  choices: BlockedChoice[];
}

/** A browser refusal reason -> what the strip says and the choices it offers ({host}: the site's host). */
const BROWSER: Record<string, { text: string; choices: BlockedChoice[] }> = ownTable({
  site_permission_denied: { text: 'You didn’t allow {host}.', choices: ['allowSite', 'openInBrowser', 'takeOver'] },
  site_read_only: { text: '{host} is read only in this chat.', choices: ['allowWrite', 'takeOver'] },
  signin_cancelled: { text: '{host} needs you to sign in.', choices: ['takeOver', 'openInBrowser'] },
  password_field: { text: '{host} needs you to sign in.', choices: ['takeOver', 'openInBrowser'] },
  sensitive_action_declined: { text: 'You declined an action on {host}.', choices: ['takeOver'] },
  action_declined: { text: 'You declined an action on {host}.', choices: ['takeOver'] },
  user_declined: { text: 'You declined this step.', choices: ['takeOver'] },
  site_blocked: { text: 'This site is blocked for browser control. Do this step yourself if you need it.', choices: [] },
  codex_site_blocked: { text: '{host} is blocked in your Codex Browser Use settings.', choices: ['siteSettings'] },
  // a policy's block names its owner only: Browser settings can't change it (#1319 G13)
  codex_policy_blocked: {
    text: '{host} is blocked by a Codex Browser Use policy. Ask whoever manages Codex, or do this step yourself.',
    choices: [],
  },
  chat_read_only: { text: 'This chat is in a read-only mode: the browser can only look.', choices: ['changeMode'] },
});

const REFUSAL = /<refusal reason="([a-z_]+)"[^>]*?(?: browser="(iab|chrome)")?>/;

/** The origin a refusal names (in its message, else the URL the call was given), or null. */
function originIn(text: string, args: Record<string, unknown>): string | null {
  const found = proseLinks(text)[0] ?? (typeof args.url === 'string' ? args.url : '');
  try {
    const u = new URL(found);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

/** The apps a desktop_request_access result lists as not allowed by the user. */
function userDeniedApps(text: string): string[] {
  try {
    const out = JSON.parse(text) as { denied?: { app?: string; reason?: string }[] };
    return (out.denied ?? []).filter((d) => d.reason === 'the user did not allow it' && d.app).map((d) => String(d.app));
  } catch {
    return [];
  }
}

/** The refusal a tool item is, with its choices, or null when it was not refused (or offers nothing to show). */
export function blockedOf(item: unknown): Blocked | null {
  item = toolInvocation(item);
  const call = item as { id?: unknown; tool?: unknown; arguments?: unknown } | null;
  // MoPilot's browser and desktop tools are named the same under every harness, except Claude Code's mopilot_browser and
  // mopilot_computer short names
  // MoPilot's own Chrome tools (chrome_*) refuse on the user's Chrome's site table; only a failed call is a refusal there,
  // never a page's text that reads like one
  const ownChrome = ownChromeTool(item);
  const browser = ownChrome ? (ownChrome.failed ? ownChrome : null) : ownBrowserTool(item);
  const desktop = browser || ownChrome ? null : ownDesktopTool(item);
  // a Codex Browser plugin program refused by MoPilot's in-app browser backend reads like a browser_* refusal
  const t = browser
    ? { surface: 'browser' as const, name: browser.name }
    : desktop
      ? { surface: 'desktop' as const, name: desktop.name }
      : cuaProgram(item)
        ? { surface: 'browser' as const, name: 'js' }
        : null;
  if (!t) return null;
  const id = String(call!.id ?? '');
  const args = (call!.arguments && typeof call!.arguments === 'object' ? call!.arguments : {}) as Record<string, unknown>;
  const text = toolOutput(item).text;
  if (t.surface === 'browser') {
    const m = REFUSAL.exec(text);
    const reason = m?.[1];
    const rule = reason ? BROWSER[reason] : undefined;
    if (!rule) return null;
    const browser: SiteBrowser = ownChrome || m?.[2] === 'chrome' ? 'chrome' : 'iab';
    const origin = originIn(text, args);
    // a choice about a site needs the site; in the user's Chrome, the user takes the step over there (no in-app tab, already in Chrome)
    const offered =
      browser === 'chrome'
        ? rule.choices.flatMap((c) => (c === 'takeOver' ? ['doItMyself' as const] : c === 'openInBrowser' ? [] : [c]))
        : rule.choices;
    const choices = origin ? offered : offered.filter((c) => !SITE_CHOICES.has(c));
    return {
      id,
      surface: 'browser',
      reason: reason!,
      origin,
      browser,
      apps: [],
      text: rule.text.replace('{host}', origin ? hostOf(origin) : 'This site'),
      choices,
    };
  }
  const denied = t.name === 'request_access' ? userDeniedApps(text) : [];
  if (denied.length)
    return {
      id,
      surface: 'desktop',
      reason: 'app_denied',
      origin: null,
      browser: 'iab',
      apps: denied,
      text: `You didn’t allow ${denied.join(', ')}.`,
      choices: ['allowApps', 'doItMyself'],
    };
  const missing = /^(.+?) isn't granted in this chat\b/.exec(text)?.[1];
  if (missing)
    return {
      id,
      surface: 'desktop',
      reason: 'app_not_granted',
      origin: null,
      browser: 'iab',
      apps: [missing],
      text: `${missing} isn’t allowed in this chat.`,
      choices: ['allowApps', 'doItMyself'],
    };
  // a read-only chat: desktop control can only look; the mode is the one way on there, as for the browser
  if (/This chat is in a read-only mode: desktop control can only look/.test(text))
    return {
      id,
      surface: 'desktop',
      reason: 'chat_read_only',
      origin: null,
      browser: 'iab',
      apps: [],
      text: 'This chat is in a read-only mode: computer use can only look.',
      choices: ['changeMode'],
    };
  if (/didn't allow MoPilot(?: Code)? to control the screen/.test(text))
    return {
      id,
      surface: 'desktop',
      reason: 'screen_denied',
      origin: null,
      browser: 'iab',
      apps: [],
      text: 'You didn’t allow screen control.',
      choices: ['allowScreen', 'doItMyself'],
    };
  return null;
}

/**
 * The refusal a turn ends on: the last control step among `items` was refused. A later control step
 * (the agent went on another way) or none at all is no refusal.
 */
export function latestBlocked(items: unknown[]): Blocked | null {
  for (let i = items.length - 1; i >= 0; i--) {
    if (!controlStep(items[i])) continue;
    return blockedOf(items[i]);
  }
  return null;
}

/** A choice's button label. `chrome`: Your Chrome is set up, so "Open in your browser" opens the site there. */
export function choiceLabel(choice: BlockedChoice, b: Blocked, chrome = false): string {
  switch (choice) {
    case 'allowSite':
      return 'Allow this site';
    case 'allowWrite':
      return 'Allow changes here';
    case 'openInBrowser':
      return chrome ? 'Open in your Chrome' : 'Open in your browser';
    case 'takeOver':
    case 'doItMyself':
      return 'I’ll take over';
    case 'allowApps':
      return `Allow ${b.apps.length === 1 ? b.apps[0] : 'these apps'}`;
    case 'allowScreen':
      return 'Allow screen control';
    case 'siteSettings':
      return 'Browser settings';
    case 'changeMode':
      return 'Change mode';
  }
}

/**
 * What a choice tells the agent so it carries on. `done`: the user finished the step themselves (after
 * "I'll take over" or "Open in your browser"); otherwise the message that goes with the choice itself.
 */
export function followUpFor(choice: BlockedChoice, b: Blocked, done = false): string {
  const host = b.origin ? hostOf(b.origin) : 'the site';
  if (done)
    return b.surface === 'browser'
      ? choice === 'openInBrowser'
        ? `I finished that step on ${host} in my own browser. Continue the task from there.`
        : b.browser === 'chrome'
          ? 'I did that step myself in my Chrome. Take a fresh snapshot first, then continue the task.'
          : 'I did that step myself in the browser. Check the page again first, then continue the task.'
      : 'I did that step myself. Look at the screen again first, then continue the task.';
  switch (choice) {
    case 'allowSite':
      return `I allowed ${host} for this chat. Continue the task.`;
    case 'allowWrite':
      return `I allowed ${host} to read and change pages for this chat. Continue the task.`;
    case 'allowApps':
      return `You can use ${b.apps.join(', ')} now: ask for access again and I'll allow it, then continue the task.`;
    default:
      return "Try that step again: I'll allow screen control this time.";
  }
}

/** What "Allow this site" tells the agent when the site is high-risk: no grant, its card asks again. */
export const askAgainMessage = (b: Blocked) =>
  `Try ${b.origin ? hostOf(b.origin) : 'the site'} again: I'll answer when it asks for permission.`;
