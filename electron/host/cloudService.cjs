// The cloud machines service of the Mac app (Remote Run X6): the provider key (cloudKeys.cjs), the launcher, wake and the gone checks composed over the registry, and what the sheet and the machine page read and call. Every call is refused while `host.cloud` is off. The provider key is read here only to make the signer of a request; no call returns it.
const crypto = require('node:crypto');
const path = require('node:path');
const { createOciAdapter } = require('../../shared/cloud/oci.mjs');
const { cloudLine, idleWords } = require('../../shared/cloud/cloudLine.mjs');
const { createCloudKeys } = require('./cloudKeys.cjs');
const { createCloudLauncher, newLaunchId } = require('./cloudLauncher.cjs');
const { createCloudWake } = require('./cloudWake.cjs');
const { createCloudGone } = require('./cloudGone.cjs');

/** The providers the sheet offers, and the fields of the key each takes. */
const PROVIDERS = Object.freeze([
  { id: 'oci', label: 'Oracle Cloud', fields: ['tenancy', 'user', 'fingerprint', 'region', 'compartmentId', 'subnetId'] },
]);
const PEM = /^-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----\s*$/;

/** @param {string} code @param {string} message */
const refusal = (code, message) => Object.assign(new Error(message), { code });

/** The signer of an OCI request: RSA-SHA256 over the string with the key, base64. The key stays inside this closure. @param {string} pem */
const ociSigner = (pem) => (/** @type {string} */ text) => crypto.createSign('RSA-SHA256').update(text).sign(pem, 'base64');

/**
 * @param {object} o
 * @param {string} o.dir the user data dir
 * @param {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string }} o.safeStorage
 * @param {() => boolean} o.enabled `host.cloud`
 * @param {{ list: () => any[] }} o.registry
 * @param {(o: { onView: (view: any) => void }) => any} o.makeBoot a boot for one machine (machineBoot.cjs)
 * @param {(hostId: string) => { chatId: string, title: string, folder: string | null }[]} o.chatsOn
 * @param {(hostId: string, chatId: string) => Promise<void>} [o.carry]
 * @param {(hostId: string) => Promise<unknown> | unknown} [o.check] asks the registry to look at a machine now
 * @param {(event: { kind: string, [k: string]: unknown }) => void} [o.onEvent] a step, a wake state or a gone change, for the window
 * @param {typeof fetch} [o.fetch]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 */
