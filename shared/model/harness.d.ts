// The harness contract main and every window share, as types only: what a harness is, what it can do (its bindings,
// negotiated features and caps), its models and accounts, and the native CLI and ACP records the windows read.
import type { SEMANTICS } from '../caps.mjs';
import type { HarnessInstallInfo } from '../harnessInstall.mjs';

export type HarnessKind = HarnessId | `acp:${string}`;

/** One native session. Resolve the segment (and any pending switch) before acting on it. */
export type NativeRef = { kind: HarnessKind; id: string; instance: string };

export type Semantic = (typeof SEMANTICS)[number];

export type WhyLayer = 'harness' | 'version' | 'provider' | 'account' | 'model' | 'flag' | 'session';

export type WhyFix = 'signIn' | 'install' | 'upgrade' | 'enableFeature' | 'switchModel' | 'switchHarness' | 'newChat' | 'wait';

export type Why = { layer: WhyLayer; code: string; fix?: WhyFix };

/** Sage's own implementations: the first four stand in for a first-tier harness's missing command; the rest are shared by every harness. */
export type PolyfillEngine =
  | 'init'
  | 'shell'
  | 'archive'
  | 'search'
  | 'computerUse'
  | 'browser'
  | 'dictation'
  | 'plugins'
  | 'computerHistory'
  | 'design'
  | 'momoContext';

export type Binding =
  | { via: 'rpc'; method: string }
  | { via: 'passthrough'; template: string }
  | { via: 'config'; option: string; value: unknown }
  | { via: 'polyfill'; engine: PolyfillEngine }
  | { via: 'route'; to: HarnessId }
  | { via: 'none'; why: Why };

/** Every entry point lands on exactly one of these. */
export type CapState = 'native' | 'sage' | 'route' | 'disabled' | 'absent';

export interface StaticInfo {
  kind: HarnessKind;
  label: string;
  vendor: string;
  /** first tier: what a user goes back to when a gateway can't serve something ("ChatGPT account") */
  subscription?: string;
  /** first tier: the plans that subscription covers, said under it on the welcome page ("Claude Pro or Max") */
  subscriptionPlans?: string;
  tier: 'first' | 'basic';
  channel: 'app-server' | 'agent-sdk' | 'acp';
  /** looked up on the login shell's PATH; Settings can pick a bin by hand */
  detect: { bins: string[] };
  /** the vendor's install commands and setup page (shared/harnessInstall.mjs) */
  install: HarnessInstallInfo;
  /** above min and not known-bad works as usual; only failed probes grey out */
  versions: { min: string; knownBad: string[]; tested: string[] };
  wires: ('anthropic' | 'responses' | 'chat')[];
  /** bare names are read per repository; a ~/ or absolute path is the user-level file Settings edits */
  instructionsFiles: string[];
  skillRoots: string[];
  docsUrl: string;
  dataNotes: string[];
  resumeCommand(nativeId: string): string | null;
  /** basic tier: electron/harness/acp/quirks/<id>.cjs */
  quirks?: string;
  /** basic tier, required: default uploads and telemetry turned off at launch. Without it the harness stays out of the picker. */
  privacyDefaults?: string[];
  admission?: { requireToolHandshake: true; handshakeTimeoutMs: number; privacyGate?: string };
}

/** Negotiated per (harness, instance). Anything not declared counts as unsupported. */
export interface Negotiated {
  cliVersion: string;
  versionStatus: 'ok' | 'unverified' | 'knownBad';
  /** e.g. claude.getSettings, claude.perTaskStop, codex.pluginDisable, codex.threadProviders */
  probes: Record<string, boolean>;
  prompt: { image: string[]; pdf: boolean; humanOrigin: boolean; slashLastBlockOnly: boolean };
  session: {
    load: boolean;
    resume: boolean;
    fork: 'none' | 'whole' | 'upToTurn';
    rewind: boolean;
    ephemeral: 'native' | 'none';
    perTaskStop: boolean;
    history: 'native' | 'sage';
  };
  permissions: { scope: 'turn' | 'session'; remember: 'native' | 'none' };
  approvals: ApprovalKind[];
  /** one channel per harness; a basic harness without sessionMcp is not admitted */
  toolInjection: 'sdkMcp' | 'threadConfigMcp' | 'sessionMcp';
  events: { turnEnd: boolean; usage: 'cost' | 'tokens' | 'context' | 'none'; tasks: 'stoppable' | 'cancelAll' | 'none' };
  accounts: { failover: 'inRequest' | 'restartResume' | 'none'; perChat: boolean; usage: 'live' | 'polled' | 'none' };
  ext: Partial<Record<'realtimeVoice' | 'cloudTasks' | 'feedbackUpload' | 'remoteControl' | 'outputStyle', true>>;
}

