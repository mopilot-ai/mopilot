// The Host's client table as the wire serves it (`host.clients*`, feature `clients`): who may add, remove and rename whom, answered from the pairing record, with the connections a removed client held closed at once.
import { HostRefusal } from './hostFs.mjs';

/** The principal the CLI on the Host's own machine acts as: it proves itself with the token beside the socket, not with a key. */
export const CLI_PRINCIPAL = Object.freeze({
  fingerprint: 'local-cli',
  name: 'this machine',
  kind: 'cli',
});

/** @typedef {{ fingerprint: string, name: string, kind: 'desktop' | 'phone' | 'cli' }} Principal */

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./pairing.mjs').createPairing>} o.pairing
 * @param {(fingerprint: string) => boolean} o.connected whether a connection of that client is open now
 * @param {(fingerprint: string) => void} o.close ends every connection of that client
 */
export function createHostClients({ pairing, connected, close }) {
  /** Only a desktop or the CLI on this machine manages other clients: a phone manages itself. @param {Principal} who */
  const manages = (who) => who.kind === 'desktop' || who.kind === 'cli';
  const refused = () => new HostRefusal('forbidden', 'This client may not do that.');
  return {
    /** @param {string} method @param {any} p @param {Principal} who */
    call(method, p, who) {
      if (method === 'host.clients')
        return {
          clients: pairing.list().map((c) => ({ ...c, connected: connected(c.fingerprint) })),
        };
      if (method === 'host.clientAdd') {
        if (!manages(who)) throw refused();
        return {
          fingerprint: pairing.add(p.publicKey, {
            name: p.name,
            kind: p.kind,
            addedBy: who.fingerprint,
          }),
        };
      }
      if (method === 'host.clientRemove') {
        if (!manages(who) && p.fingerprint !== who.fingerprint) throw refused();
        const removed = pairing.remove(p.fingerprint);
        // after the reply is written: a client that removes itself still hears the answer
        if (removed) setImmediate(() => close(p.fingerprint));
        return { removed };
      }
      // host.clientRename: the caller's own record (the CLI has none)
      return { renamed: pairing.rename(who.fingerprint, p.name) };
    },
  };
}
