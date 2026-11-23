// A picture a user sent to a chat on a machine, read back from that machine for a window (host:picture): the same reader and ownership fences the phone's thumbnails use, answered as a data URL, or the real reason there is none (away, moved, not paired, too old, no longer there).
const { hostImageLocator, IMAGE_FEATURE, CHAT_IMAGE_FEATURE } = require('../../shared/host/images.mjs');
const { phoneHostImage } = require('./phoneHostImages.cjs');

const NOT_THIS_CHAT = 'That picture is not in this chat.';
/** How long a chat's list of pictures is trusted: the pictures of one draw are asked together, so the history is read once for them. */
const INDEX_MS = 2000;
/** How old a list must be before a reference it lacks is looked for in a fresh read: a picture of a message another client saved a moment after the list is found, and a flood of guesses reads at most this often. */
const REREAD_MS = 300;
/** How many chats' lists are kept: the least recently asked go first. */
const INDEX_CHATS = 32;

/** How long an offline machine is given to answer, and each chunk of a picture to arrive, before the picture says what is wrong instead of staying a placeholder. */
const LIMITS = { connectMs: 8000, readMs: 10000 };

/** The Host's refusal codes that say the machine is not reachable right now. */
const AWAY = new Set(['host_unreachable', 'request_retired', 'disposed']);

/**
 * Whether a message of the chat's own saved history carries a picture reference. A reference the list does not have is looked for in a fresh read before it is refused, so a picture of a message saved a moment ago is found.
 * @param {(chatId: string) => Promise<any[]>} read the chat's saved records @param {() => number} [now]
 * @returns {(chatId: string, url: string) => Promise<boolean>}
 */
function pictureIndex(read, now = Date.now) {
  /** @type {Map<string, { at: number, urls: Set<string> }>} */
  const listed = new Map();
  /** @type {Map<string, Promise<Set<string>>>} the read in flight for a chat: pictures drawn together share it */
  const pending = new Map();
  const list = (/** @type {string} */ chatId) => {
    const joined = pending.get(chatId);
    if (joined) return joined;
    const reading = (async () => {
      try {
        const urls = new Set();
        for (const r of await read(chatId))
          if (r?.t === 'user' && Array.isArray(r.user?.content))
            for (const c of r.user.content) if (typeof c?.url === 'string') urls.add(c.url);
        listed.delete(chatId);
        listed.set(chatId, { at: now(), urls });
        while (listed.size > INDEX_CHATS) listed.delete(/** @type {string} */ (listed.keys().next().value));
        return urls;
      } finally {
        pending.delete(chatId);
      }
    })();
    pending.set(chatId, reading);
    return reading;
  };
  // inside the window a listed reference is known; one it lacks is looked for again once the list is a moment old
  return async (chatId, url) => {
    const held = listed.get(chatId);
    const age = held ? now() - held.at : Infinity;
    if (held && age < INDEX_MS && (held.urls.has(url) || age < REREAD_MS)) return held.urls.has(url);
    return (await list(chatId)).has(url);
  };
}

/**
 * @param {object} o
 * @param {any} o.live main's live services (hostOwnership, hostPhone.imageHostFor)
 * @param {string} o.chatId @param {unknown} o.url the `host-image:` source of the picture
 * @param {(hostId: string) => string | null} o.nameOf the machine's name
 * @param {(chatId: string, url: string) => Promise<boolean>} o.knows whether the chat's own saved messages name the picture: only one they name is read
 * @returns {Promise<{ picture: string } | { offline: string } | { retry: string } | { blocked: string } | { update: string } | { gone: true, machine?: string }>}
 */
async function hostPicture({ live, chatId, url, nameOf, knows }) {
  const ref = hostImageLocator(url);
  const owner = live.hostOwnership?.get(chatId);
  if (!ref || !owner || owner.hostId === 'local') return { gone: true };
  const source = ref.hostId ?? owner.hostId;
  const machine = nameOf(source) ?? 'the machine';
  // a reference guessed for another chat or machine is refused: the chat's own history must name it; a history that cannot be read now says nothing about it
  let named;
  try {
    named = await knows(chatId, /** @type {string} */ (url));
  } catch {
    return { retry: machine };
  }
  if (!named) throw Object.assign(new Error(NOT_THIS_CHAT), { code: 'invalid' });
  const connection = () => live.hostPhone?.imageHostFor?.(source) ?? null;
  const online = () => connection()?.state() === 'online';
  // a Host that cannot read a picture for every client of the chat (or any) cannot tell "not there" from "not mine": it is asked to update, never told the picture is gone
  const older = () => connection()?.speaks?.(IMAGE_FEATURE) === false || connection()?.speaks?.(CHAT_IMAGE_FEATURE) === false;
  try {
    const picture = await phoneHostImage(live, chatId, ref, () => undefined, LIMITS);
    if (picture)
      return {
        picture: `data:${picture.mime};base64,${picture.data.toString('base64')}`,
      };
  } catch (error) {
    const code = /** @type {any} */ (error)?.code;
    if (code === 'stale_epoch') return { retry: machine };
    if (code === 'unknown_client' || code === 'forbidden') return { blocked: machine };
    if (code === 'feature_missing' || code === 'unsupported') return { update: machine };
    // the machine looked and the picture is not there (a Host older than the chat's pictures could not have looked in every client's)
    if (code === 'image_unavailable') return older() ? { update: machine } : { gone: true, machine };
    // the machine could not read what it has (a disk fault, a store to repair): not gone, and a second try may work
    if (code === 'image_fault') return { retry: machine };
    return AWAY.has(code) || !online() ? { offline: machine } : { retry: machine };
  }
  // no bytes: the machine is away, its Host is too old to read pictures, or it no longer has the picture
  if (!online()) return { offline: machine };
  return older() ? { update: machine } : { gone: true, machine };
}

/** The `host:picture` call: its chat id and the reference, answered for the live services `live()` gives and the machines `machines()` knows by name. @param {() => any} live @param {() => { row: (hostId: string) => { name?: string } | undefined }} machines */
const hostPictureHandler = (live, machines) => {
  const knows = pictureIndex(async (id) => (await live()?.acpHost?.items?.readAsync(id)) ?? []);
  return (/** @type {unknown} */ chatId, /** @type {unknown} */ url) =>
    hostPicture({
      live: live(),
      chatId: String(chatId ?? ''),
      url,
      nameOf: (id) => machines().row(id)?.name ?? null,
      knows,
    });
};

/** Registers `host:picture`: a sent picture, read back from its machine for the window's bubble. */
const registerHostPicture = (handle, live, machines) => handle('host:picture', hostPictureHandler(live, machines));

module.exports = { hostPicture, hostPictureHandler, registerHostPicture, pictureIndex };
