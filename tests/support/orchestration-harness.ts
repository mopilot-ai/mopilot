// A fake ChatController, chat store and chat starter around a real Orchestrator and journal, for the
// orchestration tests (tests/orchestration*.test.ts). Deferred wake checks run only when `flush()` is called.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { OrchestrationJournal } = require('../../electron/session/orchestration/journal.cjs');
const { Orchestrator } = require('../../electron/session/orchestration/service.cjs');
const { chatGoalStatus } = require('../../electron/session/goalStatus.cjs');

export const SESSION_BACKGROUND =
  'The user requested separate work in this repository. Preserve the task constraints, use focused unit tests, and report the result to the parent.';

export type Harness = ReturnType<typeof orchestration>;

export function orchestration(over: any = {}) {
  const states = new Map<string, any>();
  const rts = new Map<string, any>();
  const refs = new Map<string, any>();
  const log: any[] = [];
  const deleted = new Set<string>();
  const deferred: (() => void)[] = [];
  const records = new Map<string, any>([['top', { meta: { worktreeOf: '/repo-base' } }]]);
  let made = 0;
  const controller = {
    state: {
      get: (id: string) => ({ turn: 'idle', queue: [], approvals: [], activeTurn: null, ...(states.get(id) ?? {}) }),
      // main's record of the goal (SessionStore goalStatus): this harness keeps it in the chat's state
      goalStatus: (id: string) => chatGoalStatus(undefined, states.get(id)?.goal),
      // the chats main has a session state for: every chat this harness made or set a state for
      all: () => [...new Set([...records.keys(), ...states.keys()])],
    },
    rt: (id: string) => rts.get(id) ?? { inputToken: 'pending-turn1', token: 'pending-turn1' },
    ref: (id: string) => refs.get(id) ?? { kind: 'codex', id: `native-${id}`, key: id },
    send: (id: string, item: any) => {
      log.push(['controller.send', id, item]);
      return over.controllerSend ? over.controllerSend(id, item) : { action: 'queued', id: item.id };
    },
    // ChatController.deliverFamily: the fake's `controllerSend` receipt decides, a started or steered one delivers
    deliverFamily: async (id: string, item: any) => {
      const receipt: any = await controller.send(id, item);
      return {
        started: receipt?.action === 'started' || receipt?.action === 'steered',
        ...(receipt?.error ? { error: receipt.error } : {}),
      };
    },
    stopChat: async (id: string) => (log.push(['stopChat', id]), true),
  };
  const newId = (prefix: string) => {
    const id = `${prefix}${++made}`;
    records.set(id, { meta: {} });
    return id;
  };
  const starter = {
    discardWorktree: over.discardWorktree,
    retainWorktree: over.retainWorktree,
    newWorktree: async (cwd: string, o: any) => (
      log.push(['newWorktree', cwd, o]), over.worktree === undefined ? { path: `${cwd}-wt` } : over.worktree
    ),
    forkCodex: async (threadId: string, cwd: string, worktreeOf: string | null) => (
      log.push(['forkCodex', threadId, cwd, worktreeOf]), newId('codexfork')
    ),
    startCodex: async (cwd: string, worktreeOf: string | null) => (log.push(['startCodex', cwd, worktreeOf]), newId('codex')),
    forkClaude: async (threadId: string, cwd: string, worktreeOf: string | null) => (
      log.push(['forkClaude', threadId, cwd, worktreeOf]), newId('claudefork:')
    ),
    startClaude: (cwd: string, worktreeOf: string | null, o?: any) => (log.push(['startClaude', cwd, worktreeOf, o]), newId('claude:')),
    startAcp: (basic: string, cwd: string, worktreeOf: string | null) => (
      log.push(['startAcp', basic, cwd, worktreeOf]), newId(`acp:${basic}:`)
    ),
  };
  const journal = over.journal ?? new OrchestrationJournal({ file: '/nonexistent/orchestration.json', write: over.write ?? (() => {}) });
  const orch = new Orchestrator({
    journal,
    controller,
    chats: { records, isDeleted: (id: string) => deleted.has(id) },
    starter,
    usable: over.usable ?? (async () => true),
    projectOf: over.projectOf ?? (async () => '/repo'),
    worktreeInfo: over.worktreeInfo ?? (() => null),
    readExcerpt: over.readExcerpt ?? (async () => 'User: earlier'),
    send: over.send ?? (async (id: string, item: any) => (log.push(['send', id, item]), { started: true })),
    prefs: over.prefs ?? (() => ({ maxParallelChildren: 3 })),
    title: over.title ?? ((id: string) => (id === 'top' ? 'Top chat' : null)),
    ...(over.said ? { said: over.said } : {}),
    ...(over.remotelyDriven ? { remotelyDriven: over.remotelyDriven } : {}),
    // archived as the inactive-chat sweep does: the chat's record says when
    archive:
      over.archive ??
      ((id: string) => {
        log.push(['archive', id]);
        records.get(id).meta.archived = 1000;
        return true;
      }),
    now: over.now ?? (() => 1000),
    // git and gh for a session's facts and card actions (bringBack.cjs); none unless a test gives them
    run: over.run ?? {
      git: async () => ({ ok: false, stdout: '', stderr: 'no git here' }),
      gh: async () => ({ ok: false, stdout: '', stderr: '' }),
    },
    factsMs: over.factsMs,
    approveStart: over.approveStart ?? (async () => true),
    defer: (fn: () => void) => deferred.push(fn),
  });
  /** the user's turn is running in `id` */
  const userTurn = (id = 'top') => states.set(id, { turn: 'running', activeTurn: { id: 'pending-turn1', human: true } });
  const flush = () => {
    while (deferred.length) deferred.shift()?.();
  };
  return { orch, journal, controller, states, rts, refs, records, deleted, log, deferred, flush, userTurn, starter };
}
