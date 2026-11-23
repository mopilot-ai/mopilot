// Compatibility entrypoint for CLI lock consumers; the implementation ships with the Host and the desktop app.
export { parseOwner, pidAlive, tryLock } from '../host/src/pidLock.mjs';
/** @typedef {import('../host/src/pidLock.mjs').Owner} Owner */
/** @typedef {import('../host/src/pidLock.mjs').LockFs} LockFs */
/** @typedef {import('../host/src/pidLock.mjs').LockResult} LockResult */
