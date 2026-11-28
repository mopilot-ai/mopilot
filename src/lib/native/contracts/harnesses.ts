// Native bridge events and session/model contracts for Codex, Claude and admitted ACP harnesses.
import type { Thread } from '../../../protocol/v2/Thread';
import type { Attachment, ChatGoal, ElsewhereApp } from '../../../../shared/model/store';
import type { QueuedMessage, QueuedOptions, RemoteControlView } from '../../../../shared/model/session';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { OffPathFields } from '../../../../shared/model/harness';
import type { CodexCopy } from '../../../../shared/model/native';
import type { HarnessKind } from '../../../../shared/model/harness';
import type { AcpSessionState, CliCandidate } from '../../../../shared/model/harness';
export type { AcpCatalog, AcpConfigOption, AcpSessionState, BasicHarnessStatus, CliCandidate } from '../../../../shared/model/harness';
import type { CodexNegotiated } from '../../../../shared/model/native';
export type { ClaudeModelInfo, CodexNegotiated, ClaudeCatalog, ClaudeSlashCommand } from '../../../../shared/model/native';

/** The app-server's comings and goings; after a crash main restarts it with backoff (A23), then gives up. */
export type CodexEvent =
  | ({ kind: 'exit'; code: number | null; signal: string | null; stderr: string; restarting?: boolean } & QuitCopy)
  | ({ kind: 'error'; error: string; restarting?: boolean } & QuitCopy)
  | { kind: 'restarting'; attempt: number; inMs: number }
  /** a default copy that kept quitting as it started gave way to the next one installed */
  | { kind: 'switched'; from: CodexCopy; to: CodexCopy }
  | { kind: 'ready' }
  | { kind: 'started' }
  | ({ kind: 'gaveUp' } & QuitCopy);
/** Set when the copy quit (or couldn't run) before it answered: which copy, and whether the user picked it. */
type QuitCopy = { copy?: CodexCopy; pinned?: boolean };

/**
 * An item event from the Codex adapter in main (electron/harness/codex.cjs). `mine`: this window
 * sent the message the event is about (or is the one window it was meant for).
 */
export type CodexItem = { mine?: boolean } & (
  | { kind: 'notification'; chatId: string | null; method: string; params: unknown }
  | { kind: 'request'; chatId: string | null; request: { id: number | string; method: string; params: unknown } }
  | {
      kind: 'lease';
      threadId: string;
      /** the chat the thread belongs to, as main knows it when the lease changes */
      chatId?: string;
      held: boolean;
      thread?: Thread;
      reason?: 'released' | 'closed' | 'exit' | 'helper';
    }
  | {
      kind: 'turnStarting';
      chatId: string;
      clientId: string;
      /** the queue item's id, which is the request id a window sent (it shows the message early for a switch) */
      itemId?: string;
      text: string;
      attachments: Attachment[];
      opts: QueuedOptions;
    }
  | { kind: 'turnStarted'; chatId: string; clientId: string; turnId: string; text: string }
  | { kind: 'turnFailed'; chatId: string; clientId: string; error: string }
  | { kind: 'steered'; chatId: string; turnId: string; text: string; attachments: Attachment[]; clientId: string }
  | { kind: 'goalStarting'; chatId: string; clientId: string; objective: string }
  | { kind: 'goalFailed'; chatId: string; clientId: string }
  | { kind: 'goal'; chatId: string; goal: ChatGoal | null }
  | { kind: 'locked'; chatId: string; item: QueuedMessage }
  | { kind: 'leaseLocked'; chatId: string }
  | { kind: 'threadName'; chatId: string; name: string }
  | { kind: 'toast'; level: 'error' | 'info'; text: string }
  // a harness switch was settled in main: the chat now runs on `key` (a Claude session starts with its first message)
  | { kind: 'switched'; chatId: string; harness: HarnessKind; key: string; model: string; fresh: boolean; start: number }
  | { kind: 'negotiated'; negotiated: CodexNegotiated }
  // a scheduled run made a Codex chat in main
  | {
      kind: 'chatStarted';
      chatId: string;
      cwd: string;
      worktreeOf: string | null;
      config: { model: string | null; effort: string | null; serviceTier: string | null };
    }
);

