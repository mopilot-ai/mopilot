// Session tasks: start on the chosen machine, follow the session's typed events, check the finished work against done_means, stop, and recover after a restart without ever running anything again by itself.
import { buildBrief, buildCheckPrompt, FORBIDDEN_TOOLS, isUnprompted, parseCheck, parseReport } from './brief.ts';
import * as failure from './failure.ts';
import { BASE_ATTEMPTS, HARD_ATTEMPTS, MAX_WORKING, TaskRefusal, TERMINAL, type Core } from './core.ts';
import type { Item, SessionEvent, StartOutcome, TaskError, TaskResult, TaskState, Where } from './types.ts';
import { START_CODE } from './types.ts';
import type { CreateInput } from './types.ts';

export type StartResult = { item: Item; error: TaskError | null };
const OPEN: ReadonlySet<TaskState> = new Set(['working', 'needs_you', 'watching']);
/** An id a client may name: no `|` (the separator of a fix id), no spaces. */
const isId = (v: unknown): v is string => typeof v === 'string' && /^[\w.:@-]{1,200}$/.test(v);
const result = (item: Item): StartResult => ({ item, error: item.lastError });

/** An item that may be started: failed, stopped or finished "not done" (the user's retry; one waiting on an open gate card already has its session), or a new one with no session yet. A watch is never a session task. */
const startable = (item: Item): boolean =>
  item.watch === null &&
  (item.state === 'failed' ||
    item.state === 'stopped' ||
    (item.state === 'needs_you' && item.cardId === null) ||
    (item.state === 'working' && item.where.sessionId === null));

/** Finished but not done, waiting for the user: a late failure or loss from the same session must not replace what they are looking at. */
const finishedNotDone = (item: Item): boolean => item.state === 'needs_you' && item.result !== null && item.cardId === null;

