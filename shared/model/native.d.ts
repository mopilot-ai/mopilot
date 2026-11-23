// What main reports to a window about accounts, cloud tasks, migrations, the browser and the harness CLIs, as types
// only: the records the window bridge (src/lib/native) carries, and a Claude session's answers, usage and settings.
import type { HarnessStatus } from './harness';

export interface AccountLimits {
  primary: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null;
  secondary: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null;
  used: number | null;
  reached: boolean;
  resetsAt: number | null;
  at: number;
}

export interface ManagedAccount {
  id: string;
  email: string | null;
  planType: string | null;
  kind: 'chatgpt' | 'apiKey';
  /** the managed MoPilot-credits key (an API key pointed at the MoPilot gateway) */
  mopilot?: boolean;
  /** API-key accounts: third-party endpoint, null = OpenAI */
  baseUrl: string | null;
  /** the Codex CLI's own sign-in ($CODEX_HOME/auth.json) */
  isDefault: boolean;
  status: 'ok' | 'expired';
  error: string | null;
  limits: AccountLimits | null;
  /** chats this account served in the last two hours (shared session pool) */
  chats: number;
}

export interface AccountsState {
  active: string | null;
  autoSwitch: boolean;
  /** 'spread': new chats go to the account with the most usage left; 'single': one account at a time */
  pool: 'spread' | 'single';
  /** model traffic goes through the account relay (off when config.toml sets its own endpoint) */
  relay: boolean;
  login: { authUrl: string; targetId: string | null } | null;
  accounts: ManagedAccount[];
  /** the account each recent chat (native thread id) is on; `pinned` when the user chose it */
  chatAccounts?: Record<string, { id: string; pinned: boolean }>;
  /** the CLI's own login when it is the same server account as an added one, left out of `accounts`: its id -> that one's */
  same?: Record<string, string>;
}

/** One Claude Code login (electron/harness/claude/accounts.cjs). "default" is the CLI's own. */
export interface ClaudeManagedAccount {
  id: string;
  email: string | null;
  subscriptionType: string | null;
  /** how the CLI signed in ('claude.ai', a Console API key, …) */
  authMethod?: string | null;
  organizationType: string | null;
  rateLimitTier: string | null;
  loggedIn: boolean;
  /** false while the CLI's own login has not been read yet, so `loggedIn` is not an answer; absent from an older main */
  checked?: boolean;
  /** signed out because its config folder moved, so the CLI can't find its sign-in (electron/identity/contract/accountDirs.cjs) */
  reconfirm?: boolean;
  isDefault: boolean;
  /**
   * Whether the login is the account it is shown as (electron/harness/claude/loginIdentity.cjs). 'unverified': the CLI's own
   * login, renamed by another client; 'mismatch': an added login whose token the server named another account than
   * the one it was added as (`addedAs`); null: nothing says either way.
   */
  identity?: 'verified' | 'unverified' | 'mismatch' | null;
  /** with 'mismatch': the email of the account the login was added as */
  addedAs?: string | null;
  /** the server account this login is (electron/harness/claude/loginIdentity.cjs serverIdOf), null while not known */
  serverId?: string | null;
}

export interface ClaudeAccountsState {
  active: string;
  autoSwitch: boolean;
  /** an account being added: its sign-in runs in a terminal */
  login: { id: string } | null;
  accounts: ClaudeManagedAccount[];
  /** logins that are the same server account as a listed one, left out of `accounts`: folded id -> listed id */
  same?: Record<string, string>;
}

export interface MigrationStatus {
  id: string;
  result: 'ok' | 'done' | 'failed' | 'deferred' | 'newer' | 'restored' | 'error';
  reason?: string;
  report?: string | null;
}

export interface CloudEnv {
  id: string;
  label: string;
  repo: string | null;
  repositories?: (string | null)[];
  pinned: boolean;
}

export interface CloudTask {
  id: string;
  title?: string;
  status?: string;
  updated_at?: string | number;
  environment_id?: string | null;
  environment_label?: string | null;
  url?: string;
  summary?: { files_changed?: number; lines_added?: number; lines_removed?: number };
  [k: string]: unknown;
}

/** Whether the built-in browser's shared profile is signed in to claude.ai (electron/capabilities/browser/claudeSite.cjs). */
export interface ClaudeSiteState {
  /** null until main's first read decides */
  signedIn: boolean | null;
  /** main's count of answers: the higher one is newer */
  seq: number;
}

