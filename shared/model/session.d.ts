// A chat's live session state as main holds it (electron/session/state.cjs) and a window keeps a copy of, and what main
// says the chat can do (its caps), as types only.
import type {
  AcpSessionState,
  Binding,
  CapState,
  HarnessId,
  HarnessKind,
  PendingSwitch,
  PolyfillEngine,
  Semantic,
  Why,
  WhyFix,
} from './harness';
import type { SessionApproval } from './requests';
import type { Attachment, ChatGoal } from './store';
import type { SpeechEngine } from '../speech.mjs';

export type TurnPhase = 'idle' | 'running' | 'awaitingUser' | 'crashed';

/** A Claude Code session's Remote Control link: state, the claude.ai page that follows the session, why it isn't up, and whether the user wants it on. */
export interface RemoteControlView {
  state: 'off' | 'connecting' | 'on' | 'offline' | 'signin' | 'error' | 'unavailable';
  url: string | null;
  error: string | null;
  wanted: boolean;
}

/** Send options a queued message keeps until it goes out (src/store/store.ts SendOptions). */
export interface QueuedOptions {
  hostPermission?: import('../host/permissions.mjs').HostPermissionPick;
  hostMode?: import('./store').PermissionMode;
  /** with Plan: the mode the person had picked, which Plan keeps as the one its tools run under on the Host */
  hostBase?: import('./store').PermissionMode;
  hostSelection?: import('../host/models.mjs').HostModelPick;
  /** A native compaction action, resolved by the receiving harness after the current turn. */
  compact?: { args: string };
  /** Main-owned conditional Retry: a native writer lock must retain it in the shared queue, never one window's hold. */
  retainInMain?: true;
  chromePanelTab?: import('../chromeHandoff.mjs').ChromePanelTarget;
  chromeHandoff?: import('../chromeHandoff.mjs').HandoffPrecondition;
  plan?: boolean;
  acceptedPlan?: { itemId: string; text: string };
  goal?: string;
  model?: string;
  effort?: string;
  prefix?: string;
  note?: { kind: string; text: string; handoff?: string };
  human?: boolean;
  /** the message goes into the running turn on a machine's Host (the person chose steer and the agent takes it) */
  steer?: boolean;
}

export interface QueuedMessage {
  id: string;
  text: string;
  attachments: Attachment[];
  opts: QueuedOptions;
  /** the window it was sent from */
  origin: number | null;
  queuedAt: number;
  /** a message the machine's Host took into its running turn: the row shows it as sent (no Send: sending it again would send it twice) until that turn ends */
  steered?: boolean;
  /** The Host may have accepted this side chat's first send. The original input remains held while main checks its receipt. */
  pendingStart?: true;
  /** a message a machine's Host refused (`waitingFor: 'hostRefused'`): what the Host said, shown with the row */
  error?: string;
  /** with `error` on a refused message: what the row offers (shared/host/refusalWords.mjs): the one action that fixes the cause, or none, and whether Retry can succeed */
  refusal?: {
    code: string;
    action: 'install' | 'signIn' | 'orgSignIn' | 'update' | 'openMachines' | 'newChat' | 'chooseFolder' | 'useMode' | null;
    retry: boolean;
    hostId: string;
    machine: string;
    /** this app refused it before the Host saw it (a file over the limit, a folder it cannot read, a Host too old for it): the row says what it is and the fix, never that the Host did not accept it */
    own?: boolean;
    /** the sentence already names the cause (a Mac the machine does not know), so the row does not front it with "Host did not accept it" */
    named?: boolean;
    agent?: string;
    /** with `useMode`: the most the machine allows */
    mode?: string;
  };
  /** Compaction-held input stays editable; an interrupted hold waits for explicit retry. */
  /** with `waitingFor: 'hostMoving'`: the machine the chat is moving to */
  movingTo?: string;
  waitingFor?:
    | 'compaction'
    | 'compactionRetry'
    | 'audioRecovery'
    | 'voiceConversation'
    | 'host'
    | 'hostMoved'
    | 'hostMoving'
    | 'hostRefused'
    | 'orgSignin';
  /** an input no human wrote: the client id its chat's meta shows it by (lib/authoredInput.ts) */
  authored?: { id: string };
  /** a brief, message or wake-up another session sent: the id main's linked-session record shows it by */
  sideSession?: { id: string };
  /** a message another chat sent (send_message_to_chat): main's journal keeps it, the tray shows who sent what */
  peer?: { messageId: string; sourceChatId: string; sourceTitle?: string | null; body?: string };
}

