// A window's core state, as types only: turns and their items, a chat's runtime, attachments, pending requests,
// projects, prefs and goals. The store (src/store/types.ts) re-exports them with its defaults and prefs loaders.
import type { DiffCommentRange } from '../diffComments.mjs';
import type { HarnessId, HarnessKind, Selection } from './harness';
import type { AnsweredQuestion, RequestBody, RequestMethod } from './requests';
import type { ThreadGoal } from '../../src/protocol/v2/ThreadGoal';
import type { ThreadItem } from '../../src/protocol/v2/ThreadItem';
import type { ThreadTokenUsage } from '../../src/protocol/v2/ThreadTokenUsage';
import type { TurnPlanStep } from '../../src/protocol/v2/TurnPlanStep';

/** An app Open in can send a file or folder to (Settings → General keeps the preferred one; src/lib/openApps.ts lists them). */
export type OpenApp = 'finder' | 'vscode' | 'cursor' | 'zed' | 'xcode' | 'terminal' | 'iterm';

/**
 * A client-side line in a chat (an account move, a usage limit, a harness switch). It is kept among a turn's
 * items, though the protocol's ThreadItem has no such variant.
 */
export interface StatusNoteItem {
  type: 'statusNote';
  id: string;
  kind: string;
  text: string;
  handoff?: string;
  /** kind 'task': a background task that settled (or started) here, shown as a task event card instead of text */
  task?: TaskEvent;
  /** kind 'answers': the questions an agent asked and what was answered, shown as the answered-questions card */
  answers?: AnsweredQuestion[];
  /** kind 'control': the app computer use refused (src/lib/controlRefusal.ts), as the agent named it and as a person reads it */
  refused?: RefusedApp;
  /** kind 'wake': what woke the turn this note heads (a monitor's event, a scheduled check-in), no one having typed it */
  wake?: WakeNote;
  /** kind 'nudge': an open loop MoMo brought up (electron/app/momoNudges.cjs), with why */
  nudge?: NudgeNote;
  /** kind 'draft': a message MoMo wrote for the user to review (electron/momo/draftTools.cjs), shown as a card */
  draft?: DraftNote;
  /** kind 'draft': how far the user's Send got (shared/momoDraftSend.mjs), the receipt; read by the phone's rows */
  send?: import('../momoDraftSend.mjs').Send;
  /** kind 'brief': a line of MoMo's morning brief (electron/app/momoBrief.cjs), or with this a suggestion card (Hide, Start) */
  suggestion?: { id: string; title: string; source: string };
}

/** The words of a draft MoMo showed: who it is for (may be nobody), its one-line subject and its body. */
export interface DraftNote {
  to: string[];
  subject: string;
  body: string;
}

/**
 * Why MoMo brought up an open loop: the loop (`title`), the user's own words (`quote`) and when they said them, what
 * fired (`trigger`: due, event, stale or close) and that said in words (`why`).
 */
export interface NudgeNote {
  loopId: string;
  title: string;
  quote: string;
  saidAt: number;
  trigger: string;
  why: string;
}

/**
 * What woke a turn no one typed: `key` is the watch it came from (a monitor's task id, every check-in one), `label` what
 * that watch is ("CI run 401…", the check-in's prompt), `detail` what this wake reported and `failed` whether it said
 * something went wrong.
 */
export interface WakeNote {
  by: 'monitor' | 'checkin';
  key: string;
  label: string;
  detail: string | null;
  failed: boolean;
}

/** An app computer use refused in a turn: `app` as the agent named it (a bundle id or a name), `name` as a person reads it. */
export interface RefusedApp {
  app: string;
  name: string;
}

/** One background task's state change, as the transcript's task event card shows it. */
export interface TaskEvent {
  taskId: string;
  kind: 'agent' | 'shell' | 'workflow' | 'monitor' | 'task';
  title: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  durationMs: number | null;
  /** the tool call (Claude) or command item (Codex) that started the task: its step row stands for the task in the transcript */
  toolUseId?: string | null;
}

