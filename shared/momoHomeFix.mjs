// The fixes the view of MoMo's real home offers (shared/momoHomeReal.mjs `{ kind: 'fix', id }`): look again, send a message that was not sent to this MoMo or delete it, and the owner's one deliberate move, Start fresh (MoMo's home is lost, moved to a machine that does not hold it, or a machine that may hold MoMo cannot be reached), asked first with words that say what it does and then confirmed with the token only the asker was given. It checks itself that it is what the situation allows; the view offering it is not the check.
import { createSteps } from './host/momoHomeClient.mjs';
import { parseFixId } from './momoFixId.mjs';
import { IntentError } from './momoHomeApi.mjs';

/**
 * @param {object} o
 * @param {(force?: boolean) => Promise<import('./momoHomeLook.mjs').Read>} o.read
 * @param {() => void} o.invalidate
 * @param {Map<string, unknown>} o.quiet Hosts that did not answer: asking again clears them
 * @param {ReturnType<typeof import('./momoHomeMail.mjs').createMail>} o.mail
 * @param {ReturnType<typeof import('./momoHomeConfirm.mjs').createConfirmations>} o.confirm
 * @param {() => number} o.now
 * @param {() => import('./momoHomeLook.mjs').HomeNote | null} o.remembered
 * @param {(note: import('./momoHomeLook.mjs').HomeNote | null) => void} o.remember
 * @param {(id: string) => Promise<void>} o.older the owner's choices on an older MoMo (momoHomeOlder.mjs)
 * @param {() => void} o.checkAgain the steps and refusals of the last look are forgotten, so they are run again
 * @param {() => void} o.startedFresh a new home may be made now, above every lease seen
 * @param {() => void} o.dropRows the rows of the old home are not the new one's
 * @returns {(id: string) => Promise<void>}
 */
export function createFixes({
  read,
  invalidate,
  quiet,
  mail,
  confirm,
  now,
  remembered,
  remember,
  checkAgain,
  older,
  startedFresh,
  dropRows,
}) {
  /** The token of a confirming id (`<yes>`, the token, then what it was asked about). @param {string} id */
  const tokenOf = (id) => parseFixId(id)?.fields[0] ?? '';
  /** The fresh start itself: where MoMo lived is forgotten (its messages for the old home are shown as not sent, its sent ones are dropped from this chat) and a new home may be made, above every lease seen. */
  const startOver = async () => {
    remember(null);
    mail.forgetSent();
    dropRows();
    startedFresh();
    invalidate();
    await read(true);
  };
  return async (id) => {
    if (id === 'check-again') {
      quiet.clear();
      checkAgain();
      invalidate();
      await read(true);
      return;
    }
    const parsed = parseFixId(id);
    if (parsed?.kind === 'retry-send') {
      const r = await read(true);
      mail.retry(parsed.fields[0] ?? '', r.home?.status.home.homeId ?? remembered()?.homeId ?? '');
      invalidate();
      return void (await mail.flush((await read(true)).home));
    }
    if (parsed?.kind === 'delete-send') return mail.discard(parsed.fields[0] ?? '');
    if (/^(use|keep|delete)-older!?$/.test(parsed?.kind ?? '')) return older(id);
    const note = remembered();
    // MoMo's home is lost, moved to a machine that holds nothing, or a machine that may hold it cannot be reached: start over, which lets a new home be chosen above every lease seen
    if (id === 'start-fresh' || parsed?.kind === 'start-fresh!') {
      const r = await read(true);
      if (r.home) throw new IntentError('MoMo has a home that answers; nothing is lost.');
      if (!r.lost && !r.decision.offerStartFresh) throw new IntentError('MoMo’s home is not lost: it can still be found.');
      if (id === 'start-fresh') {
        const names = r.unheard.map((m) => m.name).join(' and ') || 'a machine';
        confirm.ask(
          'start-fresh',
          `Start fresh? MoMo starts over with no memory of what it knew on ${note?.name ?? 'its old machine'}, and its notes there are not copied. The old MoMo may still exist on ${names}; it will be retired when it comes back. Messages you sent to the old MoMo are no longer shown here.`,
          'start-fresh!',
          '',
          'Start fresh',
        );
      }
      confirm.consume('start-fresh', tokenOf(id));
      return startOver();
    }
    throw new IntentError('That fix is not offered here any more.');
  };
}

