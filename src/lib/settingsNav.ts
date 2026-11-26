// Settings information architecture as data (WP7-3): the sidebar, the sub-sections of a harness page,
// and where every old link now lands. Pure, so tests can pin the page budget.
// @plain-copy: user text here names no ACP, CLI, endpoint, Basic or billing type (tests/userCopyJargon.invariant.test.ts)

import { ownTable } from '../../shared/ownTable.mjs';
import { t } from './i18n';
export const GROUPS = ['App', 'Harnesses', 'Built-in tools', 'Workspace', 'System'] as const;
export type SettingsGroup = (typeof GROUPS)[number];
/** What the sidebar calls each group; the group names themselves stay ids. */
export const GROUP_LABEL: Record<SettingsGroup, string> = {
  App: t('App'),
  Harnesses: t('Harnesses'),
  'Built-in tools': t('Built-in tools'),
  Workspace: t('Workspace'),
  System: t('System'),
};

export interface NavItem {
  id: string;
  label: string;
  group: SettingsGroup;
}

/** The sidebar, in order. Accounts live on one page; each first-class harness has one page. */
export const NAV: NavItem[] = [
  { id: 'accounts', label: 'Accounts & billing', group: 'App' },
  { id: 'general', label: 'General', group: 'App' },
  { id: 'appearance', label: 'Appearance', group: 'App' },
  { id: 'mini', label: 'Quick Chat', group: 'App' },
  { id: 'shortcuts', label: 'Keyboard shortcuts', group: 'App' },
  { id: 'privacy', label: 'Privacy', group: 'App' },
  { id: 'harnesses', label: 'All agents', group: 'Harnesses' },
  { id: 'codex', label: 'Codex', group: 'Harnesses' },
  { id: 'claude', label: 'Claude Code', group: 'Harnesses' },
  { id: 'other-harnesses', label: 'Other agents', group: 'Harnesses' },
  { id: 'computer', label: 'Computer use', group: 'Built-in tools' },
  { id: 'computer-history', label: 'Computer History', group: 'Built-in tools' },
  { id: 'computer-access', label: 'Computer access', group: 'Built-in tools' },
  { id: 'browser', label: 'Browser', group: 'Built-in tools' },
  { id: 'voice', label: 'Voice & dictation', group: 'Built-in tools' },
  { id: 'connections', label: 'Connections', group: 'Workspace' },
  { id: 'connectors', label: 'Connectors', group: 'Workspace' },
  { id: 'git', label: 'Git', group: 'Workspace' },
  { id: 'archived', label: 'Archived chats', group: 'Workspace' },
  { id: 'about', label: 'About', group: 'System' },
];

/** The sidebar before WP7-3, for the page budget (D-F15: no more than 21 items). */
export const SIDEBAR_BEFORE = 23;
export const SIDEBAR_MAX = 21;
/** `<Row` count under src/components before WP7-3; the total may grow by at most 10. */
export const ROWS_BEFORE = 133;
export const ROWS_MAX_GROWTH = 10;
/**
 * Rows accepted beyond the +10 budget, each by the PR that added them and why. The budget itself does
 * not move: a change that adds rows either merges existing ones or adds a line here, reviewed in its PR.
 */
