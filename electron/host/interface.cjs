// The Host interface the window talks to: the methods a chat needs (send, stop, permit, subscribe), its identity, and the errors every Host raises.

/** The methods every Host implements; a proxy to a remote Host must provide the same set. */
const HOST_METHODS = Object.freeze(['chats', 'send', 'stop', 'permit', 'subscribe', 'hostInfo', 'dispose']);

class HostError extends Error {
  /** @param {'not-owned' | 'disposed' | 'invalid' | 'no_mac_signin' | 'host_outdated'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'HostError';
    this.code = code;
  }
}

/** A call that cannot be served now: the tunnel is down or reconnecting, or the connection broke under it. */
class HostUnreachableError extends HostError {
  /** @param {string} hostId @param {string} reason */
  constructor(hostId, reason) {
    super(/** @type {any} */ ('host_unreachable'), `The host is unreachable: ${reason}`);
    this.hostId = hostId;
    this.reason = reason;
  }
}

/** What the machine running this Host can do for a chat. The local Host runs in the app, so it can do all of it. */
function localHostInfo() {
  return { id: 'local', kind: 'local', capabilities: { iab: true, cu: true, bu: true, shell: true } };
}

/**
 * The chat id a Host method was given, if this Host owns it.
 * @param {(chatId: string) => boolean} owns
 * @param {unknown} chatId
 * @returns {string}
 */
function ownedChat(owns, chatId) {
  if (typeof chatId !== 'string' || !chatId) throw new HostError('invalid', 'A chat id is required.');
  if (!owns(chatId)) throw new HostError('not-owned', 'This Host does not own that chat.');
  return chatId;
}

/** Throws when `host` lacks a method of the interface, so a proxy that forgot one fails at construction, not mid-chat. @param {any} host */
function assertHost(host) {
  for (const name of HOST_METHODS) if (typeof host?.[name] !== 'function') throw new HostError('invalid', `A Host needs ${name}().`);
  if (typeof host.events?.onPatch !== 'function') throw new HostError('invalid', 'A Host needs events.onPatch().');
  return host;
}

module.exports = { HOST_METHODS, HostError, HostUnreachableError, localHostInfo, ownedChat, assertHost };
