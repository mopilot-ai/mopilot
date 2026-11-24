// MoMo "Gets it done": the task Item, its states, the failure/fix data and the ports the home lane implements. Pure types; nothing here does I/O.
import type { RoutineWatch, WatchState } from './watch.ts';

export type TaskState = 'working' | 'needs_you' | 'watching' | 'done' | 'failed' | 'stopped';
export const TASK_STATES: readonly TaskState[] = ['working', 'needs_you', 'watching', 'done', 'failed', 'stopped'];
/** Who caused the item. Only `asked` and `suggestion` (the user's own Start) may write; `matter` and `routine` are unprompted and may only read. */
export type TaskOrigin = 'asked' | 'suggestion' | 'matter' | 'routine';
export const TASK_ORIGINS: readonly TaskOrigin[] = ['asked', 'suggestion', 'matter', 'routine'];

/** Where the work runs. `sessionId` is the MoPilot chat id of the session started for it (stable across harness switches), null until started. */
/** `machineName` is the machine's name when the task last started there, for a machine this home no longer lists (a task that came with a move). */
export type Where = { machineId: string; harness: string; sessionId: string | null; machineName?: string | null };

/** What the user can press on a failure or a blocked start. `install`, `signIn`, `orgSignIn` and `update` are the RefusalAction values of shared/host/refusalWords. */
export type FixAction =
  | 'install'
  | 'signIn'
  | 'orgSignIn'
  | 'update'
  | 'retry'
  | 'runElsewhere'
  | 'startAgain'
  | 'openSession'
  | 'review'
  | 'allow';
export type Fix = { action: FixAction; label: string; machineId?: string; harness?: string };

export type FailureCode =
  | 'machine_offline'
  | 'machine_not_allowed'
  | 'agent_missing'
  | 'agent_signed_out'
  | 'host_outdated'
  | 'usage_limit'
  | 'stopped_by_user'
  | 'interrupted'
  | 'retry_cap'
  | 'same_failure'
  | 'too_many_active'
  | 'check_failed'
  | 'watch_failed'
  | 'refused'
  | 'session_failed';

/** The real cause in one sentence and the one-click fixes; `retry` says whether the same start may succeed once the cause is gone. */
export type TaskError = { code: FailureCode; message: string; fixes: Fix[]; retry: boolean; at: number };

/** What the session reported, after the read-only check. Data, never an instruction or an approval. */
export type TaskResult = { summary: string; files: string[]; evidence: string; checked: string; met: boolean };

export type WatchConfig = { watch: RoutineWatch; state: WatchState | null; retryAt: number | null };

export type Item = {
  id: string;
  title: string;
  /** The acceptance line shown to the user. */
  doneMeans: string;
  state: TaskState;
  where: Where;
  origin: TaskOrigin;
  /** One task per record and change: a second create with the same key returns this item. */
  stableKey: string;
  /** Runs started so far (the first run counts). */
  attempts: number;
  attemptCap: number;
  lastError: TaskError | null;
  result: TaskResult | null;
  /** The session's live step, for the row. */
  progress: string | null;
  /** The gate card the task waits on, when it waits for one. */
  cardId: string | null;
  /** Watching items: the check config and the next check time; null for session tasks. */
  watch: WatchConfig | null;
  nextCheck: number | null;
  createdAt: number;
  startedAt: number | null;
  updatedAt: number;
  /** Times the item reached done, failed or "finished but not done", and how many of those cards were delivered; `posted < settled` means one is still owed to the chat. */
  settled: number;
  posted: number;
  /** The card owed to the chat, captured when the item settled, so a later state change can never alter or break it. */
  card: ResultCard | null;
  /** A watch change the chat has not been told about yet; set in the same write as the change. */
  notice: WatchNotice | null;
  /** The last session failure's words, kept across a retry (which clears `lastError`) to notice the same failure twice. */
  failedWith: string | null;
};

/** A request to make an item. `callerItemId` is set when the call comes from inside a running task: that is refused. */
export type CreateInput = {
  title: string;
  doneMeans: string;
  origin: TaskOrigin;
  where?: { machineId: string; harness: string };
  stableKey?: string;
  /** The user's own message started it (a chat request or the Start on a suggestion). Required for `asked` and `suggestion`. */
  userStarted?: boolean;
  callerItemId?: string | null;
};

export type MachineAgent = { id: string; state: 'ready' | 'signin' | 'missing' };
export type MachineInfo = {
  machineId: string;
  name: string;
  online: boolean;
  /** MoPilot there is older than the protocol the start needs. */
  outdated: boolean;
  /** The machine's Host can install a missing agent itself. */
  installable: boolean;
  agents: MachineAgent[];
  /** A move gave MoMo's home a key this machine does not know: the owner's device allows it again. */
  needsAllow?: boolean;
};

