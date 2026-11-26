// The wire words of native sessions on a Host (#5576, Phase 4): sessions a person started with Claude Code or Codex outside MoPilot, listed read-only by `host.chats` when asked for `origin: 'native'` or `'all'`. Owns the two features, the origins, the row id `native:<family>:<id>` and what a request needs of its peer; the Host's discovery and index live in host/src/native*.mjs.
import { appChatId, hostChatId } from './chatIds.mjs';

export const NATIVE_LIST_FEATURE = 'nativeList';
export const NATIVE_EVENTS_FEATURE = 'nativeEvents';

/** Which rows a `host.chats` call lists: the chats this Host runs (the default, so an older client sees what it always saw), the native sessions, or both in one order. */
export const CHAT_ORIGINS = /** @type {const} */ (['host', 'native', 'all']);

/** The agents whose sessions a Host discovers by themselves; an ACP agent lists none until it declares `session/list`. */
export const NATIVE_FAMILIES = /** @type {const} */ (['claude', 'codex']);

const PREFIX = 'native:';
/** One id of a native session: what the agent's own store calls it (a UUID in practice), kept to characters no path or id of ours can be confused by. */
const NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The id a native session is listed under. @param {'claude' | 'codex'} family @param {string} id the agent's own session id */
export const nativeChatId = (family, id) => `${PREFIX}${family}:${id}`;

/** The family and the agent's own id of a listed native row, or null for any other id (a Host chat's, a malformed one). @param {unknown} chatId @returns {{ family: 'claude' | 'codex', id: string } | null} */
export function parseNativeChatId(chatId) {
  if (typeof chatId !== 'string' || !chatId.startsWith(PREFIX)) return null;
  const rest = chatId.slice(PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon < 1) return null;
  const family = rest.slice(0, colon);
  const id = rest.slice(colon + 1);
  return NATIVE_FAMILIES.includes(/** @type {any} */ (family)) && NATIVE_ID.test(id)
    ? { family: /** @type {'claude' | 'codex'} */ (family), id }
    : null;
}

/** The id a Host chat of the same session has on this Host (`claude:<id>`, or the bare id of a Codex thread): a native row is never listed while the Host owns the session. @param {'claude' | 'codex'} family @param {string} id */
export const hostIdOfNative = (family, id) => hostChatId(`acp:host-${family}:${id}`);

/** Whether a `host.chats` request lists native rows. @param {unknown} origin */
export const wantsNative = (origin) => origin === 'native' || origin === 'all';

/** What a request needs of its peer, so an older Host that would answer with its own chats only is never sent one it would misread. @param {string} method @param {any} params */
export function nativeNeeds(method, params) {
  return [
    ...(method === 'host.chats' && wantsNative(params?.origin) ? [NATIVE_LIST_FEATURE] : []),
    ...(method === 'host.chats.watch' && params?.native === true ? [NATIVE_EVENTS_FEATURE] : []),
  ];
}

const HOST_APP_ID = /^acp:host-(claude|codex):(.+)$/;
/** The listed native row, if any, that a chat this Host runs under `hostId` would be the same session as: `claude:<id>` is Claude Code's, a bare id a Codex thread's, anything else (a basic agent's) none. @param {string} hostId @returns {string | null} */
export function nativeChatIdOfHostChat(hostId) {
  const m = HOST_APP_ID.exec(appChatId(hostId));
  return m ? nativeChatId(/** @type {'claude' | 'codex'} */ (m[1]), /** @type {string} */ (m[2])) : null;
}
