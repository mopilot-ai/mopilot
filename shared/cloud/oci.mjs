// The Oracle Cloud Infrastructure provider (Remote Run C1), written against the request and response shapes in OCI's public API reference (Core 20160918, Identity 20160918, signature version 1) with an injected `fetch` and signer. NOT YET RUN AGAINST THE REAL API: no account was used; the first real run is the acceptance pass.
import { CloudError } from './adapter.mjs';
import { createOciCall } from './ociCall.mjs';

/** The API version path both services use. */
const V = '/20160918';
/** The first shapes offered: Flex shapes take their own CPU and memory, so a size is a shape and a pair. List prices are per OCPU-hour and per GB-hour (to be re-read from Oracle's price list at the acceptance pass). */
const SHAPES = Object.freeze([
  {
    id: 'VM.Standard.A1.Flex',
    label: 'Arm',
    cpu: 0.01,
    gb: 0.0015,
    presets: [
      [1, 6],
      [2, 12],
    ],
  },
  {
    id: 'VM.Standard.E4.Flex',
    label: 'x86',
    cpu: 0.025,
    gb: 0.0015,
    presets: [
      [1, 8],
      [2, 16],
    ],
  },
]);
const round = (n) => Math.round(n * 10000) / 10000;

/** The provider's lifecycle states folded into the four the clients know. */
const STATES = Object.freeze({
  PROVISIONING: 'starting',
  STARTING: 'starting',
  CREATING_IMAGE: 'starting',
  MOVING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopped',
  STOPPED: 'stopped',
  TERMINATING: 'gone',
  TERMINATED: 'gone',
});

/** The size id a client sends: `<shape>:<ocpus>:<gb>`. @param {string} id */
export function parseSize(id) {
  const [shape, ocpus, gb] = String(id).split(':');
  const known = SHAPES.find((s) => s.id === shape);
  const o = Number(ocpus);
  const g = Number(gb);
  if (!known || !Number.isFinite(o) || !Number.isFinite(g) || o <= 0 || g <= 0)
    throw new CloudError('invalid', 'That machine size is not offered.');
  return { shape, ocpus: o, memoryInGBs: g };
}

/** @param {string} text */
const b64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

/**
 * @param {object} o
 * @param {{ tenancy: string, user: string, fingerprint: string, region: string, compartmentId: string, subnetId: string, availabilityDomain?: string, imageId?: string }} o.config the identifiers the owner gives (tenancy, user, compartment, subnet and image OCIDs); none is a secret
 * @param {typeof fetch} o.fetch
 * @param {(signingString: string) => string | Promise<string>} o.sign RSA-SHA256 over the string, base64: the key stays with the caller
 * @param {() => Date} [o.now]
 */
