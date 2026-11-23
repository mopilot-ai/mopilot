// Add by command for the user's machines (#2709): the boot (relayBoot.cjs) joined to the machines list. Allow adds the machine's
// record (`relay:<host id>`, no SSH address: the relay is its one path), then, once its service is up, pairs with it through the
// relay with the code it sent and replaces the credential that travelled in the install script with a fresh one (a re-enrollment
// over the encrypted session), so the one on the far machine's screen is worth nothing. A machine that never comes up stays listed,
// as one that went offline does, for the user to remove; the card says so with its cause (`join_failed`) and Try again repeats the join.
const crypto = require('node:crypto');
const { clock } = require('../platform/ports/clock.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { helloParams } = require('../../shared/host/schema.mjs');
const { createRelayBoot } = require('./relayBoot.cjs');

/** How long the new machine's service may take to come up on the relay after Allow, and how often pairing is tried meanwhile. */
const JOIN_MS = 120_000;
const TRY_MS = 3000;
const IDLE = { state: 'idle', command: '', expiresAt: 0, machine: null, error: '' };

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./relayPaths.cjs').createRelayPaths> | null} o.relay
 * @param {{ add: (record: any) => void, list: () => any[] }} o.registry
 * @param {(build: string) => { file: string, sha256: string, version: string } | Promise<{ file: string, sha256: string, version: string }>} o.bundle
 * @param {() => string} o.updateKey this app's update key (base64 SPKI)
 * @param {(id: string, code: string) => Promise<void>} o.pair
 * @param {(record: any) => Promise<{ call: (method: string, params?: object) => Promise<any>, close: () => void }>} o.openPaired
 * @param {(view: any) => void} [o.onView] told how the command stands, at every change
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {typeof createRelayBoot} [o.makeBoot] for tests
 */
function createMachineBoot({
  relay,
  registry,
  bundle,
  updateKey,
  pair,
  openPaired,
  onView = () => undefined,
  sleep = (ms) => new Promise((r) => clock.setTimeout(r, ms)),
  makeBoot = createRelayBoot,
}) {
  /** @type {ReturnType<typeof createRelayBoot> | null} */
  let boot = null;
  /** How the join after Allow stands, laid over the boot's own view: `joining`, `ready` or `join_failed` with its cause. @type {{ state: string, error: string } | null} */
  let overlay = null;
  /** The join that failed, for Try again: what stage it reached, so a pairing that took is not repeated. @type {{ id: string, code: string, name: string, paired: boolean } | null} */
  let failedJoin = null;
  const merged = () => ({ ...(boot?.view ?? IDLE), ...overlay });
  const need = () => {
    if (!relay) throw Object.assign(new Error('This app has no relay to add a machine by command.'), { code: 'no_relay' });
    boot ??= makeBoot({
      lane: relay.lane,
      paths: relay,
      url: relay.url,
      bundle,
      updateKeyPem: () =>
        crypto
          .createPublicKey({ key: Buffer.from(updateKey(), 'base64'), format: 'der', type: 'spki' })
          .export({ type: 'spki', format: 'pem' })
          .toString(),
      onChange: (v) => {
        // the boot's own steps (a new command, Deny, the clock) end what the last join said
        if (v.state !== 'joined') overlay = failedJoin = null;
        onView(merged());
      },
    });
    return boot;
  };

  /** Pairs with the new machine once it is up, then gives it a fresh credential. @param {{ id: string, code: string, paired: boolean }} j */
  async function join(j) {
    const until = clock.now() + JOIN_MS;
    while (!j.paired) {
      try {
        await pair(j.id, j.code);
        j.paired = true;
      } catch (error) {
        if (clock.now() >= until) throw error;
        await sleep(TRY_MS);
      }
    }
    const record = registry.list().find((r) => r.id === j.id);
    if (!record || !relay) return;
    const s = await openPaired(record);
    try {
      await s.call('host.hello', helloParams());
      await relay.enroll(
        record.address,
        (m, p) => s.call(m, p),
        () => registry.list().some((r) => r.id === j.id),
      );
    } finally {
      s.close();
    }
  }

  /** @param {{ state: string, error: string }} next */
  const say = (next) => {
    overlay = next;
    onView(merged());
  };

  /** The background join: the card hears `joining`, then `ready`, or why it failed (one line). @param {{ id: string, code: string, name: string, paired: boolean }} j */
  async function finish(j) {
    failedJoin = null;
    say({ state: 'joining', error: '' });
    try {
      await join(j);
      say({ state: 'ready', error: '' });
    } catch (error) {
      noteIgnored('finish adding a machine by command', error);
      failedJoin = j;
      say({
        state: 'join_failed',
        error: j.paired
          ? `${j.name} was added, but finishing its setup over the relay failed.`
          : `${j.name} was added, but its Host did not start answering within 2 minutes.`,
      });
    }
  }

  return {
    /** How the command stands (idle before any). */
    view: merged,
    /** A new command to show; `retryJoin` instead repeats the join that failed after Allow (the machine stays listed) and answers how it stands. @param {boolean} [retryJoin] */
    start(retryJoin = false) {
      const j = retryJoin ? failedJoin : null;
      if (!j) return need().start();
      void finish(j);
      return Promise.resolve(merged());
    },
    /** The user allowed the machine the card shows: it is listed now and joined in the background. Resolves its id. `extra` is more for its record (the cloud launcher's provider and id). @param {object} [extra] */
    allow(extra = {}) {
      const joined = need().allow();
      const name = /** @type {any} */ (extra).name ?? joined.name;
      registry.add({
        ...extra,
        id: joined.destination,
        name,
        address: joined.destination,
        socketPath: joined.socketPath,
      });
      void finish({ id: joined.destination, code: joined.pairingCode, name, paired: false });
      return { id: joined.destination };
    },
    /** The user did not allow it, or closed the card. */
    deny: () => boot?.deny(),
    /** A boot of its own with the same dependencies, for one machine the app makes itself (the cloud launcher): a join it allows is for its own command only. @param {(view: any) => void} view */
    fork: (view) => createMachineBoot({ relay, registry, bundle, updateKey, pair, openPaired, onView: view, makeBoot }),
    dispose: () => boot?.dispose(),
  };
}

module.exports = { createMachineBoot, JOIN_MS, TRY_MS };
