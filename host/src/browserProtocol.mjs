// The browser requests of the Host wire (shared/host/browser.mjs, package 2.6) served from the Host's browser service: each is checked against the chat's epoch first (a stale owner cannot drive the browser), a connection hears the events of the chats it opened tabs for, and a reply too large for a frame is refused instead of cutting the connection.
import { MAX_FRAME } from '../../shared/host/frames.mjs';
import { tracked } from './callIntents.mjs';
import { acts } from './cdpRules.mjs';

/** The most a reply may carry: the frame limit less the envelope. */
const MAX_REPLY = MAX_FRAME - 4096;

export class BrowserReplyTooLarge extends Error {
  constructor() {
    super('The page answered with more than one message can carry. Ask for less (a smaller screenshot, a narrower read).');
    this.name = 'BrowserReplyTooLarge';
    this.code = 'too_large';
  }
}

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./browserHost.mjs').createBrowserHost>} o.browser
 * @param {ReturnType<typeof import('./epochs.mjs').createEpochStore>} o.epochs
 * @param {Parameters<typeof tracked>[0]} [o.intents] the record of actions sent and not answered (./callIntents.mjs)
 */
export function createBrowserProtocol({ browser, epochs, intents }) {
  return {
    /** One connection: `emit` writes a message to its client. @param {(message: object) => void} emit */
    connection(emit) {
      /** The chats this connection hears about. @type {Map<string, () => void>} */
      const following = new Map();
      /** Hears the chat's tab events from now on, in place of an earlier listener of this connection. @param {string} chatId */
      const follow = (chatId) => {
        following.get(chatId)?.();
        following.set(
          chatId,
          browser.subscribe(chatId, (payload) => emit({ event: 'browser', chatId, payload })),
        );
      };
      return {
        /** @param {string} method @param {any} p the parsed params @returns {Promise<any>} */
        async call(method, p) {
          epochs.admit(p.chatId, p.epoch);
          switch (method) {
            case 'browser.open': {
              const tab = await browser.open(p.chatId);
              follow(p.chatId);
              return tab;
            }
            case 'browser.tabs': {
              const tabs = await browser.tabs(p.chatId);
              // a Mac that came back hears the chat's tabs again; a chat with no browser has none to hear
              if (tabs.length > 0) follow(p.chatId);
              return { tabs };
            }
            case 'browser.attach':
              return browser.attach(p.chatId, p.targetId);
            case 'browser.detach':
              return browser.detach(p.chatId, p.targetId);
            case 'browser.close':
              return browser.close(p.chatId, p.targetId);
            case 'browser.release':
              following.get(p.chatId)?.();
              following.delete(p.chatId);
              return browser.release(p.chatId);
            case 'browser.abort':
              return browser.abort(p.chatId);
            default: {
              // an input or a navigation is on disk before the page gets it, so a Host that dies under it leaves it for the next one to tell as lost
              const act = acts(p.method, p.params);
              const result = await tracked(intents, act ? { chatId: p.chatId, kind: 'browser', name: act } : null, () =>
                browser.command(p.chatId, { targetId: p.targetId, sessionId: p.sessionId, method: p.method, params: p.params }),
              );
              // the frame limit is in bytes: a page of 3-byte characters is a third of the characters of an ASCII one
              if (Buffer.byteLength(JSON.stringify(result)) > MAX_REPLY) throw new BrowserReplyTooLarge();
              return result;
            }
          }
        },
        /** The client went away: it hears no more; the chats' tabs stay on the Host. */
        close() {
          for (const off of following.values()) off();
          following.clear();
        },
      };
    },
  };
}