function createCloudService({
  dir,
  safeStorage,
  enabled,
  registry,
  makeBoot,
  chatsOn,
  carry,
  check,
  onEvent = () => undefined,
  fetch: doFetch = globalThis.fetch,
  sleep,
}) {
  const keys = createCloudKeys({ file: path.join(dir, 'host-cloud-keys.json'), safeStorage });
  /** @param {string} provider @param {Record<string, any>} credential @param {string} region */
  const makeAdapter = (provider, credential, region) => {
    if (provider !== 'oci') throw refusal('invalid', 'That provider is not known.');
    const { privateKeyPem, ...config } = credential;
    return createOciAdapter({
      config: /** @type {any} */ ({ ...config, region: region || config.region }),
      fetch: doFetch,
      sign: ociSigner(String(privateKeyPem)),
    });
  };
  /** @param {string} provider @param {string} region */
  const adapterOf = (provider, region) => {
    const credential = keys.get(provider);
    if (!credential) throw refusal('no_key', 'Add this provider’s key first.');
    return makeAdapter(provider, credential, region);
  };
  const rowOf = (/** @type {string} */ id) => registry.list().find((r) => r.id === id);
  /** @type {Map<string, string>} */
  const waking = new Map();
  const launcher = createCloudLauncher({
    file: path.join(dir, 'host-cloud-launches.json'),
    keys,
    makeAdapter,
    makeBoot,
    sleep,
    onStep: (e) => {
      onEvent({ kind: 'step', ...e });
    },
  });
  const wake = createCloudWake({
    rowOf,
    adapterOf,
    check,
    sleep,
    onState: (hostId, s) => {
      if (s.state === 'waking') waking.set(hostId, 'waking');
      else waking.delete(hostId);
      // the provider's answer is read again, so a machine that woke no longer reads Asleep
      if (s.state === 'online') void gone.check(hostId);
      onEvent({ kind: 'wake', hostId, ...s });
    },
  });
  const gone = createCloudGone({ rowOf, adapterOf, chatsOn, carry, onChange: () => onEvent({ kind: 'gone' }) });

  /** Refuses while the flag is off. */
  const on = () => {
    if (!enabled()) throw refusal('not_enabled', 'Cloud machines are not available yet.');
  };

  return {
    wake: (/** @type {string} */ hostId) => (enabled() ? wake.wake(hostId) : Promise.resolve({ state: 'off' })),
    lostCheck: (/** @type {string} */ hostId) => gone.lostCheck(hostId),
    /** What the sheet's first step shows: the providers, and whether a key is kept for each. */
    providers() {
      on();
      return PROVIDERS.map((p) => ({ id: p.id, label: p.label, fields: p.fields, hasKey: keys.has(p.id) }));
    },
    /** Keep a provider's key: the identifiers and the private key. Never returns it. @param {string} provider @param {unknown} credential */
    setKey(provider, credential) {
      on();
      const def = PROVIDERS.find((p) => p.id === provider);
      const c = /** @type {Record<string, unknown>} */ (credential && typeof credential === 'object' ? credential : {});
      if (!def) throw refusal('invalid', 'That provider is not known.');
      for (const field of def.fields)
        if (typeof c[field] !== 'string' || !String(c[field]).trim()) throw refusal('invalid', `The ${field} is missing.`);
      if (typeof c.privateKeyPem !== 'string' || !PEM.test(c.privateKeyPem)) throw refusal('invalid', 'The private key is not a PEM key.');
      keys.set(provider, { ...Object.fromEntries(def.fields.map((f) => [f, String(c[f]).trim()])), privateKeyPem: c.privateKeyPem });
      return { ok: true };
    },
    /** @param {string} provider */
    removeKey(provider) {
      on();
      return keys.remove(provider);
    },
    /** "Checking the key…": one read call. @param {string} provider @param {string} [region] */
    check: (provider, region = '') => (on(), launcher.check(provider, region)),
    /** @param {string} provider @param {string} [region] */
    options: (provider, region = '') => (on(), launcher.options(provider, region)),
    /** Starts a creation; resolves when it ends (the window follows its steps through the events). @param {{ provider: string, name: string, size: string, region: string, network?: 'full' | 'limited' }} spec */
    launch(spec) {
      on();
      const launch = newLaunchId();
      onEvent({ kind: 'launch', launch });
      return launcher.launch({ ...spec, launch });
    },
    /** @param {string} launch */
    cancel: (launch) => launcher.cancel(String(launch)),
    /** Ask the provider about one machine now (the row went offline, or the app started): a stopped machine reads Asleep, a gone one Deleted. @param {string} hostId */
    async refresh(hostId) {
      if (!enabled()) return 'off';
      const answer = await gone.check(hostId);
      onEvent({ kind: 'state', hostId });
      return answer;
    },
    /** At app start: delete what an app that quit mid-creation left, and ask each machine's provider whether it still exists. */
    async recover() {
      if (!enabled()) return 0;
      const deleted = await launcher.recover();
      for (const r of registry.list()) if (r.cloud) await gone.check(r.id);
      onEvent({ kind: 'state' });
      return deleted;
    },
    /** "Stop now": the provider stops the machine, disk kept. @param {string} hostId */
    async stopNow(hostId) {
      on();
      const cloud = rowOf(hostId)?.cloud;
      if (!cloud) throw refusal('not_cloud', 'That is not a cloud machine.');
      await adapterOf(cloud.provider, cloud.region).stop(cloud.id);
      return { ok: true };
    },
    /** What Delete names first. @param {string} hostId */
    plan: (hostId) => (on(), gone.plan(hostId)),
    /** @param {string} hostId @param {{ token: string, carry?: string[] }} o */
    remove: (hostId, o) => (on(), gone.remove(hostId, o ?? { token: '' })),
    /**
     * The line of a cloud machine, or null when it is not one. `line` is empty when none of the cloud states applies and the ordinary line shows; `idle` says how long an online machine may idle ("Stops when idle · 30 min").
     * @param {string} hostId
     */
    line(hostId) {
      const row = rowOf(hostId);
      if (!row?.cloud || !enabled()) return null;
      const state = cloudLine({
        gone: gone.isGone(hostId),
        waking: waking.has(hostId),
        asleep: row.status !== 'online' && gone.stateOf(hostId) === 'stopped',
        stopping: row.cloudState?.stopping === true,
        canWake: keys.has(row.cloud.provider),
      });
      const idle = row.status === 'online' ? idleWords(row.cloudState?.idleMinutes ?? row.cloud.idleMinutes) : undefined;
      if (!state && !idle) return null;
      return { ...(state ?? { line: '', dot: /** @type {const} */ ('off'), action: null }), ...(idle && { idle }) };
    },
  };
}

module.exports = { createCloudService, PROVIDERS, ociSigner };