export interface SessionState {
  rev: number;
  turn: TurnPhase;
  /** `human`: a person started it; `userEngaged`: a person subsequently steered; `compact`: manual maintenance until this turn ends. */
  activeTurn: { id: string; human: boolean; userEngaged?: boolean; compact?: true } | null;
  crashed: string | null;
  /** when the running turn last made progress, ms epoch, to the 5 s (electron/session/turnProgress.cjs); null once it ends */
  progressAt?: number | null;
  plan: boolean;
  permission: string | null;
  goal: ChatGoal | null;
  queue: QueuedMessage[];
  compaction: 'active' | 'failed' | null;
  questions: import('../acpForm.mjs').AcpQuestion[];
  approvals: SessionApproval[];
  pendingSwitch: PendingSwitch | null;
  /** The current harness's ephemeral follow-up for the composer. */
  promptSuggestion: string | null;
  /** basic tier: what the harness declared for the session */
  acp: AcpSessionState | null;
  /** what the chat's model takes in; null: unknown (computer use then sends a screenshot and the element list) */
  modality: 'image' | 'text' | null;
  /** computer use in this chat (main only): controlling an app, paused because the user took over, or waiting for the desktop */
  computer: {
    app: string;
    state: 'active' | 'takeover' | 'waiting' | 'reading' | 'permission';
    permission?: 'accessibility' | 'screenRecording' | 'inputMonitoring';
    holder?: string | null;
    read?: { model: string; vendor: string } | { text: true };
  } | null;
  /** background (app-scoped) control in this chat (main only): the apps it works in, the latest first, each with its window title, a live thumbnail and whether the user took it over */
  appControl: { apps: AppControlEntry[] } | null;
  /** Codex's own computer-use plugin is releasing control after a turn, or failed to confirm it did (main only) */
  nativeCleanup: { phase: 'releasing' | 'failed'; turnId: string; error: string | null } | null;
  /** Claude in Chrome's connection in the chat's Claude Code session (main only); null when it runs none */
  chromeLink: ChromeLinkState | null;
  /** who controls each surface of the chat on its current segment (main only; electron/session/controllerPlan.cjs); null until decided this run */
  controllerPlan: ControllerPlanState | null;
  /** a Your Chrome call of the chat waits for the user to approve the connection in Chrome (main only) */
  chromeApproval: boolean;
  /** the chat's last turn finished with browser steps it can keep as a routine (main only, G4): which turn, how many steps; else null */
  routineOffer: { turnId: string | null; steps: number } | null;
  tasks: BackgroundTask[];
  /** what the chat runs after its turn that only an adapter can list, as main last read it (main only; Codex), or null */
  backgroundWork: BackgroundWork | null;
  ultracode: { on: boolean; available: boolean; probe: 'ok' | 'missing' | 'failed' } | null;
  /** Claude's Remote Control link (electron/claudeRemoteControl.cjs); null before a session ran */
  remoteControl: RemoteControlView | null;
  /** another app is running a turn on the chat (main reconciles its rollout or jsonl) */
  runningElsewhere: boolean;
  /** the chat is a scheduled task's run (src/lib/scheduleTask.ts) */
  scheduled: ScheduledMark | null;
}

/** Claude in Chrome's connection as the session's CLI reports it (electron/harness/claude/chromeLink.cjs). */
export interface ChromeLinkState {
  connected: boolean;
  /** the paired browser's name, when the CLI knows it */
  browser: string | null;
  installed: boolean;
  /** down after it was up, or a Claude in Chrome tool found it gone (not a server still connecting at the start) */
  dropped: boolean;
  /** the CLI's page that reconnects the extension, and the extension's site permissions page */
  reconnectUrl: string | null;
  permissionsUrl: string | null;
}

/** The controller of each surface on a segment (shared/controllerPlan.mjs): the in-app browser, computer use and the user's Chrome. */
export interface ControllerPlanState {
  /** the segment it was decided for (its window-side key) */
  key: string | null;
  iab: string | null;
  cu: string | null;
  bu: string | null;
}

/** One app a chat works in in the background (electron/capabilities/appVisibility.cjs). */
export interface AppControlEntry {
  bundleId: string;
  app: string;
  title: string | null;
  windowId: number | null;
  /** a data: URL of a small JPEG of the window, refreshed with the chat's actions (at most once a second) */
  thumbnail: string | null;
  at: number;
  /** the user took the app over from the strip: the chat's input there waits until they hand it back */
  takenOver: boolean;
}

