// A window's whole store state and the records it is made of, as types only: routes, panes and the split view, saved
// projects, chat settings and notes, reviews, agent tabs and runs. The store (src/store/state.d.ts) re-exports them.
import type { BasicHarness, HarnessKind, HarnessModel, HarnessStatus, Segment } from './harness';
import type {
  AccountsState,
  AgentTabView,
  ClaudeAccountsState,
  ClaudeCatalog,
  ClaudeSiteState,
  CloudEnv,
  CloudTask,
  CodexNegotiated,
  CodexQuit,
  MigrationStatus,
} from './native';
import type { AnsweredQuestion } from './requests';
import type { RepositoryDraft } from './repositorySidebar';
import type { BackgroundTask } from './session';
import type { Attachment, Elsewhere, PendingRequest, Prefs, Project, RefusedApp, ThreadRuntime, Toast } from './store';
import type { FindingStatus } from '../reviewFindings.mjs';
import type { PlanType } from '../../src/protocol/PlanType';
import type { Account } from '../../src/protocol/v2/Account';
import type { Config } from '../../src/protocol/v2/Config';
import type { GetAccountRateLimitsResponse } from '../../src/protocol/v2/GetAccountRateLimitsResponse';
import type { Model } from '../../src/protocol/v2/Model';
import type { Thread } from '../../src/protocol/v2/Thread';

/**
 * A review's findings shown in the Changes pane, for the chat whose review they are; `current` is the one in focus.
 * `settled`: the pane's scope is no longer moved for the walk (it moved to Branch once, or the user picked one).
 */
/** A Codex v2-shaped notification: its method and params object. */
export type Emit = (method: string, params: Record<string, unknown>) => void;

export interface FindingsWalk {
  chatId: string;
  reviewId: string;
  current: number;
  settled?: boolean;
}

/** A project from userData/projects.json (electron/platform/projects.cjs), in the shape the UI reads. */
export interface SavedProject {
  id: string;
  name: string;
  roots: { path: string }[];
  source: 'sage' | 'codex';
  /** the matching Codex project, when Codex has one */
  codexId?: string;
}

/** The Codex account as the UI reads it: any Account variant, with the ChatGPT-only fields optional. */
export interface CodexAccountView {
  type: Account['type'];
  email?: string | null;
  planType?: PlanType;
}

/**
 * config/read's config as the UI reads it. The protocol's Config types its tables as plain JSON; this names the
 * keys the UI looks into. Any other key passes through untyped.
 */
export interface CodexConfigView
  extends Partial<Pick<Config, 'web_search' | 'model_verbosity' | 'model_reasoning_summary' | 'service_tier'>> {
  model?: string;
  model_reasoning_effort?: string;
  features?: Record<string, boolean | undefined>;
  memories?: { disable_on_external_context?: boolean };
  [key: string]: unknown;
}

export interface AppState {
  /* connection */
  /** 'idle': Codex isn't started yet; it starts on first use */
  conn: 'idle' | 'connecting' | 'ready' | 'error';
  connError: string | null;
  codexHome: string | null;
  userAgent: string | null;
  home: string;
  systemUsername: string | null;

  /* account */
  account: CodexAccountView | null;
  requiresAuth: boolean;
  rateLimits: GetAccountRateLimitsResponse | null;
  loginPending: { loginId: string; authUrl?: string } | null;
  /** every signed-in account (electron/identity/codexAccounts.cjs); the active one drives the app-server */
  accounts: AccountsState;

  /* models & config */
  models: Model[];
  /** Codex answered (or failed) its first model/list: an empty list from then on is really empty. */
  modelsLoaded: boolean;
  config: CodexConfigView | null;
  /** Why config/read last failed, while there is no config to show (cleared when a read succeeds). */
  configError: string | null;

  /* threads */
  threads: Record<string, Thread>;
  threadOrder: string[];
  threadsCursor: string | null;
  archived: Thread[];
  runtime: Record<string, ThreadRuntime>;
  pending: PendingRequest[];

