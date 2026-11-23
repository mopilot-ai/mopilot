// A Host that is stopping takes no new message: the chat runtime the server serves refuses `send` from the moment the stop begins, so no turn starts a child after the stop has ended the children (it would be left running until the next Host ends it).
import { HostRefusal } from './hostFs.mjs';

/**
 * @template {{ send: (...args: any[]) => Promise<any> }} R
 * @param {R} runtime the chat runtime the server serves @param {() => boolean} stopping whether the Host has begun to stop
 * @returns {R}
 */
export function refuseWhenStopping(runtime, stopping) {
  return new Proxy(runtime, {
    get(target, key) {
      if (key !== 'send') return Reflect.get(target, key);
      return (/** @type {any[]} */ ...args) =>
        stopping()
          ? Promise.reject(new HostRefusal('unsupported', 'This Host is stopping. Send the message again in a moment.'))
          : target.send(...args);
    },
  });
}
