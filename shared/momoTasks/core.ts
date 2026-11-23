// What the task manager's parts share: the ports, the refusal type, the item builder, failure recording and the owed-card delivery.
import * as failure from './failure.ts';
import type { FailureContext } from './failure.ts';
import type { ItemStore } from './store.ts';
import type {
  ChatSink,
  CheckPort,
  Clock,
  CreateInput,
  Home,
  Item,
  MachineInfo,
  MachinePort,
  ResultCard,
  TaskError,
  TaskResult,
  TaskState,
  TaskWords,
  Where,
} from './types.ts';
import type { Reading, RoutineWatch } from './watch.ts';

/** One run plus up to two retries (the design's starting values). */
export const RETRIES = 2;
export const BASE_ATTEMPTS = 1 + RETRIES;
/** Moving to another machine earns one more round of retries, once; nothing runs more often than this in total. */
export const HARD_ATTEMPTS = 2 * BASE_ATTEMPTS;
export const MAX_WORKING = 5;

export type RefusalCode =
  | 'nested'
  | 'not_user_started'
  | 'bad_input'
  | 'unknown_item'
  | 'bad_state'
  | 'same_failure'
  | 'bad_watch'
  | 'bad_target'
  | 'not_offered';
/** The caller asked for something the rules do not allow. The message says what; nothing was changed. */
export class TaskRefusal extends Error {
  readonly code: RefusalCode;
  constructor(code: RefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Reads what a watch looks at, with no model; the home implements it over its Google client, files and an HTTPS fetcher. */
/**
 * The reader must treat the address as untrusted: resolve the name itself, refuse every private, loopback, link-local or metadata address it
 * would connect to (parseWatch only screens the name as written), and follow no redirects.
 */
export interface WatchReader {
  toolIsReadOnly(tool: string): Promise<boolean>;
  read(watch: RoutineWatch): Promise<Reading>;
}

export type ManagerPorts = {
  store: ItemStore;
  machines: MachinePort;
  check: CheckPort;
  chat: ChatSink;
  clock: Clock;
  /** A CSPRNG token: ids, session keys and the check's data marker come from it. */
  randomId(): string;
  /** MoMo's home and its signed-in agent: where a task runs unless the user picks another. */
  home(): Promise<Home>;
  /** The Host's refusal and failure words, shared with a Remote Run chat. */
  words: TaskWords;
  watches?: WatchReader;
};

export const TERMINAL: ReadonlySet<TaskState> = new Set(['done', 'failed', 'stopped']);
/** A failure never overwrites these: the user stopped it, or it already finished. */
const CLOSED: ReadonlySet<TaskState> = new Set(['done', 'stopped']);

export function createCore(ports: ManagerPorts) {
  const { store, machines, chat, clock, randomId } = ports;

  const ctxFor = async (where: Where, list?: MachineInfo[]): Promise<FailureContext> => {
    const all = list ?? (await machines.list());
    return {
      machine: all.find((m) => m.machineId === where.machineId) ?? null,
      machineId: where.machineId,
      harness: where.harness,
      machines: all,
      words: ports.words,
      knownName: where.machineName ?? null,
      now: clock.now(),
    };
  };

  const fresh = (item: Item, patch: Partial<Item>): Item => ({ ...item, ...patch, updatedAt: clock.now() });

  function cardOf(item: Item): ResultCard {
    const state = item.state === 'done' ? 'done' : item.state === 'failed' ? 'failed' : 'needs_you';
    const base = {
      itemId: item.id,
      settle: item.settled,
      title: item.title,
      machineId: item.where.machineId,
      sessionId: item.where.sessionId,
      untrusted: true as const,
    };
    if (state === 'failed') {
      const error = item.lastError as TaskError;
      return {
        ...base,
        state,
        summary: error.message,
        files: [],
        evidence: '',
        checked: '',
        actions: [...new Set(error.fixes.map((f) => f.action))],
      };
    }
    // done and "finished but not done" always carry the session's result
    const { summary, files, evidence, checked } = item.result as TaskResult;
    return { ...base, state, summary, files, evidence, checked, actions: state === 'done' ? ['openSession'] : ['review', 'openSession'] };
  }

  /** The item as it settles: one more settle, and the card the chat is owed, captured now from this state alone. */
  const settleWith = (cur: Item, patch: Partial<Item>): Item => {
    const next = fresh(cur, { ...patch, settled: cur.settled + 1 });
    return { ...next, card: cardOf(next) };
  };

  const posting = new Set<string>();
  /**
   * Delivers every card the chat is owed, each as it was captured when its item settled; one that cannot be delivered stays owed for
   * the next call and never holds up another. Watch notices owed are delivered too. Returns how many went.
   */
  async function flushCards(): Promise<number> {
    let sent = 0;
    for (const item of await store.list()) {
      const owesCard = item.posted < item.settled;
      if ((!owesCard && !item.notice) || posting.has(item.id)) continue;
      posting.add(item.id);
      try {
        if (owesCard) {
          if (item.card) {
            await chat.postResult(item.card);
            sent++;
          }
          await store.update(item.id, (cur) => ({
            ...cur,
            posted: Math.max(cur.posted, item.settled),
          }));
        }
        if (item.notice) {
          await chat.postWatchChanged(item.notice);
          sent++;
          await store.update(item.id, (cur) => ({ ...cur, notice: null }));
        }
      } catch {
        // stays owed: the next flush tries again
      } finally {
        posting.delete(item.id);
      }
    }
    return sent;
  }

  /**
   * Records a failure (a failed item is never started again by itself) and owes the chat one card. A session that fails with the
   * same words twice in a row stops offering Retry on that machine. A stopped or finished item is left as it is.
   */
  async function fail(id: string, make: (c: FailureContext) => TaskError, list?: MachineInfo[]): Promise<Item> {
    const current = (await store.get(id)) as Item;
    const c = await ctxFor(current.where, list);
    let error = make(c);
    const words = error.code === 'session_failed' ? error.message : null;
    if (words !== null && current.failedWith === words) error = failure.sameFailure(c, error);
    await store.update(id, (cur) =>
      CLOSED.has(cur.state)
        ? null
        : settleWith(cur, { state: 'failed', lastError: error, progress: null, cardId: null, nextCheck: null, failedWith: words }),
    );
    await flushCards();
    return (await store.get(id)) as Item;
  }

  function validate(input: CreateInput): { title: string; doneMeans: string } {
    if (input.callerItemId)
      throw new TaskRefusal('nested', 'A task cannot start tasks, routines or rules. Tell the user what should repeat instead.');
    if ((input.origin === 'asked' || input.origin === 'suggestion') && input.userStarted !== true)
      throw new TaskRefusal('not_user_started', 'Only the user starting it (a message, or Start on a suggestion) can begin this task.');
    const title = input.title.trim().slice(0, 120);
    const doneMeans = input.doneMeans.trim().slice(0, 300);
    if (!title || !doneMeans) throw new TaskRefusal('bad_input', 'A task needs a title and a done-means line.');
    return { title, doneMeans };
  }

  async function build(input: CreateInput, state: TaskState, extra: Partial<Item>): Promise<Item> {
    const { title, doneMeans } = validate(input);
    const home = await ports.home();
    const now = clock.now();
    return {
      id: randomId(),
      title,
      doneMeans,
      state,
      where: { machineId: input.where?.machineId ?? home.machineId, harness: input.where?.harness ?? home.harness, sessionId: null },
      origin: input.origin,
      stableKey: input.stableKey ?? `${input.origin}:${title.toLowerCase()}:${doneMeans.toLowerCase()}`,
      attempts: 0,
      attemptCap: BASE_ATTEMPTS,
      lastError: null,
      result: null,
      progress: null,
      cardId: null,
      watch: null,
      nextCheck: null,
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      settled: 0,
      posted: 0,
      card: null,
      notice: null,
      failedWith: null,
      ...extra,
    };
  }

  return { ports, store, machines, chat, clock, randomId, ctxFor, fresh, settleWith, flushCards, fail, validate, build };
}
export type Core = ReturnType<typeof createCore>;