  /* projects */
  savedProjects: SavedProject[];
  /** selected project for the next new chat: project id, 'none' for projectless, null = most recent */
  newChatProjectId: string | null;
  /** run the next new chat as a Codex Cloud task in this environment */
  newChatCloudEnv: { id: string; label: string } | null;
  /** next new chat is temporary (ephemeral thread, kept out of history) */
  newChatTemporary: boolean;
  /** the hidden block a new chat's first message carries before what the user types: a handoff's summary of chat `fromTitle`, or (`issue`) the GitHub issue `fromTitle` it started from */
  handoffCarry: Record<string, { text: string; fromTitle: string; issue?: true }>;
  cloudTasks: CloudTask[];
  newChatRepositoryGroup?: RepositoryDraft;
  cloudSidebar?: { account: string; environments: CloudEnv[]; unplacedTasks?: string[] };
  /** config.toml warnings and deprecation notices from the app-server */
  configWarnings: { summary: string; details: string | null }[];
  projects: Project[];
  collapsedProjects: Record<string, boolean>;
  /** per project, the chats shown beyond the first few (Show more) */
  revealedChats: Record<string, number>;

  /* ui */
  route: Route;
  /** the window's split view: its split panes beside the route's pane, and which pane is focused (src/store/split.ts); never persisted */
  split: SplitLayout;
  back: Route[];
  forward: Route[];
  sidebarOpen: boolean;
  summaryOpen: boolean;
  /** room for each side panel at the window's CSS width (src/lib/shellFit.ts); never persisted */
  shellFit: { sidebar: boolean; summary: boolean };
  /** panels the user opened although they do not fit, shown anyway; never persisted */
  shellForced: { sidebar?: boolean; summary?: boolean };
  bottomPanelOpen: boolean;
  diffPanel: { open: boolean; file?: string | null; scope?: string; turnId?: string; walk?: FindingsWalk };
  /** per chat, per review card: findings marked fixing or dismissed, and where the fix request's turn starts; not persisted */
  reviewMarks: Record<string, Record<string, ReviewMarks>>;
  /** per chat, what its last review started from MoPilot looked at (Re-run review, the findings' Changes scope); not persisted */
  reviewTargets: Record<string, ReviewAsk>;
  /** tabs in the right-hand pane; the pane is open while diffPanel.open */
  paneTabs: PaneTab[];
  paneActive: string;
  /** Each chat's right-pane layout and parked panel/side-chat tabs; window-local, never persisted. */
  chatPanes: Record<
    string,
    {
      tabs: PaneTab[];
      active: string;
      open: boolean;
      full: boolean;
      panel?: AppState['diffPanel'];
      summaryOpen?: boolean;
    }
  >;
  /** pane covers the chat ("Enter full view") */
  paneFull: boolean;
  paneWidth: number;
  searchOpen: boolean;
  searchMode: 'all' | 'files';
  activityView: boolean;
  focused: boolean;
  fullscreen: boolean;
  drafts: Record<string, { text: string; attachments: Attachment[]; goal?: boolean }>;
  newChatCwd: string | null;
  /** a folder on a remote machine picked for the next new chat (not saved); newChatHostPick says when it still applies */
  newChatHost: {
    id: string;
    name: string;
    path: string;
    /** Registration that owns the checkout picked from a project row. */
    scope?: string;
    /** Restored from preferences, so the first resolved registry list can confirm the device is still registered. */
    remembered?: true;
    /** the agent picked for this folder; unset: the saved default */
    agent?: string;
    permission?: import('../host/permissions.mjs').HostPermissionPick;
    selection?: import('../host/models.mjs').HostModelPick;
    /** what the next new chat targeted before a machine was picked (newChatProjectId, newChatCwd): picking This Mac goes back to it */
    before?: { projectId: string | null; cwd: string | null };
  } | null;
  /** this new-chat draft's own Worktree choice (the suggestion turned it on); null: prefs.worktreeDefault (see newChatWorktreeOn) */
  newChatWorktree: boolean | null;
  /** the folder this draft's "Turn on Worktree" suggestion was dismissed for */
  newChatWorktreeHintOff: string | null;
  /** the harness picked in this new-chat draft's model picker ('codex', 'claude' or 'acp:<id>'); null: the saved default */
  newChatHarnessPick: HarnessKind | null;
  /** increments on each draft harness choice or reset, including choosing the same harness again */
  newChatHarnessRevision: number;
  /**
   * the branch picked in the context bar for the new chat's folder (path); null: the default for the worktree setting.
   * With `pullRequest` it is that pull request's head branch, fetched and checked out when the chat starts (`own`: an open
   * branch of origin's, worked on as itself; else a copy, pr/<n>, which only a worktree can hold). With `issue` it is the
   * branch picked before it (null: the default for the worktree setting, as with no pick), and the chat's first message
   * carries the issue's text, read when it starts.
   */
  newChatBranch: {
    path: string;
    branch: string | null;
    pullRequest?: { number: number; title: string; fork: boolean; own: boolean };
    issue?: { number: number; title: string };
    /** a Linear issue, like `issue`; with Worktree on, the worktree's branch is Linear's suggested one (`branch`) */
    linear?: { key: string; title: string; branch: string | null };
  } | null;
  /** A draft's pick of an existing worktree (one adopted in place) of the project at `root` to run in, instead of a new one. */
  newChatWorkspace: { root: string; path: string; name: string } | null;
  toasts: Toast[];
  prefs: Prefs;
  unread: Record<string, boolean>;
  pinned: Record<string, boolean>;
  dark: boolean;
  codexBin: string | null;
  /** the Codex binary the app-server was started from (codexBin is only an override) */
  codexBinInUse: string | null;
  /** threadId -> original project path, for chats running in a git worktree */
  worktreeOf: Record<string, string>;
  /** chatId -> the saved project the chat was started in, kept in the chat's meta */
  chatProject: Record<string, string>;