/* Claude Code harness (electron/harness/claude/index.cjs) */
export interface ClaudeApiKeyInfo {
  set: boolean;
  /** last four characters, for recognising which key is stored */
  hint: string | null;
  /** which credential the CLI runs on; a stored key is only used in 'apiKey' mode, MoPilot credits in 'mopilot', a model config in 'routed' */
  mode: 'subscription' | 'apiKey' | 'mopilot' | 'routed';
  /** third-party endpoint the key is for; null = Anthropic */
  baseUrl: string | null;
  /** the opt-in to the shell's cloud-provider variables (off by default) */
  cloudEnv: boolean;
  /** the shell exports at least one cloud-provider switch */
  cloudDetected: boolean;
  /** Your own provider: whether this app can route (MoPilot's model router), the model config chosen and its name (null once removed) */
  routed: { available: boolean; configId: string | null; name: string | null };
}

export interface ClaudeDetect extends OffPathFields {
  state: 'ready' | 'signin' | 'apikey' | 'missing' | 'error';
  bin: string | null;
  version: string | null;
  candidates: CliCandidate[];
  plan: { organizationType: string | null; rateLimitTier: string | null } | null;
  /** the Claude account this describes */
  account?: string;
  /** how the CLI is paid for: subscription, API key (maybe on a third-party endpoint) or MoPilot credits */
  billing?: { mode: 'subscription' | 'apiKey' | 'mopilot' | 'routed'; provider: string; label: string };
  auth?: { loggedIn: boolean; authMethod: string | null; apiProvider: string | null; subscriptionType: string | null };
  error?: string;
  /** the CLI ran, but the key, credits or cloud account it was given was refused; `error` says which */
  rejected?: boolean;
}

/** Progress of a Claude Design sign-in (/design-login) a window started under `id`. */
export type ClaudeDesignLoginEvent =
  | { id: string; kind: 'pages'; url: string | null; manualUrl: string | null; manualFirst: boolean }
  | { id: string; kind: 'done'; ok: boolean; message?: string };

export interface ClaudeSessionOpts {
  bin?: string | null;
  sessionId: string;
  resume: boolean;
  cwd: string;
  model?: string | null;
  effort?: string | null;
  permission?: string;
  /** the chat's own permission while `permission` is 'plan': what an approved plan returns to */
  basePermission?: string;
  fast?: boolean;
  /** side chat: fork this session (unpersisted) on the first message */
  forkFrom?: string;
  /** side chats live only in memory, so they're never reaped while idle */
  ephemeral?: boolean;
  /** Claude account to run as (electron/harness/claude/accounts.cjs); omitted = the one in use */
  account?: string;
}

export interface ClaudeSessionInfo {
  sessionId: string;
  summary: string;
  lastModified: number;
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
  tag?: string;
  createdAt?: number;
}

export type ClaudeEvent =
  // login false: the process ran on a key, MoPilot credits or a cloud account, so its limits and auth errors are not the login's;
  // account: the login the process runs on
  /** serverAccount: the server account the login was when this process started, null while not known (#1582) */
  | { key: string; kind: 'message'; msg: SDKMessage; login?: boolean; account?: string; serverAccount?: string | null; activityAt?: number }
  | {
      key: string;
      kind: 'permission';
      requestId: string;
      toolName: string;
      input: unknown;
      toolUseID: string | null;
      suggestions: unknown[] | null;
      blockedPath: string | null;
      title: string | null;
      description: string | null;
      decisionReason: string | null;
    }
  | { key: string; kind: 'permissionCancelled'; requestId: string; line?: string }
  /** Main emitted this only after its live root ExitPlanMode permission was allowed. */
  | { key: string; kind: 'planAccepted'; requestId: string }
  | {
      key: string;
      kind: 'elicitation';
      requestId: string;
      serverName: string;
      message: string;
      mode: 'form' | 'url';
      url: string | null;
      requestedSchema: unknown;
      title: string | null;
    }
  | { key: string; kind: 'processStarted'; cwd?: string }
  | { key: string; kind: 'processRetired' }
  /** A connector reconnect the rail asked for during a turn finished after it: read the connectors again. */
  | { key: string; kind: 'mcpChanged' }
  | { key: string; kind: 'closed' }
  | { key: string; kind: 'transcript' }
  | { key: string; kind: 'rewound' }
  | { key: string; kind: 'tasks'; tasks: unknown[] }
  | { key: string; kind: 'settings'; probe: string; ultracode: boolean; available: boolean }
  | ({ key: string; kind: 'remoteControl' } & RemoteControlView)
  | { key: string; kind: 'error'; error: string; stderr?: string }
  // from the Claude adapter in main (electron/harness/claude/adapter.cjs), which starts the turns
  | {
      key: string;
      kind: 'turnStarting';
      chatId: string;
      clientId: string;
      itemId?: string;
      turnId: string;
      text: string;
      attachments: Attachment[];
      opts: QueuedOptions;
      model: string | null;
      account: string;
    }
  | {
      key: string;
      kind: 'turnStarted';
      chatId: string;
      clientId: string;
      text: string;
      want: { model: string | null; effort: string | null; permission: string; fast: boolean; account: string };
      elsewhere: ElsewhereApp[];
    }
  | { key: string; kind: 'turnFailed'; chatId: string; clientId: string; error: string }
  | { key: string; kind: 'steered'; chatId: string; text: string; attachments: Attachment[]; clientId: string }
  | { key: string; kind: 'steerFailed'; chatId: string; clientId: string }
  | { key: string; kind: 'interrupting' }
  | { key: string; kind: 'threadName'; chatId: string; name: string; provisional: string }
  | { kind: 'goalNotice'; chatId: string; status: string; body: string }
  | { kind: 'accountSwitched'; key: string; chatId: string; from: string; to: string; note: { id: string; text: string } }
  | { kind: 'limitUnresolved'; key: string; chatId: string; reason: 'limit' | 'expired' }
  // a scheduled run or another chat made a Claude chat in main; `history`: it starts from a copied conversation on disk
  | { key: string; kind: 'chatStarted'; chatId: string; cwd: string; worktreeOf: string | null; history?: boolean }
  | { kind: 'toast'; level: 'error' | 'info' | 'success'; text: string };

