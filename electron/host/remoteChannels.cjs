// The side channels of a remote Host connection (Host work package 2.6): the chat's browser tabs (`browser.*` requests and the tab events), its lease on the Host's own desktop (`desktop.*`, G8) and the tool relay (the app announces its tools and answers the calls a harness on the Host makes of them).
const schema = require('../../shared/host/schema.mjs');
const { fanOut } = require('./fanOut.cjs');

/**
 * @param {object} o
 * @param {(method: string) => void} o.needs refuses a call the agreed protocol does not allow
 * @param {(method: string, params: object) => Promise<any>} o.request one request over the connection
 * @param {(chatId: string) => number} o.epochOf the epoch the ownership side map holds for the chat
 * @param {() => void} o.live throws once the connection was disposed
 */
function createChannels({ needs, request, epochOf, live }) {
  /** What happens to a chat's tabs in the Host's browser (remoteBrowser.cjs). @type {Set<(p: { chatId: string, payload: any }) => void>} */
  const browserFns = new Set();
  /** The calls a harness on the Host makes of the app's tools (toolRelay.cjs). @type {Set<(event: any) => void>} */
  const toolFns = new Set();
  return {
    /** Hands a Host event to the channel it belongs to; false when it is not one of theirs. @param {Record<string, any>} msg */
    route(msg) {
      if (msg.event === 'browser') {
        if (typeof msg.chatId === 'string') fanOut(browserFns, { chatId: msg.chatId, payload: msg.payload }, 'a browser event');
        return true;
      }
      if (msg.event === 'tool' || msg.event === 'toolCancel') {
        fanOut(toolFns, msg, 'a tool call');
        return true;
      }
      return false;
    },
    /** The chat's tabs in the Host's browser (package 2.6): `browser.*` requests under the chat's epoch, and what happens to the tabs. */
    browser: {
      /** @param {string} method @param {{ chatId?: string }} params */
      async request(method, params) {
        needs(method);
        return request(method, schema.parseParams(method, { ...params, epoch: epochOf(/** @type {string} */ (params?.chatId)) }));
      },
      /** @param {(p: { chatId: string, payload: any }) => void} fn */
      onEvent(fn) {
        live();
        browserFns.add(fn);
        return () => void browserFns.delete(fn);
      },
    },
    /** A chat's lease on the Host's own desktop (G8 #3903): `desktop.*` requests under the chat's epoch. A Host without the `desktop` feature is refused here, never served half. */
    desktop: {
      /** @param {string} method @param {{ chatId?: string }} params */
      async request(method, params) {
        needs(method);
        return request(method, schema.parseParams(method, { ...params, epoch: epochOf(/** @type {string} */ (params?.chatId)) }));
      },
    },
    /** The tool relay (package 2.6): the app announces its tools and answers the calls a harness on this Host makes of them. */
    tools: {
      /** A refusal (a Host without the `tools` feature) is a rejected promise, as it is for every other request: the relay filters it by its `missing` list. @param {string} method @param {object} params */
      async request(method, params) {
        needs(method);
        return request(method, schema.parseParams(method, params));
      },
      /** @param {(event: any) => void} fn */
      onEvent(fn) {
        live();
        toolFns.add(fn);
        return () => void toolFns.delete(fn);
      },
    },
    /** The connection was disposed: nobody hears the Host any more. */
    clear() {
      browserFns.clear();
      toolFns.clear();
    },
  };
}

module.exports = { createChannels, fanOut };