export interface AgentTabView {
  /** the browser_* tab id */
  tabId: string;
  /** the Host the tab is on when it is not this Mac's (its `tabKey` then names the Host too) */
  hostId?: string;
  /** the pane tab's key: the browser_* id, or null for the chat's original tab */
  tabKey: string | null;
  kind: 'tab' | 'popup';
  /** the agent is using it this turn */
  active: boolean;
  /** the agent opened it this turn */
  created: boolean;
  /** kept open after the turn by the agent */
  mark: 'deliverable' | 'handoff' | null;
  /** the user took it over for the rest of the turn */
  takenOver: boolean;
  /** kept open after the agent's turn as the page it finished on; absent from older mains */
  result?: boolean;
  origin: string | null;
  /** the page's site permission for this chat; null for a blank page */
  access: 'full' | 'write' | 'read' | 'denied' | 'ask' | null;
  /** the agent handed the tab to the user to sign in (browser_request_signin), and why */
  signin?: { reason: string; credential?: boolean } | null;
  /** the user took the tab's hand-off to their Chrome */
  moved?: boolean;
  /** the device the agent emulates in this tab (browser_resize_window); null or absent for none */
  device?: { preset: 'mobile' | 'tablet' | null; label: string; width: number; height: number } | null;
  /** this tab is a Host's whole desktop, not a page (G8): the machine it belongs to */
  desktop?: { machine: string };
}

/** What the running Codex is and can do (electron/harness/versions.cjs). */
export interface CodexNegotiated {
  cliVersion: string | null;
  /** ok, unverified (newer, untested: works as usual), tooOld or knownBad (incompatible); null when unknown */
  versionStatus: 'ok' | 'unverified' | 'tooOld' | 'knownBad' | null;
  /** probe id -> the method is there */
  probes: Record<string, boolean>;
  /** the harness's own feature flags, e.g. features.goals */
  flags: Record<string, boolean>;
}

export interface ClaudeModelInfo {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}

export interface ClaudeSlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  builtin?: boolean;
}

export interface ClaudeCatalog {
  commands: ClaudeSlashCommand[];
  skills: string[];
  plugins: { name: string; path: string | null }[];
  /** init.terminal_slash_commands; null until a session reported them */
  terminalSlash: string[] | null;
  /** a live session reported it (vs. a prefetch) */
  live: boolean;
}

export type Usage = HarnessStatus['usage'];

/**
 * measuredAt: when the CLI last fetched the figures, which a cached answer predates (null: not known, so now).
 * cached: main answered from its last read without reading; retryAt: the login backs off until then (ms).
 * live: what the login's turns last reported (electron/harness/claude/usageSchedule.cjs), which may be newer than the read.
 */
export type UsageReadResult = (
  | { state: 'success'; text: string; measuredAt?: number | null }
  | { state: 'error'; error: string }
  | { state: 'retired' }
) & {
  cached?: boolean;
  retryAt?: number;
  live?: Usage;
  /** the server account the login is, as main knows it now (null: not known; absent: an older main) */
  account?: string | null;
};

/** A Claude chat's own pick as a window sends it: the model and effort only once the window knows them. */
export type ClaudeOwn = { model?: string | null; effort?: string | null; account: string | null };

export interface ClaudeMcpServer {
  name: string;
  status: string;
  source?: string;
  scope?: string;
  transport?: string;
}

/**
 * One installed Codex binary as main reports it (electron/app/codexServer.cjs): its path, and its version and how it
 * was installed when main knows them (electron/harness/installMethod.cjs installSource; null when it is not one of the
 * copies found).
 */
export interface CodexCopy {
  path: string;
  version: string | null;
  via: string | null;
  from: string | null;
}

/** The copy main says quit as it started, and whether the user picked it in Settings (main then keeps it). */
export interface CodexQuit {
  copy: CodexCopy;
  pinned: boolean;
}

/**
 * The approval UI's answer (Codex decision shapes) as the Agent SDK's: a PermissionResult for a
 * tool, an ElicitationResult for an MCP server's request. A decline carries the user's note.
 */
/** The approval card's answer, in the Codex decision shapes (and an MCP ElicitResult's). */
export interface ApprovalResult {
  action?: string;
  content?: unknown;
  _meta?: unknown;
  answers?: Record<string, { answers?: string[] } | undefined>;
  decision?: string | { acceptWithExecpolicyAmendment?: unknown };
  reason?: unknown;
}

/** What goes back to the Agent SDK: a PermissionResult, or an ElicitationResult for an MCP request. */
export interface ClaudeAnswer {
  behavior?: 'allow' | 'deny';
  updatedInput?: Record<string, unknown> | null;
  updatedPermissions?: unknown[];
  message?: string;
  interrupt?: boolean;
  action?: string;
  content?: unknown;
  _meta?: unknown;
}