export const ROWS_ACCEPTED: readonly { pr: number; rows: number; why: string }[] = [
  {
    pr: 5768,
    rows: 2,
    why: "Settings › Harnesses › All harnesses: New chats start with (Last used or the default above) and the default's Thinking effort, the choice the owner asked for on 2026-11-26",
  },
  {
    pr: 5497,
    rows: 4,
    why: 'Accounts & billing › Providers & models: a key per provider, the saved model configs, Add model config and the unreadable-file notices for Your own provider (the approved routing plan, Part B3)',
  },
  {
    pr: 5350,
    rows: 1,
    why: 'Settings › About › Community: the one link to the Discord community, the same one the Help menu opens; owner-approved 2026-11-20',
  },
  {
    pr: 5308,
    rows: 1,
    why: 'General › Chats: separate switches for resuming after quota resets and switching harness at a usage limit, so either behavior can be enabled independently',
  },
  {
    pr: 4937,
    rows: 1,
    why: "MoMo's Morning brief switch (A7): one row in Settings › MoMo › Proactivity, the only place to turn the brief off again; the earlier Morning briefing routine's line and button share this row",
  },
  {
    pr: 4808,
    rows: 1,
    why: "MoMo's Up next suggestions (A7) are rows of the Tasks panel in the MoMo view, not a settings page: one row per suggestion, drawn with the settings group markup the Tasks panel already uses",
  },
  {
    pr: 5487,
    rows: 1,
    why: "MoMo's home screens draw the list of machines MoMo can live on (Where MoMo runs, the first-run choice and the move sheet) with the settings group markup: one row per machine, in the MoMo view and not a settings page",
  },
  {
    pr: 4777,
    rows: 2,
    why: "MoMo's Tasks panel (M0a) is a page of the MoMo view, not a settings page: one row per task and one empty-state row, drawn with the settings group markup the Tasks tab already uses (the classic tab's own two rows stay while the flag is off)",
  },
  {
    pr: 4749,
    rows: 1,
    why: 'Settings › MoMo › Proactivity: whether a phone alert names the routine that raised it (A6, the push body opt-in); a Mac-only switch, off by default',
  },
  {
    pr: 4684,
    rows: 2,
    why: "MoMo's Tasks tab (A1) is a page of the MoMo view, not a settings page: one row per task and one empty-state row, drawn with the settings group markup the Memory tab's loops already use",
  },
  {
    pr: 4663,
    rows: 2,
    why: 'Connections › Linear: the API key field to connect, or the connected key with Disconnect; one row shown at a time',
  },
  {
    pr: 4505,
    rows: 1,
    why: 'Git › Delete branch on archive: remove an archived chat’s worktree and branch when nothing on them can be lost',
  },
  {
    pr: 4519,
    rows: 14,
    why: "A machine's page (X2, behind host.machinePage): Status (path, version, update), Devices (the phone's direct access), Rules, Spending, Activity and Managed; one new page, each section shown only when the Host sends its data",
  },
  {
    pr: 4408,
    rows: 3,
    why: 'Worktrees › Import from Conductor, shown only on a machine with Conductor workspaces: one row per repository to import, one per item an import could not bring over, and the folders left out',
  },
  {
    pr: 4092,
    rows: 1,
    why: 'General › Language: the language of the interface',
  },
  {
    pr: 4122,
    rows: 11,
    why: 'Superagent (S1, behind its flag): the connect rows (pause, repository, pause GitHub, allowed people), the rules, the observe log (precision, its empty state, one row per entry) and the error and interrupted-event rows; one page for a new feature',
  },
  {
    pr: 3466,
    rows: 4,
    why: "MoMo's Memory tab and Settings (P3): one row per recent memory change with Undo, its empty state, one row per past fact (hidden until Show), and Background memory's single limits-and-use row",
  },
  {
    pr: 3460,
    rows: 1,
    why: 'Connections › Mobile Remote: Add another phone, which keeps the pairing QR folded once a phone is paired (it took the whole group)',
  },
  {
    pr: 3423,
    rows: 3,
    why: 'My machines › Organization access (#3361 Tier 2): the state row with Sign in / Sign out / Edit / Remove, and while editing the IdP fields and the lease length with Save',
  },
  {
    pr: 3392,
    rows: 3,
    why: 'Connections › Mobile Remote: the Connect step row, one row per paired phone, and the pairing error row with Try again; each shows only while Mobile Remote is on',
  },
  {
    pr: 3070,
    rows: 1,
    why: 'General › Notifications: Notification quiet hours, one row with its start and end times; off until turned on (Mobile Remote N6)',
  },
  {
    pr: 2878,
    rows: 1,
    why: 'MoMo › Brain › Let my phone change the brain: the one switch that lets a paired phone pick the brain, off until turned on',
  },
  {
    pr: 2841,
    rows: 3,
    why: 'Connections › My machines: one row per remote machine, the Add machine row, and the pairing code row (Host 2.4)',
  },
  {
    pr: 2824,
    rows: 3,
    why: 'Connections › Keep this Mac reachable: the menu-bar, login-item and sleep switches, shown only while Mobile Remote is on and off until turned on',
  },
  {
    pr: 2735,
    rows: 5,
    why: 'Connections › the Remote Control group: its switch, Add, and a row per paired device with its states (empty, failed read)',
  },
  { pr: 2610, rows: 2, why: 'General: iOS Simulator and Android Emulator, one switch per platform for the simulator tools (audit #2610)' },
  {
    pr: 2617,
    rows: 2,
    why: 'Connections: one switch per optional built-in connector (GitHub) and the macOS Quick Actions switch, both off until turned on (#2610)',
  },
  {
    pr: 341,
    rows: 9,
    why: 'Accounts > Usage: reset cards (the Codex card list with its loading, error, empty and retry states, and the Claude Code redemption fallback)',
  },
  { pr: 365, rows: 1, why: 'Computer use and Browser: native control status, one row per harness and surface' },
  {
    pr: 2435,
    rows: 1,
    why: 'General › Chats: Apply code review fixes automatically, the switch for applying a review’s findings without a click',
  },
  {
    pr: 3221,
    rows: 1,
    why: 'General › Chats: Continue at a usage limit, the switch for a chat going on by itself when it runs out of quota',
  },
  { pr: 2623, rows: 1, why: 'Harness Advanced: Connect new sessions to Remote Control, a switch' },
  { pr: 2386, rows: 1, why: 'Harness Advanced: Artifacts and designs, the switch for publishing pages, slides and designs to claude.ai' },
  {
    pr: 2361,
    rows: 2,
    why: "Settings › MoMo › Audit log (#2290, #2292): the audit log (Export, Start a new log when it can't go on) and remembered approvals that can't be read (Set aside)",
  },
  {
    pr: 2181,
    rows: 3,
    why: 'Settings › MoMo › Sources (#2139): one row per source (Calendar, Reminders, Files), one per added Files folder, and Add folder',
  },
  {
    pr: 377,
    rows: 3,
    why: 'Browser: Codex Browser Use (site access, downloads and uploads, history, full CDP, and the unreadable/off state) replaces the old Site permissions rows; sites moved to a table',
  },
  {
    pr: 386,
    rows: 1,
    why: "Browser: Storage (shared by all chats, or each chat's own storage cleared when the chat ends) for the built-in browser",
  },
  { pr: 417, rows: 1, why: 'Git: Show only last turn changes (the official "Git-based diffs" switch for the Changes pane)' },
  {
    pr: 534,
    rows: 1,
    why: 'Browser: Site permissions, one row listing the sites always allowed to use the camera, microphone, location or notifications',
  },
  { pr: 528, rows: 1, why: 'Computer use: Allow brief switching to the app when background control does not work' },
  {
    pr: 1476,
    rows: 12,
    why: 'Computer History (#1363): on/off and status, the app and site allow lists with their add rows, what is never recorded (apps, sites, secure fields), retention, the empty state and one row per day',
  },
  {
    pr: 1103,
    rows: 8,
    why: "Plugins → All harnesses: MoPilot's store (installed plugins with their reach per harness, one status line per list, Discover entries, marketplaces and adding one, and a harness's own plugins to make available everywhere)",
  },
  {
    pr: 1510,
    rows: 8,
    why: 'Computer access (#1364): the on/off switch that is also the kill switch, the network choice, pairing a device, one row per paired device, one per device using this Mac now, one per other computer, and the unreadable-settings and load-error states',
  },
  {
    pr: 2200,
    rows: 3,
    why: 'Settings › MoMo › Brain › Proactivity (#2139): how often MoMo reaches out, quiet hours and the notify switch',
  },
  {
    pr: 2202,
    rows: 5,
    why: 'Settings › MoMo › Brain (#2527): the one brain with its At limit rule, Name and style (moved out of setup), and the Calendar and Reminders switches of setup',
  },
  { pr: 2211, rows: 2, why: 'Settings › MoMo › Brain › MoMo (#2139): Pause MoMo and Reset MoMo' },
  { pr: 2212, rows: 1, why: 'Settings › MoMo › Brain › MoMo (#2139): Setup, which opens setup again' },
  {
    pr: 2160,
    rows: 3,
    why: "MoMo's Memory tab (#2139), outside Settings but in its row style: one row per fact, the empty state, and Memory is off",
  },
  { pr: 5390, rows: 1, why: 'Harnesses › All harnesses: choose the highest installed version for automatically selected executables' },
];
/** The `<Row` total the Settings source may reach. */
export const ROWS_BUDGET = ROWS_BEFORE + ROWS_MAX_GROWTH + ROWS_ACCEPTED.reduce((n, a) => n + a.rows, 0);