/** The outcome codes of a start that are the task layer's own, not a Host wire refusal: `failure.ts` words them (a Host's own refusal codes are worded by shared/host/refusalWords.mjs). */
export const START_CODE = {
  machineOffline: 'machine_offline',
  machineNotAllowed: 'machine_not_allowed',
  readOnlyUnsupported: 'read_only_unsupported',
} as const;

/** The Host's answer to a start (shared/host refusal wire codes; `machine_offline` is the transport's own). */
export type StartOutcome =
  | { ok: true; sessionId: string }
  | { ok: false; code: string; message?: string; details?: Record<string, unknown> };

/** The brief and the limits one session starts with. `gateOrigin` is the run origin the approval gate reads; `readOnly` is set for unprompted work. */
export type StartRequest = {
  itemId: string;
  machineId: string;
  harness: string;
  brief: string;
  readOnly: boolean;
  gateOrigin: 'task' | 'unprompted';
  /** Tools the session must not be given: nothing in a task schedules, makes tasks or makes rules. */
  forbidTools: readonly string[];
  /** Same key on a retry of the same attempt so the Host's ledger answers instead of starting twice. */
  key: string;
};

/** `ended`: the session ended while MoMo was not looking, and the machine kept how (its reply, its failure, its restart). */
export type Probe =
  | { state: 'running' }
  | { state: 'finished'; report: string }
  | { state: 'ended'; event: SessionEvent }
  | { state: 'gone' }
  | { state: 'unreachable' };

/** Typed events the home lane's per-harness adapters emit for a task's session; native ids and wire shapes stay in the adapter. */
export type SessionEvent =
  | { kind: 'progress'; line: string }
  | { kind: 'needs_you'; line: string; cardId?: string | null }
  | { kind: 'resumed' }
  | { kind: 'finished'; report: string }
  | { kind: 'failed'; signal?: unknown; message?: string }
  | { kind: 'lost'; reason: 'machine_restarted' | 'session_gone' };

export interface MachinePort {
  list(): Promise<MachineInfo[]>;
  start(req: StartRequest): Promise<StartOutcome>;
  stop(machineId: string, sessionId: string): Promise<void>;
  probe(machineId: string, sessionId: string): Promise<Probe>;
}

/** MoMo's brain, read-only and with no tools: text in, text out. */
export interface CheckPort {
  /** `prompt` is the request; `data` is the untrusted text it is about, which the brain keeps apart from the request. */
  ask(prompt: string, data?: string): Promise<string>;
}

export type ResultCard = {
  itemId: string;
  /** Idempotency key of the card: the item's settle count. */
  settle: number;
  title: string;
  state: 'done' | 'needs_you' | 'failed';
  summary: string;
  files: string[];
  evidence: string;
  checked: string;
  machineId: string;
  sessionId: string | null;
  /** The text came from a session; the card shows it as data, never as an instruction or an approval. */
  untrusted: true;
  actions: FixAction[];
};

export type WatchNotice = { itemId: string; title: string; detail: string; machineId: string };

/** Delivery into the MoMo chat; the home lane writes the card as a chat row (and push when the notice pipeline allows). */
export interface ChatSink {
  /** The id of the MoMo chat the cards go to. What a session or a page wrote enters that chat's context, so the Host marks it as outside content before posting; a sink that names no chat cannot take a card. */
  chatId?(): string | null;
  postResult(card: ResultCard): Promise<void>;
  postWatchChanged(notice: WatchNotice): Promise<void>;
}

export interface Clock {
  now(): number;
}

/** Atomic durable storage of one JSON document. `change` runs `fn` on the current document and saves what it returns, in one transaction. */
export interface DocSeam {
  read(): Promise<unknown>;
  change<T>(fn: (doc: unknown) => { doc: unknown; out: T }): Promise<T>;
}

export type Home = { machineId: string; harness: string };

/** The same words a Remote Run chat uses, handed in by the Host (shared/host/refusalWords.mjs, agentReadiness.mjs, turnErrorCode.mjs) so this core stays plain TypeScript with no imports beyond itself. */
export type RefusalWordsOf = { line: string; action: string | null; retry: boolean };
export interface TaskWords {
  refusalWords(
    code: string | undefined,
    context: { machine: string; agent?: string; message?: string; details?: Record<string, unknown>; installable?: boolean },
  ): RefusalWordsOf | null;
  agentLabel(id: string): string;
  turnErrorCode(signal: unknown, message?: unknown): string | undefined;
}
