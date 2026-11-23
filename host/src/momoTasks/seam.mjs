// The tasks ledger's storage on a Host: one sealed file under the home's folder behind the atomic `change` seam the ledger needs. It writes only while this Host is the running home, so a stale lease or a move in progress never changes a task.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { HostRefusal } from '../hostFs.mjs';

const require = createRequire(import.meta.url);
const { SealedJson } = require('../../../electron/gateway/sealedFile.cjs');

/** @param {any} v @returns {{ doc: unknown }} */
const shape = (v) => ({ doc: v && typeof v === 'object' && 'doc' in v ? v.doc : null });

/**
 * @param {object} o
 * @param {string} o.dir the home's storage folder
 * @param {import('../../../electron/platform/secretFile.cjs').SafeStorage} o.safeStorage MoMo's data key
 * @param {{ stamp: () => unknown }} o.home
 * @param {() => number} o.now
 * @returns {import('../../../shared/momoTasks/types.ts').DocSeam}
 */
export function createTasksSeam({ dir, safeStorage, home, now }) {
  const name = 'tasks.json';
  const file = new SealedJson({ file: path.join(dir, name), safeStorage, shape, now });
  return {
    read: async () => (fs.existsSync(path.join(dir, name)) ? file.read().doc : null),
    change: async (fn) => {
      if (!home.stamp()) throw new HostRefusal('momo_home_away', "MoMo's home is not running on this machine.");
      return file.change((all) => {
        const result = fn(all.doc);
        all.doc = result.doc;
        return result.out;
      });
    },
  };
}

/**
 * The start keys of tasks' sessions (`<item>:<attempt>` -> chat id), sealed beside the ledger: a Start again after a crash between starting a session and recording it finds the session the first start made instead of making a second.
 * @param {{ dir: string, safeStorage: import('../../../electron/platform/secretFile.cjs').SafeStorage, now: () => number, keep?: number }} o
 */
export function createStartKeys({ dir, safeStorage, now, keep = 500 }) {
  const name = 'task-keys.json';
  const file = new SealedJson({
    file: path.join(dir, name),
    safeStorage,
    now,
    shape: (/** @type {any} */ v) => ({ keys: v?.keys && typeof v.keys === 'object' && !Array.isArray(v.keys) ? v.keys : {} }),
  });
  return {
    /** @param {string} key @returns {string | null} */
    get: (key) => (fs.existsSync(path.join(dir, name)) ? (file.read().keys[key] ?? null) : null),
    /** @param {string} key @param {string} chatId */
    set: (key, chatId) =>
      file.change((all) => {
        all.keys[key] = chatId;
        const names = Object.keys(all.keys);
        for (const old of names.slice(0, Math.max(0, names.length - keep))) delete all.keys[old];
      }),
    /** A start that did not happen gives its key back, so the next one makes a new chat. @param {string} key */
    delete: (key) =>
      file.change((all) => {
        delete all.keys[key];
      }),
  };
}

/**
 * How a task's session last ended, kept as soon as it ends (whether or not MoMo's home was there to hear it): a home that was paused, moving or down reads it when it comes back, instead of calling a finished task lost.
 * @param {{ dir: string, safeStorage: import('../../../electron/platform/secretFile.cjs').SafeStorage, now: () => number, keep?: number }} o
 */
export function createTaskEnds({ dir, safeStorage, now, keep = 200 }) {
  const name = 'task-ends.json';
  const file = new SealedJson({
    file: path.join(dir, name),
    safeStorage,
    now,
    shape: (/** @type {any} */ v) => ({ ends: v?.ends && typeof v.ends === 'object' && !Array.isArray(v.ends) ? v.ends : {} }),
  });
  return {
    /** @param {string} chatId @returns {import('../../../shared/momoTasks/types.ts').SessionEvent | null} */
    get: (chatId) => (fs.existsSync(path.join(dir, name)) ? (file.read().ends[chatId] ?? null) : null),
    /** @param {string} chatId @param {import('../../../shared/momoTasks/types.ts').SessionEvent} event */
    set: (chatId, event) =>
      file.change((all) => {
        all.ends[chatId] = event;
        const names = Object.keys(all.ends);
        for (const old of names.slice(0, Math.max(0, names.length - keep))) delete all.ends[old];
      }),
  };
}