export interface TurnState {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  items: ThreadItem[];
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  error: { message: string; additionalDetails?: string | null } | null;
  /** client-side timing per item (ms epoch) */
  itemTimes: Record<string, { start: number; end?: number }>;
  diff?: string;
  /** its edits were undone from its Edited card (Redo clears it): it no longer counts as changes */
  undone?: boolean;
  /** `steered`: the messages steered into the turn when the plan came (src/store/turnPlan.ts); none for a plan read from disk */
  plan?: { explanation: string | null; steps: TurnPlanStep[]; steered?: number };
  /** sent in plan mode: its last message is the plan when the model writes no plan item */
  planMode?: boolean;
  /** its person stopped it (Stop, Esc, or Esc on the desktop): "You stopped after Ns" (src/store/stoppedByYou.ts) */
  stoppedByYou?: boolean;
}

export interface ThreadRuntime {
  loaded: boolean;
  loading: boolean;
  turns: TurnState[];
  olderCursor: string | null;
  /** How many of the chat's turns sit above `turns`, known for a chat that switched harness while paged: segments count from the chat's first turn. */
  turnsAbove?: number;
  activeTurnId: string | null;
  tokenUsage: ThreadTokenUsage | null;
  /** Ephemeral provenance of the last reported usage; a harness/session switch invalidates context use. */
  tokenUsageOwner?: string;
  /** the chat's total tokens when its running turn started: the activity line counts the turn's from it */
  turnStartTokens?: number | null;
  error: string | null;
  /** `error` is why a read of the chat failed: the next read that succeeds takes it away */
  errorFromRead?: boolean;
  /** some turns shown were read from disk (the harness that reads them was down): the next read that succeeds replaces them */
  fromDisk?: boolean;
  /** retry banner, e.g. "Reconnecting… 2/5", or a harness retrying its failing provider */
  retry: string | null;
  settings?: { model?: string | null; effort?: string | null };
  /** a message held back while another app has the chat (design §07), sent when it lets go or the user says so */
  held: { text: string; attachments: Attachment[]; opts: Record<string, unknown> } | null;
  /** the user chose to continue here although another Claude app has the chat open */
  continueHere: boolean;
  /** Claude: user messages that can be rewound (file checkpoints) → the entry before each; unset for other harnesses */
  checkpoints?: Record<string, string | null>;
}

/** Which other app has a chat: Claude desktop, a terminal CLI, another Sage, a Codex client. */
export type ElsewhereApp = 'claude-desktop' | 'claude-cli' | 'sage' | 'codex' | 'other';

/**
 * Another app has the chat (design §07). `running`: it is writing a turn now. `hard`: Sage can't
 * write at all (Codex's writer lock); otherwise it can, but the other app's history goes stale.
 */
export interface Elsewhere {
  app: ElsewhereApp;
  running: boolean;
  hard: boolean;
}

export interface Attachment {
  kind: 'image' | 'file' | 'audio' | 'skill' | 'selection' | 'session' | 'computerHistory';
  path: string;
  name: string;
  /** Skill UI label; `name` remains the identifier sent to the harness. */
  displayName?: string;
  previewUrl?: string;
  mimeType?: string;
  durationMs?: number;
  /** Skill position in the composer's plain text. */
  textOffset?: number;
  /** Selected text, a referenced chat's conversation snapshot, or the shared Computer History block. */
  text?: string;
  /** Add-to-chat annotations keep their comment and source position in the draft. */
  annotation?: string;
  annotationId?: string;
  /** DOM anchor text can differ from the copied quote's rendered paragraph separators. */
  source?: { messageId: string; start: number; end: number; text?: string };
  /** A comment on diff lines (`annotation` is the comment, `text` the hunk), sent as a `# Diff comments:` entry. */
  diff?: DiffCommentRange;
  /** Browser Annotate chip: the page its marked screenshot shows; `text` describes the marks (src/lib/pageAnnotations.ts). */
  pageUrl?: string;
}

export type PermissionMode = 'read-only' | 'default' | 'auto-review' | 'full-access';

