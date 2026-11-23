// The chats started to run on this Host's own sign-in (#3619): a scheduled run nobody is there for must not use a key or organization lease the app lent to another chat, and must not take that lease away. Held in memory; a chat that ended is forgotten.

import { createChatCredentials } from './chatCredentials.mjs';
import { signInProbe } from './harnessState.mjs';

/** The set of chat ids that run on the Host's own credentials. */
export function createOwnRuns() {
  /** @type {Set<string>} */
  const chats = new Set();
  return {
    /** @param {string} chatId */
    add: (chatId) => void chats.add(chatId),
    /** @param {string} chatId */
    has: (chatId) => chats.has(chatId),
    /** @param {string} chatId */
    delete: (chatId) => chats.delete(chatId),
  };
}

/**
 * The own-credential chats together with the credential choices chats carry from their start (./chatCredentials.mjs), which put chats in and take them out of the set and are kept across restarts.
 * @param {{ leases: Parameters<typeof createChatCredentials>[0]['leases'], dataDir?: string, status?: Parameters<typeof signInProbe>[1] }} o `status`: the agents with their sign-in, asked for when a chat must be kept on a credential before any status was
 */
export function createOwnCredentials({ leases, dataDir, status }) {
  const ownRuns = createOwnRuns();
  const credentials = createChatCredentials({ leases, ownRuns, dataDir });
  credentials.restore();
  if (status) credentials.setProbe(signInProbe(credentials, status));
  // a Claude Code chat runs on the machine's own sign-in when it chose so, or chose nothing and the default order puts that login first
  return {
    ...ownRuns,
    has: (/** @type {string} */ chatId) => ownRuns.has(chatId) || credentials.ownByDefault(chatId),
    chatCredentials: credentials,
  };
}