/** Held by main. Windows take a snapshot, then apply patches in rev order and refetch on a gap. */
export interface SessionState {
  rev: number;
  turn: 'idle' | 'running' | 'awaitingUser' | 'crashed';
  /** another client is running a turn on this session */
  runningElsewhere: boolean;
  config: ConfigOption[];
  modes: ModeOption[];
  mode: string;
  plan: boolean;
  commands: CommandInfo[];
  goal: GoalSnapshot | null;
  tasks: TaskSnapshot[];
  context: { used: number; window: number } | null;
}

/** Same shape as ACP configOptions. */
export interface ConfigOption {
  id: string;
  name: string;
  type: 'select' | 'boolean';
  currentValue: unknown;
  category: 'mode' | 'model' | 'model_config' | 'thought_level' | `_sage.${string}`;
  options?: { value: unknown; name: string; why?: Why }[];
}

/** Basic-tier modes without an anchor count as 'ask'. */
export interface ModeOption {
  id: string;
  label: string;
  anchor: 'readOnly' | 'ask' | 'auto' | 'full';
  note?: string;
}

export interface CommandInfo {
  name: string;
  aliases?: string[];
  description: string;
  hint?: string;
  semantic?: Semantic;
  why?: Why;
  source: 'app' | 'builtin' | 'skill' | 'workflow' | 'plugin' | 'custom';
  dispatch: 'ui' | 'passthrough' | 'rpc' | 'polyfill';
}

export interface GoalSnapshot {
  objective: string;
  status: 'active' | 'paused' | 'blocked' | 'budgetLimited' | 'usageLimited' | 'complete' | 'failed';
  /** codex: all five; claude: pause, resume, budget, clear */
  controls: ('pause' | 'resume' | 'budget' | 'edit' | 'clear')[];
  /** claude's pause is held by Sage: interrupt() then '/goal clear' */
  pauseBy: 'harness' | 'sage';
  /** codex tokenBudget (soft, settled per turn); claude: Sage counts Stop hook rounds */
  budgetBy: 'harness' | 'sage' | null;
  /** codex: thread/goal/*; claude: 'Goal set:' and 'Stop hook feedback' synthetic messages */
  source: 'rpc' | 'syntheticMessages';
  rounds?: number;
  tokens?: number;
  budget?: { rounds?: number; tokens?: number; soft: boolean };
  lastReason?: string;
}

export interface TaskSnapshot {
  id: string;
  kind: 'workflow' | 'agent' | 'shell' | 'monitor' | 'cron' | 'review';
  name: string;
  status: string;
  stoppable: boolean;
}

export type ApprovalKind =
  | 'command'
  | 'fileChange'
  | 'permissions'
  | 'question'
  | 'elicitation'
  | 'tool'
  | 'plan'
  | 'computerAccess'
  | 'browserOrigin'
  | 'computerConfirm'
  | 'visionConsent';

export type SageInputPart = { type: 'text' | 'image' | 'file' | 'skill' | 'mention' | 'selection' | 'handoff'; value: string };

export interface ProviderProfile {
  id: string;
  wires: ('anthropic' | 'responses' | 'chat')[];
  baseUrl: string;
  firstParty: boolean;
  models: ModelInfo[];
  /** semantics the endpoint can't serve (MoPilot's come from the gateway capability table) */
  drops: string[];
  effortLevels?: string[];
  compactWindow?: number;
  visionFallbackModel?: string | null;
}