/**
 * The owner's Reclaim: the move runner asks the target first. A move this device did not run (another device did, or the app restarted) is named by the
 * Host's own status, and the machine it went to is found by asking each of the others.
 * @param {{ read: (force?: boolean) => Promise<import('./momoHomeLook.mjs').Read>, runner: { view: () => unknown, reclaim: (which: { moveId?: string, toId?: string }) => Promise<unknown> } }} o
 */
export function reclaimOf({ read, runner }) {
  return async (/** @type {{ moveId?: string, toId?: string }} */ { moveId, toId }) => {
    const r = await read();
    const id = moveId ?? r.home?.status.home.moveId;
    if (toId || runner.view()) return void (await runner.reclaim({ moveId: id, toId: toId || undefined }));
    /** @type {unknown} */
    let last = new IntentError('There is no other machine to ask about the move.');
    for (const m of r.machines.filter((x) => x.id !== r.home?.machine.id)) {
      try {
        await runner.reclaim({ moveId: id, toId: m.id });
        return;
      } catch (error) {
        last = error;
      }
    }
    throw last;
  };
}

/**
 * The owner's choice of the machine MoMo's first home is made on: allowed only when every machine has said it holds none (the shared rules' `offerChoose`), or once
 * after the owner's confirmed Start fresh; the new lease starts above everything this account has seen (the shared `createSteps`, climbed in as many starts as it takes).
 * @param {object} o
 * @param {() => import('./momoHomeView.mjs').MachineRecord[]} o.machines
 * @param {(force?: boolean) => Promise<import('./momoHomeLook.mjs').Read>} o.read
 * @param {() => void} o.invalidate
 * @param {(steps: import('./host/momoHomeClient.mjs').Step[], again?: boolean) => Promise<{ failure: string | null }>} o.run
 * @param {() => import('./momoHomeLook.mjs').HomeNote | null} o.remembered
 * @param {{ active: () => boolean, use: () => void }} o.fresh whether a confirmed fresh start is waiting, and using it up
 */
export function createChooseHome({ machines, read, invalidate, run, remembered, fresh }) {
  return async (/** @type {{ machineId: string }} */ { machineId }) => {
    const m = fitHome(machines(), machineId);
    invalidate();
    const r = await read(true);
    // MoMo has one home: one that is running, remembered, seen before, moved away, kept older or that may live on a machine that did not answer is not made again
    // beside it; only the owner's confirmed "Start fresh" lets a new one be made
    if (r.home) throw new IntentError(`MoMo already lives on ${r.home.machine.name}.`);
    const kept = r.older.find((o) => o.machine.id === m.id);
    if (kept) throw new IntentError(`${m.name} still has an older MoMo. Use it or delete it first.`);
    const note = remembered();
    if (!fresh.active()) {
      if (note) throw new IntentError(`MoMo already has a home${note.name ? `, ${note.name}` : ''}. If it is lost, you can start fresh.`);
      if (r.tombstone) throw new IntentError(`MoMo moved to ${r.tombstone.movedTo?.name ?? 'another machine'}.`);
      if (r.older.length > 0) throw new IntentError(`${r.older[0]?.machine.name} still has an older MoMo. Use it or delete it first.`);
      if (!r.decision.offerChoose) {
        const silent = r.unheard.map((x) => x.name);
        throw new IntentError(`${silent.join(' and ')} did not answer, and MoMo may live there. Try again when it is back.`);
      }
    }
    // used once: a fresh start lets exactly one home be made, above every lease this account has seen
    fresh.use();
    // what was asked of the machine is asked again after the look: it may have changed meanwhile
    fitHome(machines(), machineId);
    const done = await run(createSteps(r.decision, { id: m.id, name: m.name }), true);
    if (done.failure) {
      invalidate();
      await read(true);
      throw new IntentError(done.failure);
    }
    invalidate();
    await read(true);
  };
}

