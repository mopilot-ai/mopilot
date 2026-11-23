// The Sites table on the Browser settings page (BU-06): one row per site, with a column per way agents reach a
// browser. Codex Browser Use keeps allow / block lists per permission in $CODEX_HOME/browser/config.toml
// (electron/capabilities/browser/codexBrowserUse.cjs); MoPilot's own browser tools keep read / write grants
// per browser (electron/capabilities/browser/origins.cjs, D4): the in-app browser's, and Your Chrome's (the user's
// own Chrome, signed in), which starts empty. Claude in Chrome keeps its site permissions in the Claude extension,
// so it has a link, not a column. A site Codex Browser Use blocks is blocked in MoPilot's own browser tools
// too, in every chat (#1319 G13), so both browsers' columns show it blocked.
import type { BrowserUseDecision, BrowserUseResource, BrowserUseState, SiteBrowser, SiteGrant } from './native';

export const CODEX_RESOURCES: { id: BrowserUseResource; label: string }[] = [
  { id: 'browse', label: 'Browse' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'uploads', label: 'Uploads' },
  { id: 'debug', label: 'Debug (CDP)' },
];

/** The extension's site permissions page, as the CLI's /chrome dialog names it when no chat has read it. */
export const CLAUDE_CHROME_PERMISSIONS = 'https://clau.de/chrome/permissions';

export interface SiteRow {
  origin: string;
  codex: Record<BrowserUseResource, BrowserUseDecision>;
  /** MoPilot's grant in each browser's own table */
  mopilot: Record<SiteBrowser, SiteGrant['level'] | null>;
}

/** MoPilot's site tables, one per browser, as the Sites table shows them. */
export const SITE_BROWSERS: { id: SiteBrowser; label: string; title: string }[] = [
  {
    id: 'iab',
    label: 'Built-in browser',
    title: "MoPilot's browser tools in the built-in browser: Claude Code, Codex and the other harnesses",
  },
  { id: 'chrome', label: 'Your Chrome', title: "MoPilot's browser tools in your own Chrome, where you are signed in" },
];

/** Where a card or refusal says the browser is: the in-app browser, or the user's own Chrome; null when it doesn't say. */
export const browserPlace = (browser: SiteBrowser | undefined | null): string | null =>
  browser === 'chrome' ? 'in your Chrome, signed in' : browser === 'iab' ? 'in the built-in browser' : null;

export interface PolicyRow {
  label: string;
  source: 'Managed' | 'config.toml';
  codex: Record<BrowserUseResource, BrowserUseDecision>;
}

const none = (): Record<BrowserUseResource, BrowserUseDecision> => ({ browse: null, downloads: null, uploads: null, debug: null });

/** Every saved site of any route, sorted by origin. `grants`: MoPilot's tables, per browser. */
export function siteRows(codex: BrowserUseState | null, grants: Partial<Record<SiteBrowser, SiteGrant[] | null>> | null): SiteRow[] {
  const rows = new Map<string, SiteRow>();
  const row = (origin: string) => {
    let r = rows.get(origin);
    if (!r) rows.set(origin, (r = { origin, codex: none(), mopilot: { iab: null, chrome: null } }));
    return r;
  };
  for (const s of codex?.sites ?? []) for (const { id } of CODEX_RESOURCES) row(s.origin).codex[id] = s[id];
  for (const { id } of SITE_BROWSERS) for (const g of grants?.[id] ?? []) row(g.origin).mopilot[id] = g.level;
  return [...rows.values()].sort((a, b) => a.origin.localeCompare(b.origin));
}

/** The read-only origin policies: managed first, then config.toml's; '*' is the default for every site. */
export function policyRows(codex: BrowserUseState | null): PolicyRow[] {
  return (codex?.policies ?? []).map((p) => ({
    label: p.pattern === '*' ? 'All sites (default)' : p.pattern,
    source: p.source === 'managed' ? 'Managed' : 'config.toml',
    codex: { browse: p.browse, downloads: p.downloads, uploads: p.uploads, debug: p.debug },
  }));
}

/** Whether Codex Browser Use blocks site access for a row, which MoPilot's browser tools apply in every chat too. */
export const blockedByCodex = (row: { codex: Record<BrowserUseResource, BrowserUseDecision> }): boolean => row.codex.browse === 'deny';

export { siteOrigin } from '../../shared/siteOrigin.mjs';

export const DECISION_LABEL: Record<'allow' | 'deny', string> = { allow: 'Allow', deny: 'Block' };

/** What Add does: a rule in Codex's Browser plugin (`plugin:`), or a level in one of MoPilot's browser tables. */
export type AddChoice = 'plugin:allow' | 'plugin:deny' | `${SiteBrowser}:${SiteGrant['level']}`;
export const ADD_CHOICES: { value: AddChoice; label: string }[] = [
  { value: 'plugin:allow', label: 'Codex: always allow' },
  { value: 'plugin:deny', label: 'Codex: block' },
  { value: 'iab:read', label: 'Built-in browser: read only' },
  { value: 'iab:write', label: 'Built-in browser: read and write' },
  { value: 'chrome:read', label: 'Your Chrome: read only' },
  { value: 'chrome:write', label: 'Your Chrome: read and write' },
];

/** Where an Add choice saves the site: a Codex Browser Use decision, or a level in one browser's table. */
export function addTarget(choice: AddChoice): { codex: 'allow' | 'deny' } | { mopilot: SiteGrant['level']; browser: SiteBrowser } {
  const [route, value] = choice.split(':');
  return route === 'plugin'
    ? { codex: value as 'allow' | 'deny' }
    : { mopilot: value as SiteGrant['level'], browser: route as SiteBrowser };
}
