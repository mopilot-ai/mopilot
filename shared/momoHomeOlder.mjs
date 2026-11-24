// The older MoMo a newer home replaced (shared/momoHomeReal.mjs): a home that was retired keeps its data and key on its machine, and the owner is told once, with three ways on: keep the one in use, use the older one instead (it starts again above the live home, which then stands down, nothing deleted), or delete it (Reset on that machine, asked first). Nothing here runs by itself: the steps that only fence a home run on their own, a choice of the owner's does not.
import { reviveSteps } from './host/momoHomeClient.mjs';
import { fixId, parseFixId } from './momoFixId.mjs';
import { IntentError } from './momoHomeApi.mjs';
import { fitHome } from './momoHomeFix.mjs';

const when = (/** @type {number} */ at) =>
  at
    ? ` (last active ${new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })})`
    : '';

/** What the owner keeps once told: one entry for each time a machine's home was retired (the winner and the time are in it, so a later retirement is told again). @param {{ machine: { id: string }, movedTo: { homeId: string, at?: number } }} o */
export const olderKey = (o) => `${o.machine.id}:${o.movedTo.homeId}:${o.movedTo.at ?? 0}`;

/**
 * The card for each older MoMo not yet kept: where it is, when it last ran, which one is in use, and (when its start replaced a move) that the move was replaced.
 * @param {import('./momoHomeLook.mjs').Read} r @param {Set<string>} kept @param {Map<string, boolean>} replaced machine ids whose home this device just retired, true when it was mid-move
 */
export function olderProblems(r, kept, replaced) {
  const using = r.home?.machine.name ?? null;
  return r.older
    .filter((o) => !kept.has(olderKey(o)))
    .map((o) => {
      const at = o.machine.name;
      const moved = replaced.get(o.machine.id) && using ? `The move was replaced: MoMo was started again on ${using}. ` : '';
      return {
        id: `older:${o.machine.id}`,
        code: 'older_home',
        cause: `${moved}${using ? `There are two MoMos: the one on ${at}${when(o.lastActive)} and the one on ${using}${when(/** @type {any} */ (r.home).status.home.lastSeenAt)}. You’re using the one on ${using}.` : `There is a MoMo kept on ${at}${when(o.lastActive)}.`} The one on ${at} is retired, with everything it knew kept. Use brings it back and retires the other; Keep leaves it as it is; Delete erases it.`,
        fix: { id: fixId('use-older', o.machine.id), label: `Use the one on ${at}` },
        also: [
          ...(using ? [{ id: fixId('keep-older', o.machine.id), label: 'Keep this one' }] : []),
          { id: fixId('delete-older', o.machine.id), label: 'Delete the old MoMo' },
        ],
        since: null,
      };
    });
}

/**
 * The owner's three choices on an older MoMo. Using it and deleting it are asked first, in words that say what they do, and done only on the repeat that
 * carries the token only the asker was given.
 * @param {object} o
 * @param {(force?: boolean) => Promise<import('./momoHomeLook.mjs').Read>} o.read
 * @param {() => void} o.invalidate
 * @param {ReturnType<typeof import('./momoHomeConfirm.mjs').createConfirmations>} o.confirm
 * @param {{ read: () => string[], write: (kept: string[]) => void }} [o.memory] the older MoMos the owner chose to keep, across runs (they are not told again)
 * @param {(steps: import('./host/momoHomeClient.mjs').Step[], again?: boolean) => Promise<{ failure: string | null }>} o.run
 * @param {(id: string, method: string, params: object) => Promise<unknown>} o.call
 * @param {() => import('./momoHomeView.mjs').MachineRecord[]} o.machines
 */
export function createOlder({ read, invalidate, confirm, memory, run, call, machines }) {
  const kept = new Set(memory?.read() ?? []);
  /** The machines whose home this device retired in this run, and whether it was mid-move. @type {Map<string, boolean>} */
  const replaced = new Map();
  const keep = () => memory?.write([...kept]);
  const fix = async (/** @type {string} */ id) => {
    // `<verb>` and the machine ask; `<verb>!`, the token and the machine confirm (shared/momoFixId.mjs: a machine id has `:` and more in it)
    const { kind, fields } = /** @type {{ kind: string, fields: string[] }} */ (parseFixId(id));
    const confirming = kind.endsWith('!');
    const verb = confirming ? kind.slice(0, -1) : kind;
    const [token = '', rest = ''] = confirming ? fields : ['', fields[0] ?? ''];
    const r = await read(true);
    const o = r.older.find((x) => x.machine.id === rest);
    if (!o) throw new IntentError('That is not offered any more.');
    const at = o.machine.name;
    // taking it back puts MoMo on that machine again: it must be fit for that, now and when it is done
    if (verb === 'use-older') fitHome(machines(), o.machine.id);
    if (verb === 'keep-older') {
      kept.add(olderKey(o));
      keep();
      invalidate();
      await read(true);
      return;
    }
    const key = `${verb}:${rest}`;
    if (!confirming)
      confirm.ask(
        key,
        verb === 'use-older'
          ? `Use the older MoMo on ${at}? It starts again with what it knew${when(o.lastActive)}. What MoMo learned since is not in it.${r.home ? ` The one on ${r.home.machine.name} is kept, not deleted.` : ''}`
          : `Delete the older MoMo on ${at}? This deletes only the older MoMo on ${at}${when(o.lastActive)}, everything it knew, and can’t be undone.${r.home ? ` The MoMo on ${r.home.machine.name} is not affected.` : ''}`,
        `${verb}!`,
        rest,
        verb === 'use-older' ? `Use the one on ${at}` : 'Delete',
        // the epoch the owner SAW: the repeat is judged against that, never against a look made since
        o.leaseEpoch,
      );
    const seenAt = /** @type {number} */ (confirm.consume(key, token));
    if (verb === 'use-older' && seenAt !== o.leaseEpoch) {
      invalidate();
      await read(true);
      throw new IntentError(`The MoMo on ${at} changed since you were asked, so nothing was done. It is looked at again.`);
    }
    if (verb === 'use-older') {
      const steps = reviveSteps(r.decision, { id: o.machine.id, name: at, own: seenAt }, r.live);
      const done = await run(steps, true);
      if (done.failure) throw new IntentError(done.failure);
    } else {
      try {
        // only a copy that is still retired, at the epoch the owner saw, is deleted
        await call(o.machine.id, 'host.momoReset', { ifRetired: true, expectEpoch: seenAt });
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== 'retired_changed') throw error;
        invalidate();
        await read(true);
        throw new IntentError(`The MoMo on ${at} was taken back or changed, so nothing was deleted. It is looked at again.`);
      }
    }
    kept.delete(olderKey(o));
    keep();
    invalidate();
    await read(true);
  };
  return Object.assign(fix, {
    /** A machine that keeps a retired copy of MoMo is not a place to move to (its Host refuses): said before the move begins. @param {import('./momoHomeLook.mjs').Read} r @param {string} toId */
    movable(r, toId) {
      const o = r.older.find((x) => x.machine.id === toId);
      if (o) throw new IntentError(`${o.machine.name} still has an older MoMo. Use it or delete it first.`);
    },
    /** The card for each older MoMo not kept. @param {import('./momoHomeLook.mjs').Read} r */
    problems: (r) => olderProblems(r, kept, replaced),
    /** This device retired these homes just now. @param {{ host: string, moving: boolean }[]} list */
    retired: (list) => list.forEach((x) => replaced.set(x.host, x.moving)),
    /** Reset MoMo: nothing is kept or told. */
    forget() {
      kept.clear();
      replaced.clear();
      keep();
    },
  });
}
