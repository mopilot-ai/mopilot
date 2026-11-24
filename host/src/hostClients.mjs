// The Host's client table as the wire serves it (`host.clients*`, feature `clients`): who may add, remove and rename whom, answered from the pairing record, with the connections a removed client held closed at once.
import { HostRefusal } from './hostFs.mjs';
import { hostLinkOn } from './hostLinkFlag.mjs';

/** The principal the CLI on the Host's own machine acts as: it proves itself with the token beside the socket, not with a key. */
export const CLI_PRINCIPAL = Object.freeze({
  fingerprint: 'local-cli',
  name: 'this machine',
  kind: 'cli',
});

/** @typedef {{ fingerprint: string, name: string, kind: 'desktop' | 'phone' | 'cli' | 'home' | 'controller' | 'unknown' }} Principal */

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./pairing.mjs').createPairing>} o.pairing
 * @param {(fingerprint: string) => boolean} o.connected whether a connection of that client is open now
 * @param {(fingerprint: string) => void} o.close ends every connection of that client
 * @param {{ health: () => string, repair: (by: Principal) => Promise<boolean>, lastRepair: () => { stopped: number, unverified: number } }} [o.homeLink] the state of what MoMo's home may do here: when it is damaged the table says so, and an owner's device can repair it
 */
export function createHostClients({ pairing, connected, close, homeLink }) {
  /** Only a desktop or the CLI on this machine manages other clients: a phone manages itself. @param {Principal} who */
  const manages = (who) => who.kind === 'desktop' || who.kind === 'cli';
  /** MoMo's home is allowed, and its standing taken away, only by a device of the owner: a paired desktop or phone, never the CLI (any process on this machine can reach it) and never a home. @param {Principal} who */
  const ownersDevice = (who) => who.kind === 'desktop' || who.kind === 'phone';
  const refused = () => new HostRefusal('forbidden', 'This client may not do that.');
  return {
    /** @param {string} method @param {any} p @param {Principal} who */
    call(method, p, who) {
      if (method === 'host.clients')
        return {
          clients: pairing.list().map((c) => ({ ...c, connected: connected(c.fingerprint) })),
          // a plain problem on this machine, not a closed connection: MoMo's permissions here can't be read
          ...(homeLink?.health() === 'unreadable' ? { homeLink: { state: 'unreadable' } } : {}),
        };
      if (method === 'host.homeLinkRepair') {
        // it only takes authority away (the damaged file is set aside, no home is allowed), so the local command line may do it too: whoever sits at this Mac can always get out of a damaged state
        if (!(ownersDevice(who) || who.kind === 'cli') || !homeLink || !hostLinkOn()) throw refused();
        // no home is allowed after a repair: the owner allows MoMo again
        return homeLink.repair(who).then((repaired) => {
          if (repaired) for (const c of pairing.list().filter((x) => x.kind === 'home')) pairing.remove(c.fingerprint);
          if (!repaired) return { repaired };
          // sessions the repair could not name may still be running: the owner is told plainly, and stops them from the chat list
          const { stopped, unverified } = homeLink.lastRepair();
          return {
            repaired,
            stopped,
            unverified,
            ...(unverified > 0
              ? {
                  notice: `${unverified} task${unverified === 1 ? '' : 's'} on this machine may still be running; stop ${unverified === 1 ? 'it' : 'them'} from the chat list.`,
                }
              : {}),
          };
        });
      }
      if (method === 'host.clientAdd') {
        if (p.kind === 'home' ? !ownersDevice(who) || !hostLinkOn() : !manages(who)) throw refused();
        const fingerprint = pairing.add(p.publicKey, { name: p.name, kind: p.kind, addedBy: who.fingerprint, succeeds: p.succeeds });
        // a MoMo home key that says whom it succeeds hands the lease over before this answers: a handover that did not finish is told to the owner's device, never only reported
        const done = pairing.settled(fingerprint);
        return done
          ? done.then(
              () => ({ fingerprint }),
              () => {
                throw new HostRefusal('home_handover_failed', "MoMo's key was added, but taking over its lease did not finish.");
              },
            )
          : { fingerprint };
      }
      if (method === 'host.clientRemove') {
        const isHome = pairing.list().some((c) => c.fingerprint === p.fingerprint && c.kind === 'home');
        if (!manages(who) && p.fingerprint !== who.fingerprint && !(isHome && ownersDevice(who))) throw refused();
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
