// Read-only looks at the test compartment, made through the same signed call the OCI adapter uses (shared/cloud/ociCall.mjs): what the run may rely on before it launches, and the proof after it that nothing is left. Every call here is a GET.
const V = '/20160918';
const q = encodeURIComponent;
const list = (/** @type {any} */ x) => (Array.isArray(x) ? x : []);
/** States of a machine or a disk that no longer exists or is going. */
const GONE = new Set(['TERMINATED', 'TERMINATING']);
const sum = (/** @type {number[]} */ ns) => ns.reduce((a, b) => a + b, 0);

/**
 * @param {object} o
 * @param {(method: string, service: 'iaas' | 'identity', path: string, body?: any) => Promise<any>} o.call
 * @param {{ compartmentId: string }} o.config
 */
export function createReaders({ call, config }) {
  const comp = `compartmentId=${q(config.compartmentId)}`;
  const get = (/** @type {'iaas' | 'identity'} */ service, /** @type {string} */ p) => call('GET', service, `${V}${p}`);
  const readers = {
    /** The regions the key may list (the cheapest call that needs a valid signature). */
    regions: async () => list(await get('identity', '/regions')).map((r) => String(r.name)),
    domains: async () => list(await get('identity', `/availabilityDomains?${comp}`)).map((d) => String(d.name)),
    /** Instances in the compartment, terminated ones included (they stay listed for a while). */
    instances: async () =>
      list(await get('iaas', `/instances?${comp}&limit=100`)).map((m) => ({
        id: String(m.id),
        name: String(m.displayName),
        state: String(m.lifecycleState),
      })),
    /** @param {string} ad */
    bootVolumes: async (ad) =>
      list(await get('iaas', `/bootVolumes?availabilityDomain=${q(ad)}&${comp}&limit=100`)).map((v) => ({
        id: String(v.id),
        state: String(v.lifecycleState),
        gb: Number(v.sizeInGBs),
        kind: /** @type {'boot' | 'block'} */ ('boot'),
      })),
    volumes: async () =>
      list(await get('iaas', `/volumes?${comp}&limit=100`)).map((v) => ({
        id: String(v.id),
        state: String(v.lifecycleState),
        gb: Number(v.sizeInGBs),
        kind: /** @type {'boot' | 'block'} */ ('block'),
      })),
    /** The public address of a machine's first attached network card, or null. @param {string} instanceId */
    async address(instanceId) {
      const attached = list(await get('iaas', `/vnicAttachments?${comp}&instanceId=${q(instanceId)}`)).find(
        (a) => a.lifecycleState === 'ATTACHED',
      );
      if (!attached?.vnicId) return null;
      const vnic = await get('iaas', `/vnics/${q(String(attached.vnicId))}`);
      return vnic?.publicIp ? String(vnic.publicIp) : null;
    },
    /** The image the adapter's `create` would pick for a shape (the same query). @param {string} shape */
    async image(shape) {
      const [first] = list(
        await get(
          'iaas',
          `/images?${comp}&operatingSystem=${q('Canonical Ubuntu')}&shape=${q(shape)}&sortBy=TIMECREATED&sortOrder=DESC&limit=1`,
        ),
      );
      return first ? { id: String(first.id), name: String(first.displayName) } : null;
    },
    /** @param {string} ad */
    shapes: async (ad) => list(await get('iaas', `/shapes?${comp}&availabilityDomain=${q(ad)}&limit=100`)).map((s) => String(s.shape)),
    /** @param {string} id */
    async subnet(id) {
      const s = await get('iaas', `/subnets/${q(id)}`);
      return {
        state: String(s?.lifecycleState),
        cidr: String(s?.cidrBlock),
        isPublic: s?.prohibitPublicIpOnVnic === false,
        securityListIds: list(s?.securityListIds).map(String),
        routeTableId: String(s?.routeTableId ?? ''),
      };
    },
    /** What a security list lets in on SSH and out at all. @param {string} id */
    async securityList(id) {
      const l = await get('iaas', `/securityLists/${q(id)}`);
      const ingress = list(l?.ingressSecurityRules);
      const open = (/** @type {string} */ cidr) => cidr === '0.0.0.0/0';
      return {
        sshIn: ingress.some((r) => {
          if (!open(r.source)) return false;
          if (r.protocol === 'all') return true;
          const range = r.tcpOptions?.destinationPortRange;
          return r.protocol === '6' && (!r.tcpOptions || !range || (range.min <= 22 && range.max >= 22));
        }),
        egressOut: list(l?.egressSecurityRules).some((r) => open(r.destination) && (r.protocol === 'all' || r.protocol === '6')),
      };
    },
    /** @param {string} id */
    async internetRoute(id) {
      const t = await get('iaas', `/routeTables/${q(id)}`);
      return list(t?.routeRules).some((r) => r.destination === '0.0.0.0/0' && String(r.networkEntityId).includes('internetgateway'));
    },
    /** Everything in the compartment that costs a place or a disk: the live machines, the disks and their sizes. */
    async look() {
      const ads = await readers.domains();
      const instances = await readers.instances();
      const boots = [];
      for (const ad of ads) boots.push(...(await readers.bootVolumes(ad)));
      const volumes = [...boots, ...(await readers.volumes())].filter((v) => !GONE.has(v.state));
      const live = instances.filter((m) => !GONE.has(m.state));
      return { ads, instances, live, volumes, volumeGb: sum(volumes.map((v) => v.gb)), empty: live.length === 0 && volumes.length === 0 };
    },
  };
  return readers;
}
