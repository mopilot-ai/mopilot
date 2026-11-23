// ui-state.json as main holds it: read from the disk once, then served from memory (prefs, the windows' state and the legacy mirror all change it many times a second while a chat streams), and written behind as compact JSON. It is derived state (the windows send their whole state again), so a change is on the disk about a second later and at quit. Something else replacing the file (a migration, a restore, a person) is noticed by its stamp: a read takes the new file, and a write waiting under it is rebased onto it (the changes made since the last write are applied again to what the file now holds).
const fs = require('node:fs');
const { isJsonRecord, parseJsonRecord } = require('../../shared/jsonRecord.mjs');

/** Changes kept to apply again onto a replaced file. */
const MAX_OPS = 100;

/** @typedef {{ state: Record<string, any>, stamp: string, ops: Array<(s: any) => any>, producedOps: number }} Held */

/**
 * @param {{ writer: InstanceType<typeof import('./writeBehind.cjs').WriteBehind>,
 *   readStateFile: (file: string, what: string, valid: (d: any) => boolean) => any }} deps what touches the disk, handed in
 */
function createUiStateFiles({ writer, readStateFile }) {
  /** @type {Map<string, Held>} */
  const caches = new Map();
  /** Run on the state at every write of a file; they outlive a drop of the held state. @type {Map<string, Map<unknown, (s: any) => any>>} */
  const prepares = new Map();

  /** What the file is on the disk (which file, how big, when written): a different one was written by someone else. */
  function stampOf(/** @type {string} */ file) {
    const info = fs.statSync(file, { throwIfNoEntry: false });
    return info ? `${info.ino}:${info.size}:${info.mtimeMs}` : '';
  }

  function hold(/** @type {string} */ file, /** @type {Record<string, any>} */ state) {
    const held = { state, stamp: stampOf(file), ops: [], producedOps: 0 };
    caches.set(file, held);
    return held;
  }

  /** The record the file holds, or null when it is missing or cannot be read (nothing is kept aside here). */
  function lookAt(/** @type {string} */ file) {
    try {
      const parsed = parseJsonRecord(fs.readFileSync(file, 'utf8'));
      return parsed.ok ? parsed.record : null;
    } catch {
      return null;
    }
  }

  /** The held state while it is the file's: main's own unwritten change, or the file as last read or written. */
  function current(/** @type {string} */ file) {
    const held = caches.get(file);
    if (!held) return null;
    return writer.pending(file) || stampOf(file) === held.stamp ? held : null;
  }

  /**
   * The file's state, read from the disk the first time (and when something else replaced it). An unreadable file is first
   * kept as <file>.unreadable, and the failure thrown, as for any state main saves over.
   * @param {string} file @returns {Record<string, any>}
   */
  function readUiState(file) {
    return (current(file) ?? hold(file, readStateFile(file, 'the app state (ui-state.json)', isJsonRecord) ?? {})).state;
  }

  /**
   * The file's state for a reader that only looks: what main holds, else what the disk has; {} when it can't be read (nothing is held then).
   * @param {string} file @returns {Record<string, any>}
   */
  function peekUiState(file) {
    const held = current(file);
    if (held) return held.state;
    const state = lookAt(file);
    return state ? hold(file, state).state : {};
  }

  /**
   * What the file holds, whatever it is (a root that is not a record is returned as it is, and nothing is held): for a
   * caller that refuses such a file itself. Throws when the file is not JSON.
   * @param {string} file @returns {any}
   */
  function inspectUiState(file) {
    const held = current(file);
    if (held) return held.state;
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  }

  /** Mark the state changed: written behind, after it was rebased onto the file if that was replaced, and the `prepares` have run on it. */
  function touchUiState(/** @type {string} */ file) {
    const held = caches.get(file);
    if (!held) return;
    writer.set(
      file,
      () => {
        if (stampOf(file) !== held.stamp) {
          // replaced under the waiting changes: they are applied again to what the file holds now
          const disk = lookAt(file);
          if (disk) held.state = held.ops.reduce((s, op) => op(s), disk);
          held.stamp = stampOf(file);
        }
        let s = held.state;
        for (const prepare of prepares.get(file)?.values() ?? []) s = prepare(s);
        held.state = s;
        held.producedOps = held.ops.length;
        return JSON.stringify(s);
      },
      () => {
        held.stamp = stampOf(file);
        // what was written no longer needs to be applied again
        held.ops.splice(0, held.producedOps);
        held.producedOps = 0;
      },
    );
  }

  /** Change the state with `fn` (it returns the new one, and may run again on a newer file) and write it behind; returns the new state. */
  function updateUiState(/** @type {string} */ file, /** @type {(s: Record<string, any>) => Record<string, any>} */ fn) {
    readUiState(file);
    const held = /** @type {Held} */ (caches.get(file));
    held.state = fn(held.state);
    held.ops.push(fn);
    // changes that cannot be written pile up only so far: past that they are kept as the state they made
    if (held.ops.length > MAX_OPS) {
      const kept = held.state;
      held.ops = [() => kept];
      held.producedOps = 0;
    }
    touchUiState(file);
    return held.state;
  }

  /** Run `prepare` on the state at every write of the file (the owner is the key: it is replaced, not added twice). */
  function prepareUiState(
    /** @type {string} */ file,
    /** @type {unknown} */ owner,
    /** @type {(s: Record<string, any>) => Record<string, any>} */ prepare,
  ) {
    if (!prepares.has(file)) prepares.set(file, new Map());
    /** @type {Map<unknown, (s: any) => any>} */ (prepares.get(file)).set(owner, prepare);
  }

  /** Forget what is held (written first): the next read is the disk's. */
  function dropUiState(/** @type {string} */ file) {
    writer.flushSync();
    caches.delete(file);
  }

  return { readUiState, peekUiState, inspectUiState, touchUiState, updateUiState, prepareUiState, dropUiState };
}

module.exports = { createUiStateFiles };