  /* Claude Code harness (Codex's equivalents are conn/account/rateLimits/models above) */
  claude: { status: HarnessStatus; models: HarnessModel[] };
  /** Claude Code logins (electron/harness/claude/accounts.cjs); `active` is the one new chats use */
  claudeAccounts: ClaudeAccountsState;
  /** plan usage per Claude account id */
  claudeUsage: Record<string, HarnessStatus['usage']>;
  /** Claude's command catalogs by account and folder (electron/harness/claude/index.cjs) */
  claudeCatalogs: Record<string, ClaudeCatalog>;
  /** the Claude account each chat runs on; `pinned` when the user chose it rather than the pool (lib/chatMeta.ts) */
  claudeChats: Record<string, ChatAccountRecord>;
  /** notes Sage left in a chat (account switches), persisted in its v2 file */
  chatNotes: Record<string, ChatNote[]>;
  /** User-message bookmarks, persisted and synchronized per chat. */
  navigationBookmarks: Record<string, string[]>;
  /** chat id -> the chat it was forked from (chat meta forkOf, #1941) */
  chatForkOf: Record<string, string>;
  /** Supplied task titles for linked sessions before their native title is available (main-owned chat meta initialTitle). */
  chatInitialTitles: Record<string, string>;
  /** Chat id to the last successful rewind in Unix seconds, supplied by main. */
  chatRewoundAt: Record<string, number>;
  /** MoMo's chats (chat meta momo, lib/momoChats.ts): in no list of chats */
  momoChats: Record<string, string>;
  /** the Claude Code model each MoMo chat's brain names (chat meta momoModel, #2304): its turns run on it */
  momoModels: Record<string, string>;
  /** chat id -> how each input no human wrote is shown, by its client id (chat meta authored, lib/authoredInput.ts) */
  authoredInputs: Record<string, Record<string, AuthoredInput>>;
  /** Claude has no server-side archive: archived chat ids live in Sage's ui-state (basic-tier chats too) */
  claudeArchived: Record<string, number>;
  /** basic-tier harnesses found on this machine (electron/harness/acp.cjs) */
  basicHarnesses: BasicHarness[];
  /** main has answered with the basic-tier list at least once */
  basicListed: boolean;
  /** the basic harnesses whose ACP sign-in is under way (in any window): id -> the auth method it waits on */
  basicSignIns: Record<string, string>;
  /** counts the remote-switch snapshots main pushed, so selectors that read a switch run again */
  flagsRev: number;
  /** chats that switched harness mid-way: their native sessions in order (design §05) */
  segments: Record<string, Segment[]>;
  /** chats another app has open or is running right now (design §07) */
  elsewhere: Record<string, Elsewhere>;
  /** each Codex chat's own model, effort and service tier (D-29); prefs are only new chats' defaults */
  chatConfig: Record<string, ChatConfig>;
  /** the running Codex's version status and probes (WP5-20) */
  codexCompat: CodexNegotiated | null;
  /** agent control of browser tabs by chat, as main reports it (electron/capabilities/browser/agentTabs.cjs) */
  agentTabs: AgentTabsMap;
  /** whether the built-in browser's shared profile is signed in to claude.ai, as main last reported it (src/store/claudeSignIn.ts) */
  claudeSite: ClaudeSiteState;
  /** the MoPilot gateway's capability table by model, while Codex runs on MoPilot credits */
  /** a crashed app-server main is bringing back (the attempt), or gave up on after its last try */
  codexRestart: { attempt: number; inMs: number } | 'gaveUp' | null;
  /** the Codex copy that quit as it started, until one connects: the banner and a chat's failed read name it */
  codexQuit: CodexQuit | null;
  /** the chat-data migration didn't finish: the sidebar banner offers Retry and the report */
  migrationIssue: MigrationStatus | null;
}

