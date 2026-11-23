// Authenticated Host image operations bind each queued/read/send continuation to the exact connection identity and chat epoch, independently of user-supplied fields.
import { StaleEpochError } from './epochs.mjs';
import { HostRefusal } from './hostFs.mjs';
import { LOCAL_CLI } from './chatRemoval.mjs';
export const IMAGE_REPLY_CHECK = Symbol('image reply ownership');
import { UnsupportedError } from './errors.mjs';

/**
 * A picture of a chat is the chat's: any paired client reads what another client of the account sent to it (the local CLI's, the phone's, a re-paired Mac's earlier key).
 * @param {{ images?: any, epochs: any, continueHost?: any, clients?: () => string[], guard?: { clients?: (chatId: string) => string[] } }} o `clients`: the clients this Host has paired; `guard`: the request log, which names the others a chat had
 */
export function createImageProtocol({ images, epochs, continueHost, clients, guard }) {
  const siblings = (/** @type {string} */ chatId) => [LOCAL_CLI, ...(clients?.() ?? []), ...(guard?.clients?.(chatId) ?? [])];
  return {
    project: (user) => images?.project(user) ?? user,
    connection(identity) {
      let closed = false;
      return {
        prepare(method, p) {
          if (
            method !== 'chat.attach' &&
            method !== 'chat.image' &&
            !(['chat.send', 'chat.start'].includes(method) && (p.images?.length || p.files?.length))
          )
            return p;
          const owner = identity();
          if (!owner || closed) throw new HostRefusal('unknown_client', 'Pair this client before using images.');
          const checkImages = () => {
            if ((closed && (method === 'chat.image' || method === 'chat.attach')) || identity() !== owner)
              throw new HostRefusal('unknown_client', 'This client is no longer paired.');
            const current = epochs.current(p.chatId);
            if (current !== p.epoch) throw new StaleEpochError(p.chatId, p.epoch, current);
            if (method !== 'chat.image') continueHost?.gate(p.chatId, p.epoch);
          };
          return { ...p, imageOwner: owner, checkImages };
        },
        async upload(p) {
          if (!images) throw new UnsupportedError('This Host cannot receive images yet. Update it.');
          continueHost?.gate(p.chatId, p.epoch);
          epochs.admit(p.chatId, p.epoch);
          p.checkImages();
          // Chunk offsets/digests own dedupe on disk, including a disconnect before the acknowledgment.
          return { replayed: false, result: await images.upload({ ...p, owner: p.imageOwner }, p.checkImages) };
        },
        async read(p) {
          if (!images) throw new UnsupportedError('This Host cannot read images yet. Update it.');
          epochs.admit(p.chatId, p.epoch);
          p.checkImages();
          const answer = await images.read({ ...p, owner: p.imageOwner, owners: siblings(p.chatId) }, p.checkImages);
          p.checkImages();
          Object.defineProperty(answer, IMAGE_REPLY_CHECK, { value: p.checkImages });
          return answer;
        },
        close() {
          closed = true;
        },
      };
    },
  };
}
