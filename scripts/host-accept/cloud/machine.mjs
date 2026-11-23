// The machine of a cloud acceptance run: made through the app's cloud launcher (the real one, with a stand-in boot, boot.mjs), stopped and woken by the app's own adapter and wake code, and read back from the provider's own list.
import { createRequire } from 'node:module';
import { createOciAdapter } from '../../../shared/cloud/oci.mjs';
import { expect, hostUp, until } from '../steps.mjs';
import { NAME, LIMITS } from './limits.mjs';
import { createStandInBoot } from './boot.mjs';

const require = createRequire(import.meta.url);

/** The app's adapter for this run's compartment, in one availability domain. @param {any} cloud @param {string} ad */
export const adapterIn = (cloud, ad) =>
  createOciAdapter({ config: { ...cloud.config, availabilityDomain: ad }, fetch: cloud.deps.fetch, sign: cloud.sign });

/**
 * Make the machine with the app's launcher: one availability domain after the other when one has no capacity, then stop (never a loop). Each attempt first reads the compartment and goes on only if it holds nothing, so the disk it asks for is the only disk there.
 * @param {any} cloud
 */
export async function launchMachine(cloud) {
  const { createCloudLauncher, newLaunchId } = require('../../../electron/host/cloudLauncher.cjs');
  const tried = [];
  for (const ad of cloud.ads) {
    const before = await cloud.readers.look();
    expect(
      before.empty,
      `The compartment holds ${before.live.length} machine(s) and ${before.volumeGb} GB of disk: not launching over them.`,
    );
    const launcher = createCloudLauncher({
      file: cloud.launchesFile,
      // the one key is the run's own: any provider asked for has it
      keys: { get: () => cloud.config, has: Boolean },
      makeAdapter: () => adapterIn(cloud, ad),
      makeBoot: createStandInBoot(cloud),
      onStep: (/** @type {{ step: string, state: string }} */ e) => {
        if (e.step === 'start' && e.state === 'done') cloud.t.running = cloud.deps.now();
      },
      sleep: cloud.deps.sleep,
    });
    cloud.t.create = cloud.deps.now();
    try {
      const made = await launcher.launch({
        launch: newLaunchId(),
        provider: 'oci',
        name: NAME,
        size: LIMITS.size,
        region: cloud.config.region,
        network: 'full',
      });
      cloud.made = { id: made.providerId, ad };
      cloud.t.launched = cloud.deps.now();
      return made;
    } catch (error) {
      // the launcher deleted what it made; only a full domain moves on to the next
      if (/** @type {any} */ (error).code !== 'capacity') {
        if (!cloud.watchError) throw error;
        throw Object.assign(
          new Error(`${/** @type {Error} */ (error).message} (the watch of the machine last said: ${cloud.watchError})`),
          {
            code: /** @type {any} */ (error).code,
          },
        );
      }
      tried.push(ad.split(':').pop());
    }
  }
  throw new Error(`No capacity for ${LIMITS.size} in any availability domain (${tried.join(', ')}): stopping, not retrying.`);
}

/** What "Stop now" does (the adapter's `stop`), then waits until the provider's own list shows the machine stopped. Resolves how long that took. @param {any} cloud */
export async function stopMachine(cloud) {
  const adapter = adapterIn(cloud, cloud.made.ad);
  const started = cloud.deps.now();
  await adapter.stop(cloud.made.id);
  await until(async () => (await adapter.status(cloud.made.id)) === 'stopped', {
    ms: 300_000,
    every: cloud.pollMs,
    what: 'the provider to say the machine is stopped',
  });
  const shown = (await cloud.readers.instances()).find((m) => m.id === cloud.made.id)?.state;
  expect(shown === 'STOPPED', `The provider's list shows the machine as ${shown}, not STOPPED.`);
  return cloud.deps.now() - started;
}

/**
 * What a message to a sleeping machine does: the app's wake (cloudWake.cjs) asks the provider to start it and waits until its Host answers. Resolves how it ended and how long it took.
 * @param {any} cloud @param {any} ctx the steps' context (the Host is looked at through its channel)
 */
export async function wakeMachine(cloud, ctx) {
  const { createCloudWake } = require('../../../electron/host/cloudWake.cjs');
  const adapter = adapterIn(cloud, cloud.made.ad);
  const row = { status: 'offline', cloud: { provider: 'oci', id: cloud.made.id, region: cloud.config.region } };
  /** @type {string[]} */
  const states = [];
  let lastLook = '';
  const wake = createCloudWake({
    rowOf: () => row,
    adapterOf: () => adapter,
    sleep: cloud.deps.sleep,
    now: cloud.deps.now,
    onState: (/** @type {string} */ _id, /** @type {{ state: string }} */ s) => states.push(s.state),
    // the machine may come back on another address; its Host is looked at through the channel, which reads the address each time
    check: async () => {
      const ip = await cloud.readers.address(cloud.made.id);
      if (!ip) return;
      cloud.addr.ip = ip;
      try {
        await hostUp(ctx, '', cloud.deps.lookMs);
        row.status = 'online';
      } catch (error) {
        // not up yet: the wake looks again, and a wake that ends says what the last look found
        lastLook = /** @type {Error} */ (error).message;
      }
    },
  });
  const started = cloud.deps.now();
  const result = await wake.wake('cloud-test');
  return { ...result, states, lastLook, ms: cloud.deps.now() - started, started };
}
