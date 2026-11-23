// The last image response boundary before socket.write: recheck the producer's exact owner/epoch lease after every protocol continuation has finished.
import { IMAGE_REPLY_CHECK } from './imageProtocol.mjs';
import { HostRefusal } from './hostFs.mjs';
import { wireError } from './protocol.mjs';
export function imageReplyForWire(method, reply) {
  if (method !== 'chat.image' || reply.result === undefined) return reply;
  try {
    const check = reply.result?.[IMAGE_REPLY_CHECK];
    if (typeof check !== 'function') throw new HostRefusal('unknown_client', 'This image reply cannot be verified.');
    check();
    return reply;
  } catch (error) {
    return wireError(error);
  }
}