export interface ModelInfo {
  id: string;
  label: string;
  /** basic tier: 'unknown' */
  input: ('text' | 'image')[] | 'unknown';
  efforts: string[];
  /** has a multi-agent setting (codex effort 'ultra', claude ultracode) */
  ultra: boolean;
  /** Service tiers the model offers (codex: 'priority' is Fast, others as the model lists them) */
  serviceTiers: string[];
}

export interface AccountCaps {
  billing: 'subscription' | 'apiKey' | 'credits';
  perChat: boolean;
  fast: boolean;
  /** why fast is off, a FAST_BLOCKED_TEXT key (Claude's fast_mode_disabled_reason) */
  fastBlocked?: string | null;
  /** Codex realtime voice currently needs a signed-in ChatGPT subscription. */
  voiceChat?: boolean;
  /** false: the chat's account can't use its harness's own speech service (nativeDictation) */
  nativeDictation?: boolean;
  /** the login that service needs, for the reason shown: 'chatgpt' */
  dictationAccount?: string;
  /** Codex's Remote Control needs a signed-in ChatGPT subscription. */
  remoteControlChatGPT?: boolean;
  /** Claude Code publishes artifacts and designs only on a claude.ai subscription login. */
  artifacts?: boolean;
  /** Claude Code's Remote Control links a session to a claude.ai subscription login only. */
  remoteControl?: boolean;
}

/** Remote kill switches plus the harness's own features.* */
export type FeatureFlags = Record<string, boolean>;

/** serverName = sage_<per-session nonce> */
export interface SageToolset {
  serverName: string;
  token: string;
  tools: string[];
}

export type SageItem = { id: string; kind: string; [k: string]: unknown };

export interface HarnessAdapter {
  info: StaticInfo;
  negotiate(instance: string): Promise<Negotiated>;
  /** every semantic must take a position */
  bindings(n: Negotiated, s: SessionState | null): Record<Semantic, Binding>;
  start(o: { cwd: string; instance: string; config: Record<string, unknown>; ephemeral: boolean; tools: SageToolset }): Promise<NativeRef>;
  send(r: NativeRef, m: { parts: SageInputPart[]; origin: 'human' | 'sage'; uuid: string }): Promise<void>;
  invoke(r: NativeRef, s: Semantic, args: string): Promise<void>;
  interrupt(r: NativeRef, o: { pauseGoal: boolean; keepBackground: boolean }): Promise<void>;
  /** required when events.tasks is 'stoppable' */
  stopTask?(r: NativeRef, taskId: string): Promise<void>;
  setConfig(r: NativeRef, id: string, value: unknown): Promise<SessionState>;
  setMode(r: NativeRef, mode: string, plan: boolean): Promise<SessionState>;
  answer(r: NativeRef, requestId: string, optionId: string, note?: string): Promise<void>;
  history(r: NativeRef, cursor?: string): Promise<{ items: SageItem[]; next?: string }>;
  /** reread native state after another client rewrote the rollout or jsonl */
  reconcile(r: NativeRef): Promise<SessionState>;
  events(r: NativeRef, on: (e: SageItem | Partial<SessionState> | { crashed: string }) => void): () => void;
}

export type HarnessId = 'codex' | 'claude';

export type HarnessState = 'detecting' | 'ready' | 'signin' | 'apikey' | 'missing' | 'error';

export interface UsageWindow {
  label: string;
  usedPercent: number;
  /** unix seconds */
  resetsAt: number | null;
  /** human-readable reset time when only text is available ("Oct 9 at 12:29am") */
  resetsText?: string | null;
  /** when it was measured (ms), for a window kept from a reading older than the one it is in */
  at?: number;
}

/** What asks for usage: a timer, a surface showing the account opening, or the user (main decides whether a read is due). */
export type UsageReason = 'background' | 'surface' | 'now';