export function createOciAdapter({ config, fetch: doFetch, sign, now = () => new Date() }) {
  const c = config;
  const call = createOciCall({ config: c, fetch: doFetch, sign, now });

  const q = encodeURIComponent;
  const compartment = `compartmentId=${q(c.compartmentId)}`;

  async function availabilityDomain() {
    if (c.availabilityDomain) return c.availabilityDomain;
    const list = await call('GET', 'identity', `${V}/availabilityDomains?${compartment}`);
    const first = Array.isArray(list) ? list[0]?.name : null;
    if (!first) throw new CloudError('failed', 'The provider listed no place to make a machine.');
    return String(first);
  }

  /** @param {string} shape */
  async function image(shape) {
    if (c.imageId) return c.imageId;
    const list = await call(
      'GET',
      'iaas',
      `${V}/images?${compartment}&operatingSystem=${q('Canonical Ubuntu')}&shape=${q(shape)}&sortBy=TIMECREATED&sortOrder=DESC&limit=1`,
    );
    const first = Array.isArray(list) ? list[0]?.id : null;
    if (!first) throw new CloudError('failed', 'The provider has no image for that size.');
    return String(first);
  }

  /** @param {string} id */
  const instance = (id) => `${V}/instances/${q(id)}`;

  /** The machine's state, or `gone`. @param {string} id */
  async function status(id) {
    try {
      const m = await call('GET', 'iaas', instance(id));
      return /** @type {'starting' | 'running' | 'stopped' | 'gone'} */ (STATES[String(m?.lifecycleState)] ?? 'starting');
    } catch (error) {
      if (error instanceof CloudError && error.code === 'gone') return 'gone';
      throw error;
    }
  }

  /** An instance action; a machine already where the action leads counts as done. @param {string} id @param {'START' | 'SOFTSTOP'} action @param {string[]} done */
  async function act(id, action, done) {
    try {
      await call('POST', 'iaas', `${instance(id)}?action=${action}`, {});
    } catch (error) {
      if (error instanceof CloudError && error.code === 'busy' && done.includes(await status(id))) return;
      throw error;
    }
  }

  return {
    id: 'oci',
    /** Stop keeps the boot volume; a stopped machine still bills its disk; the Host halts its own machine. */
    flags: Object.freeze({
      resume: true,
      selfStop: true,
      publicPrice: true,
      stopSavesMoney: true,
      limitedNetwork: false,
    }),
    why: Object.freeze({
      limitedNetwork:
        "OCI's security lists filter by address, not by name, so MoPilot can't limit a machine to the package registries and the Git host. Only Full is available.",
    }),
    status,
    /** @param {{ name: string, size: string, region?: string, command: string }} spec */
    async create(spec) {
      const { shape, ocpus, memoryInGBs } = parseSize(spec.size);
      const body = {
        availabilityDomain: await availabilityDomain(),
        compartmentId: c.compartmentId,
        displayName: spec.name,
        shape,
        shapeConfig: { ocpus, memoryInGBs },
        sourceDetails: {
          sourceType: 'image',
          imageId: await image(shape),
          bootVolumeSizeInGBs: 50,
        },
        createVnicDetails: { subnetId: c.subnetId, assignPublicIp: true },
        metadata: { user_data: b64(`#!/bin/sh\n${spec.command}\n`) },
        freeformTags: { 'mopilot-host': 'true' },
      };
      const made = await call('POST', 'iaas', `${V}/instances`, body);
      if (!made?.id) throw new CloudError('failed', 'The provider did not name the new machine.');
      return { id: String(made.id) };
    },
    /** @param {string} id */
    stop: (id) => act(id, 'SOFTSTOP', ['stopped']),
    /** @param {string} id */
    resume: (id) => act(id, 'START', ['starting', 'running']),
    /** The machine and its disk; already gone is done. @param {string} id */
    async destroy(id) {
      try {
        await call('DELETE', 'iaas', `${instance(id)}?preserveBootVolume=false`);
      } catch (error) {
        if (!(error instanceof CloudError && error.code === 'gone')) throw error;
      }
    },
    /** A machine made under `name` that is not terminated, or null. @param {string} name */
    async find(name) {
      const list = await call('GET', 'iaas', `${V}/instances?${compartment}&displayName=${q(name)}&limit=5`);
      const live = (Array.isArray(list) ? list : []).find((m) => STATES[String(m?.lifecycleState)] !== 'gone');
      return live?.id ? String(live.id) : null;
    },
    async sizes() {
      return SHAPES.flatMap((s) =>
        s.presets.map(([cpus, memoryGb]) => ({
          id: `${s.id}:${cpus}:${memoryGb}`,
          label: `${s.label} · ${cpus} CPU · ${memoryGb} GB`,
          cpus,
          memoryGb,
          pricePerHour: round(cpus * s.cpu + memoryGb * s.gb),
          currency: 'USD',
        })),
      );
    },
    async regions() {
      const list = await call('GET', 'identity', `${V}/regions`);
      return (Array.isArray(list) ? list : []).map((r) => ({
        id: String(r.name),
        label: String(r.name),
      }));
    },
  };
}