/** An approval card's request; its method decides its params (harness/requestParams.ts). */
export type PendingRequest<M extends RequestMethod = RequestMethod> = RequestBody<M> & {
  id: number | string;
  threadId: string | null;
  receivedAt: number;
};

export interface Toast {
  id: number;
  text: string;
  kind?: 'info' | 'error' | 'success';
  action?: { label: string; run: () => void };
}

export interface Project {
  path: string;
  name: string;
  hidden?: boolean;
}

/** What new chats on one basic harness start with: a mode id and config option values by option id. */
export interface BasicDefaults {
  mode?: string;
  config?: Record<string, unknown>;
}

export interface Prefs {
  model: string | null;
  effort: string | null;
  permission: PermissionMode;
  serviceTier: string | null;
  theme: 'system' | 'light' | 'dark';
  sendWith: 'enter' | 'cmdEnter';
  followUp: 'queue' | 'steer';
  /** Settings → General → Notifications; 'needed' is "Only when I'm needed" (approval, authorization, a goal stopped short). */
  notifyOnComplete: 'always' | 'unfocused' | 'needed' | 'never';
  /** Settings → General → Notifications: which kinds notify at all (electron/platform/notify.cjs KINDS); a missing key is on. */
  notifyKinds: Partial<Record<'turn' | 'approval' | 'scheduled' | 'goal' | 'auth' | 'computer', boolean>>;
  /** Quiet hours for notifications ("HH:MM", past midnight when end is earlier): banners and pushes wait, and a "needs you" is said once at the end. null: none. */
  notifyQuietHours: { start: string; end: string } | null;
  showReasoning: boolean;
  wrapCode: boolean;
  defaultTerminal: 'bottom' | 'right';
  fontSize: number;
  codeFontSize: number;
  /** every app window's page zoom, in zoom levels (shared/zoom.mjs): View → Zoom In, Zoom Out, Actual Size */
  zoomLevel: number;
  /** the scheduler is off (Settings → General): on unless turned off, since a time runs once wherever it runs */
  schedulerOff: boolean;
  /** what an offer (a task the user named, to run in a new session or here) does: ask on its card, or answer for them (Settings → General) */
  newTaskPrompt: 'ask' | 'here' | 'new';
  /** archive chats inactive this many days (shared/autoArchive.mjs); null: Never (Settings → General) */
  autoArchiveDays: number | null;
  /** a code review's findings are applied without a click in every chat (shared/reviewAutoFix.mjs; Settings → General) */
  autoApplyReviewFixes: boolean;
  /** resume on the same harness after its quota resets; on by default (Settings → General) */
  autoContinueOnLimit: boolean;
  /** switch to another harness when quota runs out; off until explicitly enabled (Settings → General) */
  autoSwitchHarnessOnLimit: boolean;
  projectlessFolder: string | null;
  openDestination: OpenApp;
  showInMenuBar: boolean;
  confirmClose: 'always' | 'shortcut' | 'never';
  fullViewDefault: boolean;
  /** the side pane's width share per group (lib/paneLayout.ts) */ paneWidths?: Partial<Record<'wide' | 'narrow', number>>;
  bottomPanelControl: boolean;
  /** the iOS Simulator and Android Emulator tools for chats (electron/capabilities/tools/simulatorTools.cjs; Settings → General) */
  simulatorIos: boolean;
  simulatorAndroid: boolean;
  accent: string | null;
  bgOverride: string | null;
  fgOverride: string | null;
  fontFamily: string | null;
  branchPrefix: string;
  /** Changes pane: the diff scope the user last picked, the default for the next pane */
  changesScope: 'turn' | 'uncommitted' | 'branch';
  /** Settings → Git: the Changes pane shows only the last turn's diff, never the repository's git state */
  changesLastTurnOnly: boolean;
  /** Changes pane options: Show whitespace (off: whitespace-only edits read as unchanged lines); on unless turned off */
  changesWhitespace?: boolean;
  /** the side pane's file views wrap long lines (their Word wrap button) */
  filesWrap?: boolean;
  /** the Files pane's tree beside the open file: on its left (the default) or right */
  filesTreeSide?: 'left' | 'right';
  worktreeRoot: string | null;
  /** the new-chat Worktree switch's last setting: later new chats start with it (as in Claude's desktop app; off at first) */
  worktreeDefault: boolean;
  autoDeleteWorktrees: boolean;
  /** archiving a chat in a managed worktree removes the worktree and deletes its branch, when every commit is pushed or on another branch and nothing is uncommitted (off at first) */
  deleteBranchOnArchive?: boolean;
  autoDeleteLimit: number;
  keybindings: Record<string, string | null>;
  pinnedProjects: string[];
  /** folders of Claude chats removed from Projects (their chats show in Recents), until added back */
  hiddenFolders: string[];
  /** display names for those folder groups, by path (Claude has no project list to rename them in) */
  folderNames: Record<string, string>;
  /** the folder the last chat started on each machine ran in, by machine id: picking the machine for a new chat starts there again */
  hostFolders: Record<string, string>;
  /** the agent, model and effort the last chat started on each machine used, by machine id: a new chat there starts on them while the machine still offers them */
  hostPicks: Record<string, { agent: string; model?: string; effort?: string | null }>;
  /** the last machine chosen in Run on for a new chat, or null for this computer */
  lastNewChatHost: { id: string; name: string } | null;
  /** realtime voice for voice mode */
  voice: string;
  /** the one-time confirmation for voice starting a Codex chat from another harness was answered */
  /** register ⌥Space globally for Mini */
  miniShortcut: boolean;
  hideFullAccessBanner: boolean;
  micDeviceId: string | null;
  dictationLanguage: string;
  /** the interface's language: a tag from shared/i18n/languages.mjs, or 'system' to follow the OS */
  interfaceLanguage: string;
  /** null until first use: people who already dictated keep ChatGPT, new users get this Mac (see currentDictationEngine) */
  dictationEngine: 'local' | 'chatgpt' | 'credits' | null;
  localUrlDestination: 'in-app' | 'default';
  browserFullUrl: boolean;
  /** record each turn's built-in browser steps (frames, actions, network, console) for Replay on the turn; main reads it (turnTraces.cjs) */
  browserTurnTrace: boolean;
  /** where the built-in browser keeps a chat's cookies and site data: one shared profile, or each chat its own (cleared when the chat ends) */
  browserStorage: 'shared' | 'session';
  /** the pane's offer to import bookmarks, history and sign-ins from another browser: still asking, never again, or done (something was imported) */
  browserImportPrompt: 'pending' | 'dismissed' | 'done';
  /** how many times the offer was put off with "Not now", and when it may come back (ms since the epoch) */
  browserImportSnoozes: number;
  browserImportSnoozeUntil: number;
  /** which browser agents prefer: the built-in one or the user's Chrome (through MoPilot's extension where it serves Chrome, else the Playwright Extension) */
  browserChannel: 'builtin' | 'chrome';
  /** Claude Code chats use Claude in Chrome instead of MoPilot's extension (main reads it at each session start) */
  claudeInChrome: boolean;
  /** Chrome profile directory for Your Chrome ('' = the last used profile with the extension) */
  chromeProfileDir: string;
  downloadsDir: string | null;
  askWhereToSave: boolean;
  themePreset: string | null;
  voiceHotkey: string | null;
  importSync: boolean;
  visibleEfforts: string[] | null;
  sshHosts: string[];
  sidebarOrganize: 'project' | 'list' | 'machine';
  /** Project sorting is independent of chat sorting; newest activity comes first by default. */
  projectSort: 'custom' | 'updated' | 'name';
  /** Discovered folder groups remain visible after their last chat is archived. */
  sidebarFolders: string[];
  chatSort: 'updated' | 'manual';
  sidebarWidth?: number;
  /** the width of MoMo's own rail in its shell (`momo.shell`), saved as the sidebar's is */
  momoRailWidth?: number;
  /** the rail hidden by its toggle or Cmd/Ctrl+B */
  momoRailHidden?: boolean;
  /** the shell's side pane: its width and the panel left open ('tasks', 'files' or 'sessions') */
  momoPaneWidth?: number;
  momoPane?: 'tasks' | 'files' | 'sessions' | null;
  /** Manual project/folder order, keyed by saved id or folder path. */
  sidebarProjectOrder?: string[];
  /** each sidebar chat row shows the icon of the harness it last ran on */
  showChatHarness: boolean;
  /** Manual thread ids per project/folder, or @recents, @list and @pinned. */
  chatOrder: Record<string, string[]>;
  sidebarSections: { id: string; name: string }[];
  projectSection: Record<string, string>;
  importedSources: string[];
  /**
   * The harness new chats start on: 'codex', 'claude' or 'acp:<id>'. Existing chats keep their own. Read it only
   * through resolveDefaultHarness (src/harness/defaultHarness.ts), which says when it can't run and what runs instead.
   */
  defaultHarness: HarnessKind;
  /**
   * What new chats start with (src/store/newChatStart.ts): 'last' the harness, model and effort last used (a message
   * sent, or a pick), 'default' the saved default harness and newChatDefault's model and effort.
   */
  newChatStart: 'last' | 'default';
  /** The harness a message was last sent on (or picked for a new chat); 'last' new chats start on it. */
  lastHarness: HarnessKind | null;
  /** The fixed model and effort 'default' new chats start with, while `harness` is still defaultHarness. */
  newChatDefault: { harness: HarnessKind; model: string | null; effort: string | null } | null;
  /** Claude Code model / effort / fast (Codex keeps using model, effort, serviceTier) */
  claudeSelection: Selection;
  /** a path the user gave for a basic harness's binary, by harness id (Settings → Other harnesses) */
  acpBins: Record<string, string>;
  /** At app startup, prefer the highest detected CLI version for unpinned local harnesses. */
  preferHighestCli: boolean;
  /** by basic harness id: the mode and config option values (model, effort, …) new chats on it start with */
  basicDefaults: Record<string, BasicDefaults>;
  /**
   * by basic harness id: whether MoPilot's chats on it load the MCP servers in the harness's own settings, and the
   * ones turned off (electron/harness/acp/ownMcp.cjs); the user's own settings are never changed
   */
  acpMcp: Record<string, { load?: boolean; off?: string[] }>;
  /** user-chosen claude binary (Settings → Claude Code) */
  claudeBin: string | null;
  /**
   * per harness: ask before moving to paid access once every subscription has run out ("Ask to use paid access"
   * rather than "Stop"); unset follows its auto-switch (shared/switch.mjs limitChoice)
   */
  limitAsk: Partial<Record<HarnessId, boolean>>;
  /** download and stage updates in the background */
  autoUpdate: boolean;
  updateChannel: 'stable' | 'beta' | 'dogfood';
  /** share usage data (analytics, crash reports, prompts) with MoPilot; null = legacy unset choice (defaults on) */
  shareUsageData: boolean | null;
  /** the local request log (electron/ledger): one line per model request, no content; off writes nothing */
  requestLog: boolean;
  /** the welcome page was finished with Continue; main settles it before any window boots (chats.cjs settleWelcome) */
  welcomeDone: boolean;
  /** the defaults the saved prefs were written under (see defaultsPatch) */
  prefsVersion: number;
}

/**
 * A chat's goal in the goal bar: Codex's ThreadGoal as the app-server reports it, or the snapshot
 * Sage keeps for a Claude Code goal (src/lib/claudeGoals.ts), which adds its round count and can
 * end "stopped" (the loop ended without the condition being met).
 */
export type ChatGoalStatus = ThreadGoal['status'] | 'stopped';

export type ChatGoal = Omit<ThreadGoal, 'status'> & {
  status: ChatGoalStatus;
  claude?: { iterations: number; lastReason: string | null; limit: number | null };
  /** Codex: paused by MoPilot as it quit (main sets it, electron/harness/codex.cjs) */
  pausedAtQuit?: boolean;
};
