// Watching items: a model-free change watch with a next check time ("invoice due today"). A check reads, fingerprints and compares; only a change reaches the user.
import { TaskRefusal, MAX_WORKING, type Core } from './core.ts';
import * as failure from './failure.ts';
import type { CreateInput, Item } from './types.ts';
import {
  assertWatchToolReadOnly,
  compareReading,
  describeWatch,
  nextWatchAt,
  parseWatch,
  WATCH_RETRY_MS,
  WatchRetryError,
  type RoutineWatch,
} from './watch.ts';

/** A new watch takes its first reading a moment from now. */
export const FIRST_CHECK_MS = 2_000;
/** A snooze reaches at most this far. */
export const SNOOZE_MAX_MS = 365 * 24 * 60 * 60 * 1000;

export function createWatching(core: Core) {
  const { store, ports, clock, fresh, fail, flushCards } = core;

  /** Makes a Watching item. Origin and nesting rules are the same as for any task; a tool must be read-only because a check cannot ask for a card. */
  async function createWatch(input: CreateInput & { watch: unknown }): Promise<Item> {
    core.validate(input);
    const parsed = parseWatch(input.watch);
    if ('error' in parsed) throw new TaskRefusal('bad_watch', parsed.error);
    const { watch } = parsed;
    if (watch.kind === 'tool') await readOnlyOrRefuse(watch);
    const item = await core.build(input, 'watching', {
      watch: { watch, state: null, retryAt: null },
      nextCheck: clock.now() + FIRST_CHECK_MS,
    });
    const made = await store.insertOrGet(item, MAX_WORKING);
    return (made as { item: Item }).item;
  }

  async function readOnlyOrRefuse(watch: RoutineWatch): Promise<void> {
    const reader = ports.watches;
    try {
      assertWatchToolReadOnly(watch.tool as string, reader ? await reader.toolIsReadOnly(watch.tool as string) : false);
    } catch (e) {
      throw new TaskRefusal('bad_watch', (e as Error).message);
    }
  }

  /** Reads every watch whose next check is due. Returns what happened, so the home can log it. */
  async function tick(): Promise<{ checked: number; changed: number; failed: number; retrying: number; undelivered: number }> {
    const out = { checked: 0, changed: 0, failed: 0, retrying: 0, undelivered: 0 };
    const reader = ports.watches;
    const now = clock.now();
    for (const due of await store.list()) {
      if (due.state !== 'watching' || !due.watch || due.nextCheck === null || due.nextCheck > now) continue;
      // claim the check first, so a second tick or a crash in the middle never reads twice at once
      let won = false;
      await store.update(due.id, (cur) => {
        won = cur.state === 'watching' && cur.nextCheck === due.nextCheck;
        return won ? fresh(cur, { nextCheck: clock.now() + WATCH_RETRY_MS }) : null;
      });
      if (!won) continue;
      const { watch, state } = due.watch;
      let applied = false;
      try {
        if (!reader) throw new WatchRetryError('no reader');
        if (watch.kind === 'tool') assertWatchToolReadOnly(watch.tool as string, await reader.toolIsReadOnly(watch.tool as string));
        const reading = await reader.read(watch);
        // counted from when the read ended: a slow read does not shorten the wait
        const at = clock.now();
        const outcome = compareReading(state, reading, at);
        out.checked++;
        const detail = outcome.state.detail ?? `${describeWatch(watch)} changed.`;
        await store.update(due.id, (cur) => {
          // stopped while it was being read: nothing is recorded and nobody is told
          applied = cur.state === 'watching';
          return !applied
            ? null
            : fresh(
                cur,
                outcome.changed
                  ? {
                      state: 'needs_you',
                      progress: detail,
                      nextCheck: null,
                      watch: { watch, state: outcome.state, retryAt: null },
                      notice: { itemId: due.id, title: due.title, detail, machineId: due.where.machineId },
                    }
                  : { nextCheck: nextWatchAt(watch, at), watch: { watch, state: outcome.state, retryAt: null } },
              );
        });
        if (applied && outcome.changed) out.changed++;
      } catch (e) {
        if (e instanceof WatchRetryError) {
          out.retrying++;
          const retryAt = clock.now() + WATCH_RETRY_MS;
          await store.update(due.id, (cur) =>
            cur.state === 'watching' ? fresh(cur, { nextCheck: retryAt, watch: { watch, state, retryAt } }) : null,
          );
        } else {
          out.failed++;
          const why = e instanceof Error && e.message ? e.message : 'The check could not run.';
          await fail(due.id, (c) => failure.watchFailed(c, `I stopped watching "${due.title}": ${why}`));
        }
      }
    }
    // a change is told from the record, so a crash between writing it and telling the chat loses nothing; one the chat cannot take is counted
    await flushCards();
    out.undelivered = (await store.list()).filter((i) => i.notice).length;
    return out;
  }

  /** "Keep watching" after a change, or Retry after a failed check: the next check is due now. */
  async function resume(id: string): Promise<Item> {
    const item = await store.get(id);
    if (!item) throw new TaskRefusal('unknown_item', 'No such task.');
    if (!item.watch || (item.state !== 'needs_you' && item.state !== 'failed' && item.state !== 'stopped'))
      throw new TaskRefusal('bad_state', 'This is not a paused watch.');
    return (await store.update(id, (cur) =>
      fresh(cur, { state: 'watching', lastError: null, progress: null, nextCheck: clock.now() + FIRST_CHECK_MS }),
    )) as Item;
  }

  /** The watch is changed only if it is watching at that moment (a change that came in between is not overwritten); otherwise the caller is told why. */
  async function whileWatching(id: string, change: (cur: Item) => Item): Promise<Item> {
    let applied = false;
    const item = (await store.update(id, (cur) => {
      applied = !!cur.watch && cur.state === 'watching';
      return applied ? change(cur) : null;
    })) as Item | null;
    if (applied && item) return item;
    throw item ? new TaskRefusal('bad_state', 'This is not being watched now.') : new TaskRefusal('unknown_item', 'No such task.');
  }

  /** "Check now" on a watch that is watching: its next check is due now, and the round that reads due watches runs. */
  async function checkNow(id: string): Promise<{ item: Item; round: Awaited<ReturnType<typeof tick>> }> {
    await whileWatching(id, (cur) => fresh(cur, { nextCheck: clock.now() }));
    const round = await tick();
    return { item: (await store.get(id)) as Item, round };
  }

  /** "Snooze" a watch that is watching: its next check is `forMs` from now on this home's clock (at most a year), instead of when it was due. A client sends how long, never a time, so its own clock never matters. */
  async function snooze(id: string, forMs: number): Promise<Item> {
    if (!Number.isFinite(forMs) || forMs <= 0 || forMs > SNOOZE_MAX_MS)
      throw new TaskRefusal('bad_input', 'That is not a time to snooze for.');
    const until = clock.now() + forMs;
    return whileWatching(id, (cur) => fresh(cur, { nextCheck: until }));
  }

  return { createWatch, tick, resume, checkNow, snooze };
}