/** The sections of a first-class harness page: everyday settings (account, models, instructions), extensions, and
 * how the CLI runs. Models & providers and Instructions & memory were folded into Overview. */
export const HARNESS_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'extensions', label: 'Extensions' },
  { id: 'advanced', label: 'Advanced' },
] as const;
export type HarnessTab = (typeof HARNESS_TABS)[number]['id'];
export const isHarnessTab = (t: string | undefined): t is HarnessTab => HARNESS_TABS.some((x) => x.id === t);

/** The tab string of a settings route: "extensions" or "extensions:mcps" (a page inside the section). */
export function splitTab(tab: string | undefined): { tab: string | undefined; sub: string | undefined } {
  if (!tab) return { tab: undefined, sub: undefined };
  const i = tab.indexOf(':');
  return i < 0 ? { tab, sub: undefined } : { tab: tab.slice(0, i), sub: tab.slice(i + 1) || undefined };
}

/** The tab that opens Accounts & billing on one account's row ("row:codex:<id>"). */
export const accountRowTab = (harness: string, id: string) => `row:${harness}:${id}`;
/** The data-account value of the row a tab names, or null. */
export function accountRowOf(tab: string | undefined): string | null {
  const { tab: t, sub } = splitTab(tab);
  return t === 'row' && sub ? sub : null;
}