export interface PaneTab {
  id: string;
  kind: 'changes' | 'files' | 'file' | 'browser' | 'terminal' | 'chat' | 'skill' | 'tasks' | 'artifact' | 'plan' | 'outputs' | 'usage';
  /** file and skill tabs: exact local path referenced by a message */
  path?: string;
  /** file tabs: requested source line */
  line?: number;
  /** file tabs: the last line of a cited range (`#L5-L20`), after `line` */
  endLine?: number;
  cwd?: string;
  /** plan tabs: a historical item, namespaced by its turn; absent follows the latest proposal */
  plan?: { turnId: string; itemId: string; source?: 'reply' };
  /** chat and plan tabs: the owning thread */
  threadId?: string;
  /** side chat tabs: the main chat whose selections continue this conversation */
  sourceChatId?: string;
  /** browser, terminal, file and skill tabs: the chat whose view shows this tab; unset tabs show in every view */
  ownerChat?: string;
  /** chat tabs: a sub-agent's thread, shown without a composer */
  readOnly?: boolean;
  /** terminal tabs: program to run instead of a login shell (e.g. ssh) */
  command?: string[];
  /** terminal tabs: text typed at the prompt but not run, so the user presses Enter */
  input?: string;
  /** terminal tabs: a sign-in command, whose URLs open in the user's own browser */
  signIn?: boolean;
  /** terminal tabs: environment the command runs with (a harness's sign-in may ask for some) */
  env?: Record<string, string>;
  url?: string;
  title?: string;
  /** browser tabs: the name the user gave the tab (Rename), shown instead of the page's title */
  customTitle?: string;
  /** browser tabs: the page's audio is muted (Mute tab); kept on a page that replaces it */
  muted?: boolean;
  /** browser tabs: the chat whose agent drives this tab (electron/capabilities/browser/cdp.cjs) */
  agentChat?: string;
  /** browser tabs: the browser_* tab id (electron/capabilities/browser/host.cjs); unset for a chat's original tab */
  agentTab?: string;
  /** agent browser tabs: shown in front of an open pane once, so an automatic request no longer reopens a closed pane for it */
  seen?: boolean;
  /** Temporary Duplicate state; history remains in main memory only. */
  restoring?: boolean;
  browserView?: boolean;
  duplicating?: boolean;
  duplicateError?: string;
  browserPartition?: string;
  /** artifact tabs: a claude.ai artifact or a Claude Design project (src/store/artifactPanes.ts) */
  artifactKind?: 'artifact' | 'design';
  /** artifact and generated file tabs: the last published version; a newer one refreshes the preview */
  version?: string;
  /** tasks tab: pages pushed over the task list (an agent's page); the last one shows, Back pops it */
  views?: PaneView[];
}

/** A page pushed over the tasks tab's list. */
export interface PaneView {
  kind: 'agent';
  /** the AgentRun key */
  key: string;
  title: string;
}

export type Route =
  | { name: 'home'; cwd?: string | null }
  | { name: 'thread'; id: string }
  // find: a setting's name to scroll to and flash (Settings search, src/lib/settingsFocus.ts)
  | { name: 'settings'; section?: string; tab?: string; ledger?: LedgerFocus; find?: string; connectorChatId?: string }
  | { name: 'plugins'; tab?: string; plugin?: string }
  | { name: 'scheduled' }
  | { name: 'review' }
  | { name: 'projects' }
  | { name: 'cloud'; id: string }
  // MoMo (#2139): only while the account was invited (src/lib/momo.ts); App sends it home otherwise. chatId: a MoMo chat
  // other than its main one (a routine's run) on the Chat tab
  | { name: 'momo'; tab?: 'chat' | 'tasks' | 'memory' | 'notes' | 'rules'; chatId?: string };

/** A split pane: one chat, its column weight, and the agent chat that opened it until the user arranges it. */
export interface SplitPane {
  chatId: string;
  weight: number;
  /** the agent chat whose tool opened the pane; any user arrangement of the pane clears it */
  openedBy?: string;
}

/** A window's layout. `focus` is 'primary' (the route's pane) or the chat id of a split pane. */
export interface SplitLayout {
  panes: SplitPane[];
  focus: 'primary' | string;
  primaryWeight: number;
}

export type AgentTabsMap = Record<string, AgentTabView[]>;

/**
 * A chat's Claude account (meta.account): `id` is the user's pin when `pinned`, else the account its last
 * turn ran on; `serving` is set while a pinned chat runs on another login (its pin had lapsed).
 */
