// Browser handoffs and reported tabs from built-in and vendor control results.
import { isIdentityProvider } from '../../../shared/browser.mjs';
import { MOVED_PREFIX } from '../../../shared/chromeHandoff.mjs';
import { maskCua } from '../../../shared/cuaProgram.mjs';
import { vendorProblem } from '../../../shared/skyComputerUse.mjs';
import { VENDOR_SOURCES } from '../../../shared/vendorErrors.mjs';
import { proseLinks } from '../../../shared/proseLinks.mjs';
import { q, type ToolArgs, type Handoff, type HandoffReason, type BrowserWhere, type ControlCall, type SeenTab } from './common';
const CAPTCHA = /\b(?:captcha|recaptcha|hcaptcha|are you a robot|verify (?:that )?you(?:'re| are)(?: a)? human|human verification)\b/i;
const SIGN_IN = /\b(?:sign[- ]?in|log[- ]?in|password|two[- ]factor|2fa|verification code|one[- ]time code|authenticat\w*|credentials?)\b/i;
const PAYMENT = /\b(?:payment|checkout|pay now|card details|billing)\b/i;
const TOOK_OVER = /\buser_took_over\b|\btook (?:over|control)\b|\bstopped in the extension\b/i;
/** Words a tool result uses when it stops for the user, as opposed to a page that merely shows a "Sign in" link. */
const PAUSED =
  /\b(?:captcha (?:detected|challenge|required)|blocked by (?:a )?captcha|(?:login|sign[- ]in) (?:is )?required|please (?:sign|log) in|requires? (?:the )?user|user (?:needs|must) to|waiting for the user|needs? (?:the )?user to)\b/i;

/** What the user has to do, from what the agent wrote or the page said. */
function reasonOf(text: string): HandoffReason {
  if (TOOK_OVER.test(text)) return 'tookOver';
  if (CAPTCHA.test(text)) return 'captcha';
  if (SIGN_IN.test(text)) return 'signIn';
  return PAYMENT.test(text) ? 'payment' : 'continue';
}

/** The first web address in a text, without the sentence punctuation after it. */
const firstUrl = (text: string) => proseLinks(text)[0] ?? null;

/** MoPilot's in-app browser (browser_* tools): a secure sign-in request, a tab marked "handoff", or a navigation that landed on a sign-in page. */
export function builtinHandoff(name: string, a: ToolArgs, result: string): Handoff | null {
  // waiting, or no longer waiting without the user done (the turn ended): once they signed in, the agent went on
  // the user took the sign-in to their Chrome (shared/chromeHandoff.mjs movedNote): their turn is in Chrome now
  if (name === 'request_signin' && result.startsWith(MOVED_PREFIX))
    return { where: 'chrome', reason: 'signIn', url: firstUrl(result), tabId: null };
  // a call from before #1834 waited and said so once the user was done; one now returns at once, and the user's turn follows
  if (name === 'request_signin')
    return /^The user finished signing in\b/.test(result)
      ? null
      : {
          where: 'app',
          reason: typeof a.reason === 'string' && CAPTCHA.test(a.reason) ? 'captcha' : 'signIn',
          url: null,
          tabId: typeof a.tabId === 'string' ? a.tabId : null,
          signin: true,
          note: typeof a.reason === 'string' ? q(a.reason, 160) : '',
        };
  if (name === 'tabs_mark')
    return a.status === 'handoff'
      ? { where: 'app', reason: reasonOf(result), url: null, tabId: typeof a.tabId === 'string' ? a.tabId : null }
      : null;
  // a browser_script that calls tab.markHandoff() (the agent says why in its comments or strings)
  if (name === 'script')
    return typeof a.code === 'string' && /\.\s*markHandoff\s*\(/.test(maskCua(a.code).code)
      ? { where: 'app', reason: reasonOf(`${a.code}\n${result}`), url: null, tabId: null }
      : null;
  // "Navigated <tab> to <url> (title)." from browser_navigate and browser_tabs_create
  const nav = /\bNavigated (\S+) to (\S+)/.exec(result);
  return nav && isIdentityProvider(nav[2]) ? { where: 'app', reason: 'signIn', url: nav[2], tabId: nav[1] } : null;
}

/**
 * MoPilot's own Chrome tools (chrome_*): what they report, never what a page says. A bot check its gate refused
 * (refusals.cjs, the call failed) is the user's to complete in their Chrome; a navigation that landed on a sign-in page
 * ("Navigated <tab> to <url>", as browser_navigate says it) is theirs to sign in on. The tab is in the chat's group in
 * Chrome, so the hand-off names no address to open again (a sign-in page opened anew loses its flow).
 */
export function ownChromeHandoff(c: ControlCall): Handoff | null {
  const tabId = typeof c.args.tabId === 'number' || typeof c.args.tabId === 'string' ? String(c.args.tabId) : null;
  if (c.failed) return /<refusal reason="bot_check"/.test(c.result) ? { where: 'chrome', reason: 'captcha', url: null, tabId } : null;
  const nav = c.tool === 'navigate' ? /\bNavigated (\S+) to (\S+)/.exec(c.result) : null;
  return nav && isIdentityProvider(nav[2]) ? { where: 'chrome', reason: 'signIn', url: null, tabId: nav[1] } : null;
}

/** Claude in Chrome tools that only read the page: a page's own text never counts as a pause. */
export const READS = /^(?:get_page_text|read_page|find|read_console_messages|read_network_requests|javascript_tool|tabs_context_mcp)$/;

/** Claude in Chrome: it asks for sign-in details, lands on a sign-in page, or says the page waits for the user. */
export function chromeHandoff(c: ControlCall): Handoff | null {
  const url = firstUrl(c.result);
  if (c.tool === 'request_credentials') return { where: 'chrome', reason: 'signIn', url, tabId: null };
  if (url && /^navigate/.test(c.tool) && isIdentityProvider(url)) return { where: 'chrome', reason: 'signIn', url, tabId: null };
  if (READS.test(c.tool) || !(PAUSED.test(c.result) || TOOK_OVER.test(c.result))) return null;
  // a stop the step shows as a problem ("Chrome may be waiting for the user" after a timeout) is not a hand-off
  if (vendorProblem(c.result, { sources: VENDOR_SOURCES.claudeInChrome, failed: c.failed })) return null;
  return { where: 'chrome', reason: reasonOf(c.result), url, tabId: null };
}

/** One tab line in a Claude in Chrome result's "Available tabs:" footer: `  • tabId 12: "Title" ("https://…")`. */
const TAB_LINE = /^\s*•\s*tabId\s+(\d+):\s*"(.*)"\s*\("([^"]*)"\)\s*$/;

/** The tabs a Claude in Chrome result lists: tabs_context_mcp's JSON, or any tool's "Available tabs:" footer. */
export function chromeTabs(c: ControlCall): SeenTab[] {
  const tab = (tabId: unknown, title: unknown, url: unknown): SeenTab => ({
    where: 'chrome',
    tabId: String(tabId),
    title: String(title ?? '') || String(url),
    url: String(url),
    browserId: null,
  });
  const at = c.result.lastIndexOf('Available tabs:');
  if (at >= 0)
    return c.result
      .slice(at)
      .split('\n')
      .slice(1)
      .map((line) => TAB_LINE.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => tab(m[1], m[2], m[3]));
  try {
    const list = JSON.parse(c.result).availableTabs;
    return Array.isArray(list) ? list.filter((t) => t && t.url).map((t) => tab(t.tabId, t.title, t.url)) : [];
  } catch {
    return [];
  }
}

/**
 * Whether a cua_repl program works in MoPilot's in-app browser: it names the plugin's "iab" backend
 * (agent.browsers.get("iab"), createBrowserTab("iab")), which MoPilot serves on its own pane.
 */
export function usesInAppBrowser(code: string): boolean {
  for (const value of maskCua(code).strings.values()) if (value === 'iab') return true;
  return false;
}

/** Code just before a string that names a browser by its id: createBrowserTab's first argument, browsers.get's, a `browser:` option. */
const NAMES_BROWSER = /(?:\bcreateBrowserTab\s*\(\s*|\bbrowsers\s*\.\s*get\s*\(\s*|\bbrowser\s*:\s*)$/;

/**
 * The browsers a program's cua.getState() printed, by id (#1319 G26): the plugin numbers its backends per thread
 * ("1", "2", in no fixed order), so only its "iab" one is the in-app browser; every other is a Chrome.
 */
function browserIds(calls: ControlCall[]): Map<string, BrowserWhere> {
  const ids = new Map<string, BrowserWhere>();
  for (const c of calls) {
    if (c.tool !== 'js') continue;
    for (const value of printed(c.result)) {
      const list = (value as { browsers?: unknown } | null)?.browsers;
      if (!Array.isArray(list)) continue;
      for (const b of list)
        if (typeof b?.id === 'string' && typeof b?.type === 'string') ids.set(b.id, b.type === 'iab' ? 'app' : 'chrome');
    }
  }
  return ids;
}

/**
 * Which browser a cua_repl program names: the plugin's "iab" backend (MoPilot's in-app browser), its "chrome"
 * backend or the user's Chrome tabs (browser.user), a backend by the id getState() gave it (`ids`), or none (it acts
 * on variables an earlier program bound).
 */
export function cuaBrowserOf(code: string, ids: Map<string, BrowserWhere> = new Map()): BrowserWhere | null {
  if (usesInAppBrowser(code)) return 'app';
  const masked = maskCua(code);
  for (const [at, value] of masked.strings) {
    if (value === 'chrome') return 'chrome';
    const where = ids.get(value);
    if (where && NAMES_BROWSER.test(masked.code.slice(Math.max(0, at - 40), at))) return where;
  }
  return /\bbrowser\s*\.\s*user\b/.test(masked.code) ? 'chrome' : null;
}

/**
 * The browser a program acts in: the one it names, else the one the latest earlier program named (cua_repl keeps a
 * tab bound across calls), else the user's Chrome. Backend ids are read from what getState() printed, this program's
 * included.
 */
function cuaWhere(c: ControlCall, earlier: ControlCall[]): BrowserWhere {
  const ids = browserIds([...earlier, c]);
  const own = cuaBrowserOf(String(c.args.code), ids);
  if (own) return own;
  for (let i = earlier.length - 1; i >= 0; i--) {
    const e = earlier[i];
    const named = e.tool === 'js' && typeof e.args.code === 'string' ? cuaBrowserOf(e.args.code, ids) : null;
    if (named) return named;
  }
  return 'chrome';
}

/**
 * The Codex Browser plugin: a program that calls tab.markHandoff() (a page waiting for a sign-in, approval,
 * payment or CAPTCHA), or one the user interrupted by taking over. A program in the in-app browser (named by it
 * or by the latest earlier program that named one) hands over a tab of the chat's pane ('app'); otherwise the tab
 * is in the user's Chrome.
 */
export function cuaHandoff(c: ControlCall, earlier: ControlCall[] = []): Handoff | null {
  if (c.tool !== 'js' || typeof c.args.code !== 'string') return null;
  const tookOver = TOOK_OVER.test(c.result);
  if (!tookOver && !/\.\s*markHandoff\s*\(/.test(maskCua(c.args.code).code)) return null;
  // which browser only for a hand-off: it reads every earlier program's output
  const url = firstUrl(c.result);
  const where = cuaWhere(c, earlier);
  if (tookOver) return { where, reason: 'tookOver', url, tabId: null };
  // the agent says why in its title, comments or strings
  return { where, reason: reasonOf(`${c.args.title ?? ''}\n${c.args.code}\n${c.result}`), url, tabId: null };
}

/** Every JSON value a program printed: the whole output, or one per line. */
function printed(text: string): unknown[] {
  try {
    return [JSON.parse(text)];
  } catch {
    return text.split('\n').flatMap((line) => {
      try {
        return /^\s*[[{]/.test(line) ? [JSON.parse(line)] : [];
      } catch {
        return [];
      }
    });
  }
}

/** A tab as a printed openTabs() result lists it. */
type PrintedTab = { url?: unknown; title?: unknown; id?: unknown; providerTabId?: unknown };

/**
 * The user's Chrome tabs a Codex Browser plugin program printed (`browser.user.openTabs()`), with the
 * extension instance they are in when the output names exactly one (the plugin's tab mentions need it).
 */
export function cuaTabs(c: ControlCall): SeenTab[] {
  if (c.tool !== 'js' || typeof c.args.code !== 'string' || !/\bopenTabs\s*\(/.test(c.args.code)) return [];
  const tabs: (PrintedTab & { url: string })[] = [];
  const browsers = new Set<string>();
  const walk = (value: unknown) => {
    const v = value as PrintedTab & { metadata?: { extensionInstanceId?: unknown } | null };
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if (typeof v.metadata?.extensionInstanceId === 'string') browsers.add(v.metadata.extensionInstanceId);
    if (typeof v.url === 'string' && /^https?:/.test(v.url) && (v.providerTabId != null || v.id != null))
      tabs.push(v as PrintedTab & { url: string });
    Object.values(v).forEach(walk);
  };
  printed(c.result).forEach(walk);
  const browserId = browsers.size === 1 ? [...browsers][0] : null;
  return tabs.map((t) => ({
    where: 'chrome',
    tabId: String(t.providerTabId ?? t.id),
    title: typeof t.title === 'string' && t.title ? t.title : t.url,
    url: t.url,
    browserId,
  }));
}