export function createRuns(core: Core) {
  const { store, machines, ports, clock, fresh, fail, flushCards, ctxFor, settleWith } = core;
  /** Tasks whose result is being checked now: a second `finished` for one is the same report again. */
  const checking = new Set<string>();
  /** Tasks whose session is being started now: a second start for one would make a second session. */
  const starting = new Set<string>();
  /** What a session said before the task knew its id (a fast failure while the start was still being recorded), by session: replayed once the start is recorded. */
  const early = new Map<string, SessionEvent[]>();
  const MAX_EARLY_SESSIONS = 20;
  const MAX_EARLY_EVENTS = 20;

  /** Makes the item (working, not started yet) and starts its session. A second request with the same stable key returns the first item and starts nothing. */
  async function create(input: CreateInput): Promise<StartResult> {
    const item = await core.build(input, 'working', {});
    const made = await store.insertOrGet(item, MAX_WORKING);
    if ('full' in made) {
      const error = failure.tooManyActive(await ctxFor(item.where), MAX_WORKING);
      return { item: fresh(item, { state: 'failed', lastError: error }), error };
    }
    return made.created ? start(made.item.id) : result(made.item);
  }

  /**
   * Starts the item's session on its machine. A machine problem or the Host's refusal becomes a failed item with the real cause and its fixes;
   * a run that never started is not counted. `where` moves the task to another machine or agent (Run on another machine).
   */
  async function start(id: string, where?: { machineId: string; harness: string }): Promise<StartResult> {
    if (starting.has(id)) throw new TaskRefusal('bad_state', 'This task is already starting.');
    starting.add(id);
    try {
      return await begin(id, where);
    } finally {
      starting.delete(id);
    }
  }

  async function begin(id: string, where?: { machineId: string; harness: string }): Promise<StartResult> {
    const found = await store.get(id);
    if (!found) throw new TaskRefusal('unknown_item', 'No such task.');
    if (!startable(found)) throw new TaskRefusal('bad_state', 'This task is already running or finished.');
    const moved = where !== undefined && (where.machineId !== found.where.machineId || where.harness !== found.where.harness);
    if (found.lastError?.code === 'same_failure' && !moved) throw new TaskRefusal('same_failure', found.lastError.message);
    // a place the task is sent to is checked before anything is claimed or changed: a machine MoMo does not list, or one that cannot run the agent now, leaves the task as it was
    if (moved) {
      const list = await machines.list();
      const target = { ...(where as Where), sessionId: null };
      if (!isId(target.machineId) || !isId(target.harness) || !list.some((m) => m.machineId === target.machineId))
        throw new TaskRefusal('bad_target', "That machine isn't one of yours.");
      const blocked = failure.preflight(await ctxFor(target, list));
      if (blocked) throw new TaskRefusal('bad_target', blocked.message);
    }
    // a retry takes a working slot like a new task does; the others' cap is checked and the slot taken in one step
    if (found.state !== 'working') {
      const claimed = await store.reopen(id, MAX_WORKING);
      if (!claimed || 'full' in claimed) return { item: found, error: failure.tooManyActive(await ctxFor(found.where), MAX_WORKING) };
    }
    if (moved)
      await store.update(id, (cur) =>
        fresh(cur, {
          where: { ...(where as Where), sessionId: null },
          attemptCap: Math.min(cur.attemptCap + BASE_ATTEMPTS, HARD_ATTEMPTS),
          lastError: null,
        }),
      );
    const item = (await store.get(id)) as Item;
    const list = await machines.list();
    if (item.attempts >= item.attemptCap) return result(await fail(id, (c) => failure.retryCapReached(c, item.attempts), list));
    const blocked = failure.preflight(await ctxFor(item.where, list));
    if (blocked) return result(await fail(id, () => blocked, list));
    const unprompted = isUnprompted(item);
    let outcome: StartOutcome;
    try {
      outcome = await machines.start({
        itemId: item.id,
        machineId: item.where.machineId,
        harness: item.where.harness,
        brief: buildBrief(item),
        readOnly: unprompted,
        gateOrigin: unprompted ? 'unprompted' : 'task',
        forbidTools: FORBIDDEN_TOOLS,
        key: `${item.id}:${item.attempts + 1}`,
      });
    } catch (e) {
      outcome = { ok: false, code: START_CODE.machineOffline, message: e instanceof Error ? e.message : String(e) };
    }
    if (!outcome.ok) {
      const refusal = outcome;
      return result(await fail(id, (c) => failure.fromRefusal(refusal, c), list));
    }
    const sessionId = outcome.sessionId;
    // the machine passed its check a moment ago, so it is listed
    const machineName = (list.find((m) => m.machineId === item.where.machineId) as { name: string }).name;
    let applied = false;
    const started = await store
      .update(id, (cur) => {
        // the task was stopped, reset or changed while the Host was starting the session: the session is not ours to keep
        applied = cur.state === item.state && cur.where.sessionId === item.where.sessionId;
        return !applied
          ? null
          : fresh(cur, {
              state: 'working',
              where: { ...cur.where, sessionId, machineName },
              attempts: cur.attempts + 1,
              startedAt: clock.now(),
              progress: null,
              cardId: null,
              result: null,
              lastError: null,
            });
      })
      .catch(async (error: unknown) => {
        // the lease was lost (or the ledger could not be written) with the session already started: it is not ours to leave running
        early.delete(sessionId);
        await stopStray(item, sessionId);
        throw error;
      });
    if (!applied) {
      early.delete(sessionId);
      await stopStray(item, sessionId);
      return result((await store.get(id)) ?? item);
    }
    // what the session said before its id was recorded, in order
    const said = early.get(sessionId) ?? [];
    early.delete(sessionId);
    for (const event of said) await onEvent(item.where.machineId, sessionId, event);
    return result(said.length ? ((await store.get(id)) as Item) : (started as Item));
  }

  /** Adds to a stopped task's error that its session could not be stopped; a task that has moved on since is left alone. */
  async function noteStopFailure(item: Item, what: string): Promise<void> {
    const c = await ctxFor(item.where);
    const note = ` I couldn't reach ${failure.machineName(c)} to stop ${what}, so it may still be running.`;
    await store.update(item.id, (cur) =>
      cur.state === 'stopped'
        ? fresh(cur, { lastError: { ...(cur.lastError as TaskError), message: (cur.lastError as TaskError).message + note } })
        : null,
    );
  }

  /** A session the Host started for a task that is no longer waiting for it is stopped, so nothing runs that nothing manages. */
  async function stopStray(item: Item, sessionId: string): Promise<void> {
    try {
      await machines.stop(item.where.machineId, sessionId);
    } catch {
      await noteStopFailure(item, 'a session it had just started');
    }
  }

  /** The user's retry or Start again, on the same machine unless `where` says another. Never called by MoMo on its own for a failed or interrupted task. */
  const retry = (id: string, where?: { machineId: string; harness: string }): Promise<StartResult> => start(id, where);

  /** The read-only pass: the brain checks the session's report against done_means. Done only on a clear yes; anything else waits for the user. */
  async function settle(item: Item, text: string): Promise<void> {
    // a report for a task that is not waiting for one (already checked, stopped, failed) is not read: the model is asked only for a report that can settle the task
    const now = await store.get(item.id);
    if (checking.has(item.id) || !now || !(now.state === 'working' || (now.state === 'needs_you' && now.cardId !== null))) return;
    checking.add(item.id);
    try {
      await check(item, text);
    } finally {
      checking.delete(item.id);
    }
    await flushCards();
  }

  async function check(item: Item, text: string): Promise<void> {
    const report = parseReport(text);
    let verdict: ReturnType<typeof parseCheck> = null;
    let why = '';
    try {
      const { prompt, data } = buildCheckPrompt(item, report);
      verdict = parseCheck(await ports.check.ask(prompt, data));
      if (!verdict) why = "I couldn't read the check, so I can't tell whether this is done.";
    } catch {
      why = "I couldn't check this result.";
    }
    const c = await ctxFor(item.where);
    const base: TaskResult = { summary: report.summary, files: report.files, evidence: report.evidence, checked: '', met: false };
    let next: Partial<Item>;
    if (verdict?.met)
      next = { state: 'done', result: { ...base, checked: verdict.checked, met: true }, lastError: null, progress: null, failedWith: null };
    else if (verdict)
      next = {
        state: 'needs_you',
        result: { ...base, summary: `Finished, but not done: ${verdict.reason} ${report.summary}`.slice(0, 600), checked: verdict.checked },
        lastError: null,
        progress: `Finished, but not done: ${verdict.reason}`,
      };
    else next = { state: 'needs_you', result: base, lastError: failure.checkFailed(c, why), progress: why };
    await store.update(item.id, (cur) =>
      cur.state === 'working' || (cur.state === 'needs_you' && cur.cardId !== null) ? settleWith(cur, { ...next, cardId: null }) : null,
    );
  }

  /** One typed event from the task's session, from whichever harness adapter runs it. Events for a stopped, finished or unknown task are ignored: a late event never brings one back. */
  async function onEvent(machineId: string, sessionId: string, event: SessionEvent): Promise<Item | null> {
    const item = await store.bySession(machineId, sessionId);
    if (!item && starting.size) {
      // a start is being recorded: this may be its session, said too early
      const kept = early.get(sessionId) ?? [];
      if (kept.length < MAX_EARLY_EVENTS && (early.size < MAX_EARLY_SESSIONS || early.has(sessionId)))
        early.set(sessionId, [...kept, event]);
      return null;
    }
    if (!item || TERMINAL.has(item.state)) return null;
    const when = (state: TaskState, patch: Partial<Item>) =>
      store.update(item.id, (cur) => (cur.state === state ? fresh(cur, patch) : null));
    switch (event.kind) {
      case 'progress':
        await when('working', { progress: event.line.slice(0, 200) });
        break;
      case 'needs_you':
        // a wait always holds a card marker: it is what keeps the task from being started again, and what lets its report still settle it
        await when('working', { state: 'needs_you', progress: event.line.slice(0, 200), cardId: event.cardId ?? `waiting:${sessionId}` });
        break;
      case 'resumed':
        await store.update(item.id, (cur) =>
          cur.state === 'needs_you' && cur.cardId !== null ? fresh(cur, { state: 'working', cardId: null, progress: null }) : null,
        );
        break;
      case 'finished':
        await settle(item, event.report);
        break;
      case 'failed':
        if (!finishedNotDone(item)) await fail(item.id, (c) => failure.fromSessionFailure(event.signal, event.message, c));
        break;
      case 'lost':
        if (!finishedNotDone(item)) await fail(item.id, (c) => failure.interrupted(c, event.reason));
        break;
    }
    return store.get(item.id);
  }

  /** Stop: the item is marked stopped first, if it is still open (so a late event cannot revive it, and a result that settled meanwhile is kept), then its session is stopped. Files already made are kept. */
  async function stop(id: string): Promise<Item> {
    const item = await store.get(id);
    if (!item) throw new TaskRefusal('unknown_item', 'No such task.');
    if (!OPEN.has(item.state)) throw new TaskRefusal('bad_state', 'This task is not running.');
    const c = await ctxFor(item.where);
    const error = failure.stoppedByUser(c);
    let applied = false;
    const stopped = (await store.update(id, (cur) => {
      applied = OPEN.has(cur.state);
      return applied
        ? fresh(cur, { state: 'stopped', lastError: error, progress: null, cardId: null, nextCheck: null, notice: null })
        : null;
    })) as Item;
    if (!applied || !stopped.where.sessionId) return stopped;
    try {
      await machines.stop(stopped.where.machineId, stopped.where.sessionId);
    } catch {
      await noteStopFailure(stopped, 'its session');
    }
    return (await store.get(id)) as Item;
  }

  /**
   * After a restart of the home: each task that was running is asked about its session. Still running: kept. Finished while MoMo was away: checked
   * now. Gone: marked interrupted. A task that never got a session is interrupted too. Nothing is started again; Start again asks first.
   */
  async function recover(): Promise<{ running: number; asleep: number; finished: number; interrupted: number }> {
    const count = { running: 0, asleep: 0, finished: 0, interrupted: 0 };
    for (const item of await store.list()) {
      const waiting = item.state === 'needs_you' && item.cardId !== null;
      if ((item.state !== 'working' && !waiting) || item.watch) continue;
      const { machineId, sessionId } = item.where;
      if (!sessionId) {
        await fail(item.id, (c) => failure.interrupted(c, 'never_started'));
        count.interrupted++;
        continue;
      }
      const probe = await machines.probe(machineId, sessionId).catch((): { state: 'unreachable' } => ({ state: 'unreachable' }));
      if (probe.state === 'running') count.running++;
      else if (probe.state === 'finished') {
        await settle(item, probe.report);
        count.finished++;
      } else if (probe.state === 'ended') {
        // it ended while MoMo was not looking, and the machine kept how: read as if it had been seen
        await onEvent(machineId, sessionId, probe.event);
        if (probe.event.kind === 'finished') count.finished++;
        else count.interrupted++;
      } else if (probe.state === 'gone') {
        await fail(item.id, (c) => failure.interrupted(c, 'session_gone'));
        count.interrupted++;
      } else {
        const c = await ctxFor(item.where);
        await store.update(item.id, (cur) =>
          cur.state === item.state
            ? fresh(cur, {
                progress: `${failure.machineName(c)} is asleep or offline. This keeps running there. The result shows when it is back.`,
              })
            : null,
        );
        count.asleep++;
      }
    }
    return count;
  }

  /** Reset MoMo: running sessions are stopped first, so nothing keeps working with no record of it; then every task is deleted. */
  async function reset(): Promise<{ stopped: number; unreachable: number }> {
    const out = { stopped: 0, unreachable: 0 };
    for (const item of await store.list()) {
      if (!item.where.sessionId || (item.state !== 'working' && item.state !== 'needs_you')) continue;
      try {
        await machines.stop(item.where.machineId, item.where.sessionId);
        out.stopped++;
      } catch {
        out.unreachable++;
      }
    }
    await store.reset();
    return out;
  }

  return { create, start, retry, onEvent, stop, recover, reset };
}
