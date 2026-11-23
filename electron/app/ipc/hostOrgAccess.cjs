// IPC for organization access (#3361 Tier 2), registered by ipc/host.cjs (`registeredBy`): the admin's settings, the person's sign-in through the system browser and its sign-out, each answered as a view that never carries a token (electron/host/orgAccess/service.cjs). A sign-in lets go of the messages that waited for it; a change redraws every window's machines.
const path = require('node:path');
const { createOrgAccess } = require('../../host/orgAccess/service.cjs');
const { createOidcClient } = require('../../host/orgAccess/oidc.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { managedPolicy, managedOrgAccess } = require('../../platform/managedPolicy.cjs');

/**
 * The service, made on first use (only once the Host gate is open), and its channels.
 * @param {object} o
 * @param {(channel: string, fn: (...args: any[]) => unknown) => void} o.handle the Host IPC's own handler (gate, error shape)
 * @param {() => string} o.userData
 * @param {() => any} o.safeStorage the encryption it seals the lease with, read only when the service is made (a closed gate never loads Electron's)
 * @param {(url: string) => unknown} o.openExternal
 * @param {(channel: string, payload: unknown) => void} o.broadcast
 * @param {() => { orgSignedIn: () => Promise<void> } | null} o.remote the messages to machines (remoteSend.cjs)
 * @param {typeof createOrgAccess} [o.create]
 */
function registerOrgAccess({ handle, userData, safeStorage, openExternal, broadcast, remote, create = createOrgAccess }) {
  /** @type {ReturnType<typeof createOrgAccess> | null} */
  let service = null;
  /** @type {(() => void) | null} stops following the managed policy */
  let unfollow = null;
  const org = () => {
    if (service) return service;
    const made = create({
      file: path.join(userData(), 'host-org-access.json'),
      safeStorage: safeStorage(),
      oidc: createOidcClient({ openExternal }),
      report: (e) => noteIgnored('renew an organization lease', e),
      managed: managedOrgAccess,
    });
    // a changed managed `orgAccess` ends the sign-in and takes every lease back
    managedPolicy().watch();
    unfollow = managedPolicy().onChange(
      () => void made.managedChanged().catch((e) => noteIgnored('apply the managed organization settings', e)),
    );
    /** @type {string | null} */
    let was = null;
    made.onChange(() => {
      const view = made.view();
      broadcast('host:orgAccess', view);
      const before = was;
      was = view.state;
      // a sign-in here: what waited for it goes now
      if (view.state === 'signedIn' && before !== 'signedIn')
        remote()
          ?.orgSignedIn()
          .catch((e) => noteIgnored('send the messages that waited for the organization sign-in', e));
    });
    service = made;
    return made;
  };
  handle('host:orgAccess', () => org().view());
  handle('host:setOrgAccess', (config) => org().configure(config));
  handle('host:removeOrgAccess', () => org().remove());
  handle('host:orgSignIn', () => org().signIn());
  handle('host:orgSignOut', () => org().signOut());
  /** What the machines service lends with each message: made only when a message goes out or a row is read. */
  return {
    lend: (/** @type {any} */ host, /** @type {string} */ harness) => org().lend(host, harness),
    covers: (/** @type {string} */ harness) => org().covers(harness),
    signOut: () => org().signOut(),
    identity: () => org().identity(),
    dispose: () => (unfollow?.(), service?.dispose()),
  };
}

module.exports = { registerOrgAccess, registeredBy: 'host' };