export interface ChatAccountRecord {
  id: string;
  pinned: boolean;
  serving?: string;
}

/** A line Sage left in a chat (an account switch), kept in the chat's v2 file so it survives a reload. */
export interface ChatNote {
  id: string;
  /**
   * a move to another account, the answers given to an agent's questions, computer use refusing an app, or a Codex hook
   * run that failed, was blocked or cancelled (main writes the last two), or the divider of a chat on a machine that moved to another agent
   * (the Host journals it; this is its copy, `text` the divider's words, `lead` puts it first in its turn)
   */
  kind: 'account' | 'answers' | 'control' | 'hook' | 'handoff' | 'switch';
  text: string;
  /** kind 'answers': each question and what was answered */
  answers?: AnsweredQuestion[];
  /** kind 'control': the app it refused (none: another chat or app held the desktop) */
  refused?: RefusedApp;
  /** the turn it follows: its id, and its index when the id isn't stable */
  turnId: string | null;
  turn: number;
  at: number;
  /** kind 'handoff': the site the user finishes on, why, whether it is over and how it ended (handoffNotes.cjs) */
  site?: string;
  reason?: string;
  done?: boolean;
  how?: string;
  /** kind 'hook': it ran before its turn began (SessionStart), so it leads the turn */
  lead?: boolean;
}

/** A chat's own settings (meta.config): a key that is there, even as null, wins over the prefs. */
export interface ChatConfig {
  hostPermission?: import('../host/permissions.mjs').HostPermissionPick | null;
  hostSelection?: import('../host/models.mjs').HostModelPick | null;
  /** the agent a chat on a machine runs on after a switch there settled, as the Host's lane told it ('claude', 'codex', 'acp:<id>'): absent means the one its id names */
  hostAgent?: string | null;
  model?: string | null;
  effort?: string | null;
  serviceTier?: string | null;
  permission?: string | null;
  planBasePermission?: string | null;
  additionalDirectories?: string[] | null;
}

/**
 * Where in the chat a fix was asked: after item `items` of turn `turnId` (null: before every turn). An anchor by turn
 * id, not by index, holds when older turns load in front.
 */
export interface FixAnchor {
  turnId: string | null;
  items: number;
}

/** What a chat keeps for one review: findings marked fixing or dismissed, and where their fix was asked. */
export interface ReviewMarks {
  status: Record<number, Extract<FindingStatus, 'fixing' | 'dismissed'>>;
  fixAfter?: FixAnchor;
  /** findings whose file has no changes in the Changes pane's diff */
  unanchored?: number[];
}

/**
 * A review target as the review menus build it: a protocol ReviewTarget, though a caller may have widened
 * its `type` to string.
 */
export interface ReviewAsk {
  type: string;
  branch?: string;
  sha?: string;
  title?: string | null;
  instructions?: string;
}

/** The turn a banner links to: its chat, and when it ran (ms epoch) when the turn says. */
export interface LedgerFocus {
  chat: string;
  from?: number | null;
  to?: number | null;
}

/** A turn item as the agent page renders it (the same shapes the main transcript renders). */
export type AgentItem = { type: string; id: string } & Record<string, unknown>;

export type AgentStatus = 'running' | 'completed' | 'failed' | 'stopped';

/** What any harness's agent item exposes to the UI. Adapters may set it as `item.agent`; otherwise it is derived. */
export interface AgentRun {
  /** Native owner derived from the parent turn's segment when the run is read from composite history. */
  source?: BackgroundTask['source'];
  /** stable key the agent page is opened by: Claude's tool_use id, Codex's child thread id, ACP's tool call id */
  key: string;
  /** the title ("Track A: …"); the prompt's first line when the harness gives no description */
  description: string;
  prompt: string | null;
  model: string | null;
  /** launched in the background: the call returns at once and the run goes on as a task */
  background: boolean;
  /** the run's own status: a background launch stays running until its task settles */
  status: AgentStatus;
  toolUses: number;
  /** the tool the agent is using now (its heartbeat) */
  latestTool: string | null;
  tokens: number | null;
  startedAt: number | null;
  completedAt: number | null;
  /** the final report, without the harness's own trailer */
  report: string | null;
  /** 'summary': the harness shares no steps, so the agent page shows the prompt, the report and the status */
  transcript: 'full' | 'summary';
}

/** How one such input is shown: its author, a short title, and what may be read of it (never the model's instructions). */
export type AuthoredInput = { by: 'momo' | 'mopilot'; title: string; body?: string; at: number };
