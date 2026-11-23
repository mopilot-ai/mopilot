// The cloud launcher (Remote Run C1): holds a provider's key (cloudKeys.cjs), mints the one-time join command with a boot of its own for each machine, calls the adapter's `create` with it, and allows the join itself, only for the machine it just made and only while its provider id is the one it is waiting for. A creation that fails or is cancelled deletes what it made; an intent file lets the next launch delete a machine the app quit in the middle of making. The key never leaves this process: the adapter gets a signer, a Host gets only the command.
const crypto = require('node:crypto');
const path = require('node:path');
const { clock } = require('../platform/ports/clock.cjs');
const { fs } = require('../platform/ports/fs.cjs');
const { readStoreFile, writeAtomic } = require('../platform/fsutil.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { adapterProblem, whyOff } = require('../../shared/cloud/adapter.mjs');

/** How long a machine may take to answer the relay after `create`, and how often its state is read meanwhile. */
const CONNECT_MS = 600_000;
const POLL_MS = 3000;
/** The steps the sheet shows, in order. */
const STEPS = Object.freeze(['create', 'start', 'connect', 'pair']);

/** A refusal the sheet shows as it is. @param {string} code @param {string} message */
const refusal = (code, message) => Object.assign(new Error(message), { code });
/** @param {any} error */
const wording = (error) => (error instanceof Error && error.message ? error.message : 'The provider could not do that.');

/**
 * @param {object} o
 * @param {string} o.file where unfinished creations are kept (the user data dir)
 * @param {{ get(provider: string): Record<string, unknown> | null, has(provider: string): boolean }} o.keys
 * @param {(provider: string, credential: Record<string, unknown>, region: string) => import('../../shared/cloud/adapter.mjs').CloudAdapter} o.makeAdapter builds the provider's adapter with this process's signer
 * @param {(o: { onView: (view: any) => void }) => { start(): Promise<any>, view(): any, allow(extra?: object): { id: string }, deny(): void }} o.makeBoot a boot for one machine
 * @param {(step: { launch: string, step: string, state: 'running' | 'done' | 'failed', error?: string }) => void} [o.onStep]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 */
function createCloudLauncher({
  file,
  keys,
  makeAdapter,
  makeBoot,
  onStep = () => undefined,
  sleep = (ms) => new Promise((r) => clock.setTimeout(r, ms)),
}) {
  /** Creations not yet joined: by launch id. @type {Map<string, { provider: string, region: string, name: string, providerId: string, attempted: boolean, cancelled: boolean, wake: () => void }>} */
  const live = new Map();

  const readIntents = () => {
    const { data } = readStoreFile(file, 'the cloud launches', (d) => !!d && typeof d === 'object' && Array.isArray(d.intents));
    return /** @type {{ launch: string, provider: string, region: string, name: string, providerId: string }[]} */ (data?.intents ?? []);
  };
  /** @param {(list: ReturnType<typeof readIntents>) => ReturnType<typeof readIntents>} edit */
  const editIntents = (edit) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeAtomic(file, `${JSON.stringify({ intents: edit(readIntents()) })}\n`);
  };

  /** @param {string} provider @param {string} region */
  function adapterFor(provider, region) {
    const credential = keys.get(provider);
    if (!credential) throw refusal('no_key', 'Add this provider’s key first.');
    const adapter = makeAdapter(provider, credential, region);
    const problem = adapterProblem(adapter);
    if (problem) throw refusal('invalid', problem);
    return adapter;
  }

  /** Delete what a creation made, by id or by name when its answer was never seen; true when nothing is left. @param {any} adapter @param {{ providerId: string, name: string }} made */
  async function remove(adapter, made) {
    try {
      const id = made.providerId || (await adapter.find(made.name));
      if (id) await adapter.destroy(id);
      return true;
    } catch (error) {
      noteIgnored('delete a cloud machine that was not finished', error);
      return false;
    }
  }

  return {
    /** Whether a key is kept for `provider`. @param {string} provider */
    hasKey: (provider) => keys.has(provider),
    /** What the sheet offers for `provider`: sizes (with the provider's own price where it has one), regions and flags. @param {string} provider @param {string} region */
    async options(provider, region) {
      const adapter = adapterFor(provider, region);
      /** @type {Record<string, string>} */
      const reasons = {};
      for (const flag of Object.keys(adapter.flags)) {
        const why = whyOff(adapter, flag);
        if (why) reasons[flag] = why;
      }
      return {
        flags: adapter.flags,
        reasons,
        sizes: await adapter.sizes(),
        regions: await adapter.regions(),
      };
    },
    /** Whether the key is accepted: one read call; the answer never carries the key. @param {string} provider @param {string} region */
    async check(provider, region) {
      try {
        await adapterFor(provider, region).regions();
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          code: /** @type {any} */ (error).code ?? 'failed',
          message: wording(error),
        };
      }
    },
    /**
     * Make a machine and join it with nobody pressing Allow. Resolves the new row's id; on any failure what was made is deleted and the error says why.
     * @param {{ launch: string, provider: string, name: string, size: string, region: string, network?: 'full' | 'limited', idleMinutes?: number, hoursPerDay?: number }} spec
     */
    async launch(spec) {
      if (live.has(spec.launch)) throw refusal('busy', 'That machine is already being made.');
      const adapter = adapterFor(spec.provider, spec.region);
      // a name of its own, so deleting by name after a lost answer can never take another machine
      const providerName = `${spec.name}-${spec.launch.replace(/^l_/, '').slice(0, 6)}`;
      const entry = {
        provider: spec.provider,
        region: spec.region,
        name: providerName,
        attempted: false,
        providerId: '',
        cancelled: false,
        wake: /** @type {() => void} */ (() => undefined),
      };
      live.set(spec.launch, entry);
      /** @param {string} step @param {'running' | 'done' | 'failed'} state @param {string} [error] */
      const note = (step, state, error) =>
        onStep({
          launch: spec.launch,
          step,
          state,
          ...(error ? { error } : {}),
        });
      /** @type {any} */
      let view = null;
      const boot = makeBoot({
        onView: (v) => {
          view = v;
          entry.wake();
        },
      });
      let step = 'create';
      try {
        note('create', 'running');
        // size and place come from the adapter, and Limited only where it can be applied: nothing is made otherwise
        if (spec.network === 'limited' && !adapter.flags.limitedNetwork)
          throw refusal('network_unavailable', String(whyOff(adapter, 'limitedNetwork')));
        if (!(await adapter.sizes()).some((z) => z.id === spec.size)) throw refusal('invalid', 'That size is not offered here.');
        if (!(await adapter.regions()).some((r) => r.id === spec.region)) throw refusal('invalid', 'That region is not offered here.');
        const first = await boot.start();
        view = first;
        if (!first.command) throw refusal('relay', first.error || 'MoPilot could not reach its relay. Check the connection and try again.');
        editIntents((l) => [
          ...l.filter((i) => i.launch !== spec.launch),
          {
            launch: spec.launch,
            provider: spec.provider,
            region: spec.region,
            name: providerName,
            providerId: '',
          },
        ]);
        entry.attempted = true;
        const made = await adapter.create({
          name: providerName,
          size: spec.size,
          region: spec.region,
          command: first.command,
          network: spec.network ?? 'full',
        });
        entry.providerId = made.id;
        editIntents((l) => l.map((i) => (i.launch === spec.launch ? { ...i, providerId: made.id } : i)));
        note('create', 'done');
        if (entry.cancelled) throw refusal('cancelled', 'Cancelled.');

        step = 'start';
        note('start', 'running');
        for (;;) {
          const state = await adapter.status(entry.providerId);
          if (entry.cancelled) throw refusal('cancelled', 'Cancelled.');
          if (state === 'gone') throw refusal('gone', 'The machine was deleted at the provider.');
          if (state === 'running') break;
          await sleep(POLL_MS);
        }
        note('start', 'done');

        step = 'connect';
        note('connect', 'running');
        const until = clock.now() + CONNECT_MS;
        while (view?.state !== 'asking') {
          if (entry.cancelled) throw refusal('cancelled', 'Cancelled.');
          if (view?.state === 'expired' || view?.state === 'denied' || view?.state === 'failed' || clock.now() >= until)
            throw refusal('timeout', 'The machine did not connect.');
          await new Promise((resolve) => {
            entry.wake = () => resolve(undefined);
            clock.setTimeout(resolve, POLL_MS);
          });
        }
        note('connect', 'done');

        step = 'pair';
        note('pair', 'running');
        // the join is allowed only for the machine this launch made: the boot is this launch's own, and the provider still has the id it is waiting for
        if ((await adapter.status(entry.providerId)) === 'gone' || entry.cancelled)
          throw refusal('gone', 'The machine is gone, so it was not allowed to join.');
        const { id } = boot.allow({
          name: spec.name,
          cloud: {
            provider: spec.provider,
            id: entry.providerId,
            region: spec.region,
            size: spec.size,
            network: spec.network ?? 'full',
            ...(spec.idleMinutes === undefined ? {} : { idleMinutes: spec.idleMinutes }),
            ...(spec.hoursPerDay === undefined ? {} : { hoursPerDay: spec.hoursPerDay }),
          },
        });
        editIntents((l) => l.filter((i) => i.launch !== spec.launch));
        note('pair', 'done');
        live.delete(spec.launch);
        return { id, providerId: entry.providerId };
      } catch (error) {
        // what was made goes, and whatever fails while cleaning up never hides why the launch failed
        try {
          note(step, 'failed', wording(error));
          boot.deny();
          if (!entry.attempted || (await remove(adapter, entry))) editIntents((l) => l.filter((i) => i.launch !== spec.launch));
        } catch (cleanup) {
          noteIgnored('clean up a cloud launch', cleanup);
        }
        live.delete(spec.launch);
        throw error;
      }
    },
    /** Cancel a creation under way: it stops at its next step and deletes what it made. @param {string} launch */
    cancel(launch) {
      const entry = live.get(launch);
      if (!entry) return false;
      entry.cancelled = true;
      entry.wake();
      return true;
    },
    /** At app start: delete the machines of creations the app quit in the middle of (their one-time code ended with the app). Resolves how many were deleted. */
    async recover() {
      let deleted = 0;
      for (const intent of readIntents()) {
        if (live.has(intent.launch)) continue;
        let adapter;
        try {
          adapter = adapterFor(intent.provider, intent.region);
        } catch (error) {
          noteIgnored('read a cloud launch left over', error);
          continue;
        }
        if (await remove(adapter, intent)) {
          editIntents((l) => l.filter((i) => i.launch !== intent.launch));
          deleted++;
        }
      }
      return deleted;
    },
  };
}

module.exports = {
  createCloudLauncher,
  CONNECT_MS,
  POLL_MS,
  STEPS,
  newLaunchId: () => `l_${crypto.randomBytes(8).toString('hex')}`,
};