export interface HarnessStatus extends OffPathFields {
  state: HarnessState;
  bin: string | null;
  version: string | null;
  candidates?: CliCandidate[];
  /** "ChatGPT Pro", "Claude Max 20×" */
  plan: string | null;
  email?: string | null;
  usage: {
    windows: UsageWindow[];
    status?: string | null;
    at: number;
    fetchState?: 'loading' | 'success' | 'unavailable' | 'error';
    fetchError?: string | null;
    attemptedAt?: number;
    /** Claude Code: the server account the figures are of (null: not known); a reading of another is never shown */
    account?: string | null;
  } | null;
  error?: string | null;
  /** the harness ran, but refused the credential it was given (a key, credits): `error` says which, and no sign-in fixes it */
  rejected?: boolean;
  /** why fast mode can't be used on this account (Claude: e.g. extra usage turned off) */
  fastBlocked?: string | null;
  /** not started on purpose: it starts the first time it is used (D-66), so it is not being checked either */
  idle?: boolean;
}

export interface HarnessModel {
  id: string;
  label: string;
  description?: string;
  efforts: string[];
  defaultEffort: string | null;
  fast: boolean;
  /** Codex: every service tier the model lists (Fast and any others) */
  tiers?: ServiceTier[];
  autoMode?: boolean;
  isDefault?: boolean;
  /** pinned versions shown under "More versions" */
  more?: boolean;
  /** wire model id an alias resolves to (Claude: 'opus' → 'claude-opus-5-5') */
  resolved?: string;
}

export interface Selection {
  model: string | null;
  effort: string | null;
  fast: boolean;
  /** Codex: the chosen service tier id; null is Standard */
  tier?: string | null;
}

export type HandoffMode = 'auto' | 'summary' | 'workspace' | 'delta';

/**
 * One stretch of a Sage chat that ran on one native session. A chat that never switched has no
 * segment list; its id is its native id. After the first switch the chat keeps that first id and
 * later segments point at their own native sessions (hidden from the sidebar).
 */
export interface Segment {
  harness: HarnessKind;
  /** Codex thread id, 'claude:<id>', or 'acp:<harness>:<id>'. */
  nativeId: string;
  /** index of this segment's first turn in the chat */
  start: number;
  /** number of turns, set when the segment ends; null for the active one */
  count: number | null;
  model: string | null;
  handoff: { mode: HandoffMode; tokens: number; text: string /** a switch back: messages caught up */; caught?: number } | null;
}

/** A confirmed switch waiting for the next message (the composer shows it as a chip). */
export interface PendingSwitch {
  harness: HarnessKind;
  /** null captures the native default; an empty legacy value has not been resolved yet. */
  model: string | null;
  modelLabel: string;
  effort?: string | null; // set_session_harness's pick for the target
  mode: Exclude<HandoffMode, 'delta'>;
  /** SwitchSheet choices: the goal's condition to set again on the new segment (null: leave it paused) */
  goal?: string | null;
  multiAgent?: boolean; // carry multiple agents over (off unless ticked)
  /** the account the chat goes on there, chosen in the picker (null: the chat's own, else the harness's) */
  account?: string | null;
  /** Explicitly clear a prior account pin when switching. */
  automaticAccount?: boolean;
}

/** A basic harness and its runtime admission. */
export type BasicHarness = BasicHarnessStatus;

export interface ServiceTier {
  id: string;
  name: string;
  /** the model's own note for the tier (its price or speed), shown as given */
  description: string;
}

/** Whether the user's terminal runs the CLI MoPilot runs (main's userTools.cjs pathStatus); set only when it doesn't. */
export interface OffPathFields {
  offPath?: boolean;
  /** what the terminal's PATH runs instead; null when it reaches none */
  terminal?: string | null;
}

/** One installed copy of a CLI and its version, with whether the user's terminal runs it (main's userTools.cjs). */
export interface CliCandidate extends OffPathFields {
  path: string;
  version: string | null;
  /** how it was installed (main's installMethod.cjs): what Settings names it by */
  via?: HarnessVersionInfo['via'];
  /** where it came from ("ChatGPT.app", "npm (~/.npm-global)") */
  from?: string;
}