/** What a scheduled run is allowed to do: set by the window that starts it, read in main. */
export interface ScheduledMark {
  /** started by the scheduler: nobody is watching, so computer-use cards are refused */
  unattended: boolean;
  computer: boolean;
  onApproval: 'wait' | 'skip';
  /** an approval nobody answered for an hour: main marks the run (electron/platform/scheduler.cjs) */
  needsAttention?: boolean;
}

/**
 * A chat's background work main counts for every window (electron/harness/codexBackgroundWork.cjs): the background
 * commands and running sub-agents of the native thread `source` names, which a window otherwise learns only by polling.
 */
export interface BackgroundWork {
  source: { kind: 'codex'; key: string };
  shells: number;
  agents: number;
}

/** A background task the harness runs outside the turn (a sub-agent, a shell, a workflow, a review). */
export interface BackgroundTask {
  /** Native owner of a task retained across chat segments; actions route to this source. */
  source?: { kind: 'claude' | 'codex' | 'acp'; key: string };
  id: string;
  /** local_agent, local_bash, local_workflow, … */
  type: string | null;
  description: string;
  status: string;
  /** the latest one-line progress summary */
  summary: string | null;
  toolUseId: string | null;
  subagentType: string | null;
  workflowName: string | null;
  parentTaskId: string | null;
  /** housekeeping (a watcher), not shown as activity */
  ambient: boolean;
  /** when it started and settled (ms since the epoch), for the live timer and "took …" */
  startedAt?: number | null;
  completedAt?: number | null;
  /** the tool an agent task is using now ("Running a command") */
  latestTool?: string | null;
  model?: string | null;
  tokens?: number | null;
  toolUses?: number | null;
  /** an agent task's AgentRun key, for "View transcript" */
  agentKey?: string | null;
  /** a shell task's command, shown in full */
  command?: string | null;
  /** where a shell task's output can be read while it runs */
  output?: { kind: 'file'; path: string } | { kind: 'process'; id: string } | null;
  /** false when the harness can't stop this task (the Stop button says why) */
  stoppable?: boolean;
}

export interface SessionPatch {
  chatId: string;
  rev: number;
  patch: Partial<SessionState>;
}

/** One semantic for one chat: how it is presented (state), how it runs (via), and why not when it can't. */
export interface CapView {
  state: CapState;
  via: Binding['via'];
  why?: Why;
  fix?: WhyFix;
  /** via 'passthrough': the text the harness takes, {args} for the arguments */
  template?: string;
  /** via 'route': the harness that does it */
  to?: HarnessId;
  /** via 'polyfill': the engine that runs it; nativeDictation (via 'config'): the speech engine of the chat's own account */
  engine?: PolyfillEngine | SpeechEngine;
}

export type Caps = Record<Semantic, CapView>;

export interface ChatCaps {
  kind: HarnessKind;
  tier: 'first' | 'basic';
  /** who serves the chat's turns (OpenAI, Anthropic, MoPilot, or a gateway's host) */
  provider?: { id: string; label: string /** the harness's own vendor */; firstParty?: boolean } | null;
  caps: Caps;
}

/** What a window knows and main doesn't yet. */
export interface CapsHint {
  /** the harness a chat that hasn't started will use */
  kind?: HarnessKind;
  /** the model picked for the chat before it has sent anything */
  model?: string;
  temporary?: boolean;
  /** another app is running a turn on this chat */
  elsewhere?: boolean;
}

/** What a new chat on one harness gets once its session opens, for its Settings page (electron/session/harnessCaps.cjs). */
export interface HarnessCaps extends ChatCaps {
  /** its row in the per-harness control status (useNativeAvailability) */
  family: 'codex' | 'claude' | 'acp';
  works: {
    /** a chat on it can run: not switched off, and a basic harness passed admission */
    chat: boolean;
    /** its prompts take images; null: not known yet */
    images: boolean | null;
    /** MoPilot's tools (messages to other chats, scheduled tasks, computer and browser control) reach its sessions */
    tools: boolean;
    /** why they don't, when a switch or the tool bridge is the reason */
    toolsOff: string | null;
    /** Presentation code; toolsOff remains diagnostic-only. */
    toolsOffCode?: 'tools.off' | 'tools.bridge' | null;
  };
}
