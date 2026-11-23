// Socket-free membership fixture: real Sessions, ChromeRelay, ChromeLink and shared host over an in-memory transport.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fakeChromeApi } from './chrome-extension-kit.ts';
import { Sessions } from '../../electron/chrome-extension/src/sessions.mjs';
const require = createRequire(import.meta.url);
const { ChromeRelay, ChromeLink } = require('../../electron/capabilities/browser/chromeRelay.cjs');
const { chromeBrowserTabs } = require('../../electron/capabilities/browser/chromeHost.cjs');

export function world({ memberships = true } = {}) {
  const chrome = fakeChromeApi();
  const messages = [];
  const ports = new Map();
  const options = {
    chrome,
    send: (message) => {
      messages.push(structuredClone(message));
      ports.get(message.chat)?.emit('message', JSON.stringify(message));
    },
    storage: chrome.storage.session,
    log: () => {},
  };
  let sessions = new Sessions(options);
  const relay = new ChromeRelay({
    openPage: () => {
      throw Error('No browser in this probe');
    },
  });
  // Only transport and connection establishment are replaced. No socket is opened.
  relay.connect = async (chat) => {
    if (relay.link(chat)) return relay.link(chat);
    const ws = /** @type {any} */ (new EventEmitter());
    ws.open = true;
    ws.send = (text) => {
      void sessions.handle({ ...JSON.parse(text), chat }, (reply) => ws.emit('message', JSON.stringify(reply)), memberships);
    };
    ws.close = () => {
      ws.open = false;
      ws.emit('close', 1000, 'closed');
    };
    const link = new ChromeLink(chat, ws, 1000, { memberships });
    ports.set(chat, ws);
    relay.links.set(chat, link);
    link.once('closed', () => {
      if (relay.links.get(chat) === link) relay.links.delete(chat);
    });
    await sessions.open(chat, { receipts: memberships });
    relay.emit('connected', chat, link);
    return link;
  };
  const tabs = chromeBrowserTabs({ relay, images: { fromBuffer: (b) => b } });
  const ids = (chat) =>
    tabs
      .list(chat)
      .map((tab) => tab.wc.tabId)
      .sort();
  const move = (tabId, groupId) => {
    const tab = chrome.tabsById.get(tabId);
    tab.groupId = groupId;
    sessions.onTabUpdated(tabId, { groupId }, { ...tab });
  };
  const w = {
    chrome,
    sessions,
    relay,
    tabs,
    ids,
    move,
    messages,
    ports,
    restart: async () => {
      sessions = new Sessions(options);
      await sessions.restore();
      w.sessions = sessions;
      return sessions;
    },
  };
  return w;
}