/**
 * The machine MoMo may live on or move to: in the list, set up, answering and up to date. The picker and the Move row offer only such a machine (its other rows
 * are disabled or offer the update or the set-up instead), and the intent refuses the rest in words, whoever sends it.
 * @param {import('./momoHomeView.mjs').MachineRecord[]} machines @param {string} id
 */
export function fitHome(machines, id) {
  const m = machines.find((x) => x.id === id);
  if (!m) throw new IntentError('That machine is not available.');
  if (!m.setUp || m.hasHost === false) throw new IntentError(`${m.name} isn’t set up for MoMo yet.`);
  if (!m.reachable) throw new IntentError(`${m.name} is not answering.`);
  if (!m.current) throw new IntentError(`${m.name} needs an update before MoMo can live there.`);
  return m;
}

/**
 * What the app does for a machine, each only where the screen offers it: an update for a Host that is out of date, a set-up for one that is not set up, an
 * install for an agent that is not there, a sign-in for one that is there and not signed in.
 * @param {import('./momoHomeView.mjs').MachineRecord[]} machines @param {string} kind @param {{ machineId: string, agent?: string }} intent
 */
export function assertOffered(machines, kind, { machineId, agent }) {
  const m = machines.find((x) => x.id === machineId);
  if (!m) throw new IntentError('That machine is not available.');
  const a = m.agents.find((x) => x.id === agent);
  if (kind === 'update-machine' && m.current) throw new IntentError(`${m.name} is already up to date.`);
  if (kind === 'set-up-machine' && m.setUp) throw new IntentError(`${m.name} is already set up.`);
  if ((kind === 'install-agent' || kind === 'sign-in-agent') && !a) throw new IntentError(`${m.name} has no such agent.`);
  if (kind === 'install-agent' && a?.installed) throw new IntentError(`${a.name} is already installed on ${m.name}.`);
  if (kind === 'sign-in-agent' && !a?.installed) throw new IntentError(`${a?.name} isn’t installed on ${m.name} yet.`);
  if (kind === 'sign-in-agent' && a?.signedIn) throw new IntentError(`${a.name} is already signed in on ${m.name}.`);
}

/**
 * What the app itself does for a machine (an update, a set-up, an install, a sign-in, a wake), each only where the screen offers it; a build without it says so.
 * @param {object} o
 * @param {() => import('./momoHomeView.mjs').MachineRecord[]} o.machines
 * @param {((intent: { kind: string, machineId: string, agent?: string }) => Promise<unknown>) | undefined} o.act
 * @param {() => void} o.invalidate
 * @param {() => Promise<unknown>} o.refresh
 */
export function createMachineAct({ machines, act, invalidate, refresh }) {
  return (/** @type {string} */ kind) => async (/** @type {{ machineId: string, agent?: string }} */ intent) => {
    if (!act) throw new IntentError('MoMo can’t do that from here yet.');
    if (kind !== 'wake') assertOffered(machines(), kind, intent);
    await act({ kind, machineId: intent.machineId, ...(intent.agent === undefined ? {} : { agent: intent.agent }) });
    invalidate();
    await refresh();
  };
}

/**
 * One at a time: what changes where MoMo lives (a choice, a move, a fix) runs after the one before it has ended, so two windows, or a window and a phone, can
 * never both pass the check and both start a home. Each caller still gets its own answer.
 */
export function createSerial() {
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();
  const settled = () => undefined;
  return /** @template {unknown[]} A @template R @param {(...a: A) => Promise<R> | R} fn @returns {(...a: A) => Promise<R>} */ (fn) =>
    (...a) => {
      const run = tail.then(() => fn(...a));
      tail = run.then(settled, settled);
      return run;
    };
}