/** An ACP session/update payload; only the usage_update fields are typed, the rest goes to the translator as is. */
export type AcpSessionUpdate = { sessionUpdate?: string; used?: number; size?: number | null } & Record<string, unknown>;

export type AcpEvent =
  | { key: string; kind: 'turnStart'; turnId: string; user: { id: string; clientId: string | null; content: unknown[] }; human: boolean }
  /** `replaces`: text of the open message this update's text takes the place of (a Host chat's whole message after a lost delta) */
  | { key: string; kind: 'update'; turnId: string | null; update: AcpSessionUpdate; replaces?: string }
  | {
      key: string;
      kind: 'turnEnd';
      turnId: string;
      stopReason: string;
      error: string | null;
      providerError?: string;
      /** the prompt's usage, when the agent answered with one (ACP PromptResponse.usage, unstable) */
      usage?: unknown;
      /** set when main translates (electron/harness/items/acp.cjs): a turn was running when this ended it */
      running?: boolean;
    }
  // the harness's provider failed and it retries in silence (electron/harness/acp/providerErrors.cjs)
  | { key: string; kind: 'providerError'; turnId: string; error: string }
  | { key: string; kind: 'transcriptError'; error: string }
  | {
      key: string;
      kind: 'permission';
      requestId: string;
      turnId: string;
      toolCall: unknown;
      options: { optionId: string; name: string; kind: string }[];
    }
  | { key: string; kind: 'permissionCancelled'; requestId: string; line?: string }
  | {
      key: string;
      kind: 'session';
      sessionId: string;
      caps: unknown;
      note: string | null;
      modes: unknown;
      configOptions: unknown;
      models: unknown;
      /** session/new made it (not loaded or resumed) */
      fresh?: boolean;
    }
  | { key: string; kind: 'unattended'; reason: string }
  | { key: string; kind: 'state'; state: Partial<AcpSessionState> }
  // `working`, set when main translates (electron/harness/items/acp.cjs): a turn was running when the harness quit
  | { key: string; kind: 'closed'; error: string; working?: boolean }
  // from the ACP turn start in main (electron/harness/acpTurns.cjs)
  | {
      key: string;
      kind: 'turnStarting';
      chatId: string;
      clientId: string;
      itemId?: string;
      text: string;
      attachments: Attachment[];
      note?: QueuedOptions['note'];
    }
  | { key: string; kind: 'turnStarted'; chatId: string; clientId: string; text: string }
  | { key: string; kind: 'turnFailed'; chatId: string; clientId: string; error: string }
  | { key: string; kind: 'threadName'; chatId: string; name: string; provisional?: string }
  // a scheduled run made a basic-tier chat in main (electron/app/automations.cjs); `hostId`: on that remote machine, whose folder `cwd` is
  | {
      key: string;
      kind: 'chatStarted';
      chatId: string;
      cwd: string;
      worktreeOf: string | null;
      hostId?: string;
      projectId?: string | null;
    };
