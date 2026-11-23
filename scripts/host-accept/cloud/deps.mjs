// What the cloud acceptance run touches outside itself, so a test can bring stand-ins: the secrets, the network, the shell, the clock and the process's signals.
import { createChannel } from '../channel.mjs';
import { makeKey } from './ssh.mjs';
import { readOciSecrets } from './secrets.mjs';

/**
 * @typedef {object} CloudDeps
 * @property {typeof readOciSecrets} readSecrets
 * @property {typeof fetch} fetch
 * @property {(launcher: Parameters<typeof createChannel>[0]['launcher']) => ReturnType<typeof createChannel>} makeChannel
 * @property {typeof makeKey} keygen
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => number} now
 * @property {number} lookMs how long one look at a waking machine's Host waits for it to answer
 * @property {number} pollMs how often the provider is asked while a state is awaited
 * @property {{ once: (event: string, fn: () => void) => unknown, off: (event: string, fn: () => void) => unknown }} signals
 * @property {(code: number) => unknown} exit
 * @property {(id: string) => any} [hostStep] a step to run in place of the Host acceptance run's own step of that id (A2, A3, A5, A6, S10); for a test
 */

/** @returns {CloudDeps} */
export const cloudDefaults = () => ({
  readSecrets: readOciSecrets,
  // read when called, so the global at that moment is the one used
  fetch: (input, init) => globalThis.fetch(input, init),
  makeChannel: (launcher) => createChannel({ launcher, timeoutMs: 300_000 }),
  keygen: makeKey,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  lookMs: 5000,
  pollMs: 3000,
  signals: process,
  exit: (code) => process.exit(code),
});
