// The desktop requests of the Host wire (shared/host/desktop.mjs, G8 #3903) served from the Host's desktop: each is checked against the chat's epoch first, as the browser's are (a stale owner cannot drive the desktop), a lease belongs to the connection that took it, and a connection that goes away lets go of its desktop.
import { DESKTOP_READS } from '../../shared/host/desktop.mjs';
import { tracked } from './callIntents.mjs';

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./desktopHost.mjs').createDesktopHost>} o.desktop
 * @param {ReturnType<typeof import('./epochs.mjs').createEpochStore>} o.epochs
 * @param {Parameters<typeof tracked>[0]} [o.intents] the record of actions sent and not answered (./callIntents.mjs)
 */
export function createDesktopProtocol({ desktop, epochs, intents }) {
  return {
    /** One connection. */
    connection() {
      /** this connection's identity: a lease is held by it and by no other */
      const owner = {};
      return {
        /** @param {string} method @param {any} p the parsed params @returns {Promise<any>} */
        async call(method, p) {
          epochs.admit(p.chatId, p.epoch);
          switch (method) {
            case 'desktop.lease':
              return desktop.lease(owner, p.chatId, p.epoch, p.apps);
            case 'desktop.call':
              // an action is on disk before the helper is asked, so a Host that dies under it leaves it for the next one to tell as lost
              return tracked(intents, DESKTOP_READS.has(p.method) ? null : { chatId: p.chatId, kind: 'desktop', name: p.method }, () =>
                desktop.call(owner, p.chatId, p.epoch, p.callId, p.method, p.params),
              );
            case 'desktop.release':
              return desktop.release(owner, p.chatId, p.epoch);
            case 'desktop.abort':
              return desktop.abort(p.chatId);
            default:
              return desktop.state(owner, p.chatId);
          }
        },
        /** The client went away: its desktop is let go. */
        close() {
          void desktop.closed(owner);
        },
      };
    },
  };
}