export interface BasicHarnessStatus extends OffPathFields {
  /** Main's validated contract for an installed ACP registry adapter. */
  descriptor?: import('../harnessCatalog.mjs').NativeAcpDescriptor;
  /** Managed sign-in owner; null means unavailable, while undefined keeps the native binary's login contract. */
  authBin?: string | null;
  id: string;
  label: string;
  state: 'admitted' | 'unsupported' | 'signin' | 'missing' | 'checking' | 'off';
  reason: string | null;
  bin: string | null;
  version: string | null;
  authMethods: {
    id: string;
    name: string;
    description?: string | null;
    /** ACP's terminal auth method: 'terminal' runs the harness's own binary with args and env to sign in */
    type?: string;
    args?: unknown;
    env?: unknown;
    _meta?: {
      'terminal-auth'?: { command: string; args?: unknown; label?: string; env?: unknown };
      type?: unknown;
      args?: unknown;
      env?: unknown;
    } & Record<string, unknown>;
  }[];
  /** argv for signing in in a terminal, from its quirks */
  login: string[] | null;
  /** what its last new session offered (modes, model, effort, …), shown in a new chat before its session opens */
  catalog?: AcpCatalog | null;
  /** whether its prompts take images, as its last handshake declared; null: not known yet */
  images?: boolean | null;
  /** mode id → the composer's permission row it stands for, from its quirks; unlisted modes keep their own names */
  permissionModes?: Record<string, 'read-only' | 'default' | 'auto-review' | 'full-access'>;
  /** mode ids that are the agent's own (opencode's build), shown apart from the permission modes, from its quirks */
  agentModes?: string[];
  /** its quirks confine it for MoMo's chats (#2278): only then can it be MoMo's brain */
  isolates?: boolean;
  /** why MoMo can't run on it now though it isolates (opencode with free models only, #2357), or null */
  momoBlocked?: string | null;
}

/** A harness's modes and config options with the agent's own current values. */
export type AcpCatalog = Pick<AcpSessionState, 'modes' | 'configOptions'> & {
  models?: { availableModels: { modelId: string; name?: string }[] } | null;
};

/** What a basic harness declared for a session (main's SessionState.acp). */
export interface AcpSessionState {
  modes: { currentModeId: string; availableModes: { id: string; name: string; description?: string | null }[] } | null;
  configOptions: AcpConfigOption[] | null;
  /** null until the harness pushes available_commands_update */
  commands: { name: string; description: string; input?: { hint?: string } | null }[] | null;
  usage: { used: number | null; size: number | null } | null;
  /** mode id → readOnly | ask | auto | full, from the quirks; an unlisted mode is ask */
  anchors?: Record<string, 'readOnly' | 'ask' | 'auto' | 'full'>;
}

export interface AcpConfigOption {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  type: 'select' | 'boolean' | string;
  currentValue: unknown;
  options?: (
    | { value: unknown; name: string; description?: string | null }
    | { group: string; name: string; options: { value: unknown; name: string; description?: string | null }[] }
  )[];
}

export interface HarnessUpdateOutcome {
  result: 'updated' | 'unchanged' | 'failed' | 'broken';
  from: string | null;
  to: string | null;
  message: string;
  /** the run it came from (harnessRuns), whose output can be shown */
  runId?: string | null;
}

/** One installed harness as main read it: the binary chats run, its version, the newest and how it updates. */
export interface HarnessVersionInfo {
  /** the registry kind: 'codex', 'claude', 'acp:<id>' */
  harness: string;
  bin: string;
  installed: string | null;
  /** null: not known (offline, or nothing to ask) */
  latest: string | null;
  via: 'self' | 'brew' | 'npm' | 'bun' | 'pnpm' | 'app-bundle' | 'unknown';
  /** where it came from, as the row says it ("npm (~/.npm-global)", "Homebrew cask", "Claude.app") */
  from: string;
  /** the update as a person would type it; null when there is none */
  command: string | null;
  updatable: boolean;
  blockedReason: 'unknown-install' | 'needs-admin' | 'app-bundle' | 'version-manager' | 'manual-terminal' | null;
  /** the compatibility table's word for the newest version (first-class only; null for the rest) */
  latestStatus: 'ok' | 'unverified' | 'tooOld' | 'knownBad' | null;
  checkedAt: number | null;
  state: 'idle' | 'checking' | 'waiting' | 'updating';
  /** chats still mid-turn while an update waits for them */
  waitingFor: number;
  /** the run under way (harnessRuns) */
  runId: string | null;
  /** the run under way downloads again: the first left out a package it couldn't fetch */
  retrying?: boolean;
  outcome: HarnessUpdateOutcome | null;
}