interface Target {
  section: string;
  tab?: string;
}

/** Old section ids (and the tabs they carried) mapped to where their content lives now. */
const ALIAS: Record<string, (tab: string | undefined) => Target> = ownTable({
  account: () => ({ section: 'accounts' }),
  usage: () => ({ section: 'accounts' }),
  mopilot: () => ({ section: 'accounts' }),
  configuration: () => ({ section: 'codex', tab: 'advanced' }),
  personalization: () => ({ section: 'codex', tab: 'overview' }),
  cloud: () => ({ section: 'codex', tab: 'advanced' }),
  features: () => ({ section: 'codex', tab: 'advanced' }),
  plugins: (tab) => ({ section: 'codex', tab: tab ? `extensions:${tab}` : 'extensions' }),
  hooks: () => ({ section: 'codex', tab: 'extensions' }),
  import: () => ({ section: 'codex', tab: 'extensions' }),
  // Worktrees sit on the Git page: both are about the repository a chat works in
  worktrees: () => ({ section: 'git' }),
});

/** Old tab ids of a section and the tab each became: the Codex page's from before its tabs were renamed, and the
 * Models and Instructions tabs both pages folded into Overview; 'accounts' left the page. */
const LEGACY_TABS = new Map<string, Map<string, string>>([
  [
    'codex',
    new Map([
      ['accounts', 'accounts'],
      ['config', 'advanced'],
      ['memory', 'overview'],
      ['cloud', 'advanced'],
      ['models', 'overview'],
      ['instructions', 'overview'],
    ]),
  ],
  [
    'claude',
    new Map([
      ['models', 'overview'],
      ['instructions', 'overview'],
    ]),
  ],
]);

/** Where a settings link lands: the section to highlight and, for a harness page, its sub-section. */
export function resolveSection(section: string | undefined, tab?: string): Target {
  const s = section ?? 'general';
  const a = ALIAS[s];
  if (a) return a(tab);
  // old tabs of a section, from before the sections were renamed
  const legacy = tab ? LEGACY_TABS.get(s)?.get(tab) : undefined;
  if (legacy === 'accounts') return { section: 'accounts' };
  if (legacy) return { section: s, tab: legacy };
  return { section: s, tab };
}

/** What a setting applies to when that is not every harness. Shown as a small badge. */
export const APPLIES: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  codexCli: 'Only affects Codex outside MoPilot',
  thisChat: 'This chat',
  newChats: 'New chats',
};
export type Applies = keyof typeof APPLIES;
