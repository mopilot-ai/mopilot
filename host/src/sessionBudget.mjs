// File-byte accounting for all chat journals under one Host lock, refreshed after uncertain writes and updated incrementally on normal appends.
import fs from 'node:fs';
import path from 'node:path';
/** @param {{ root: string, io?: typeof fs, maxBytes: number, full: () => Error }} o */
export function createSessionBudget({ root, io = fs, maxBytes, full }) {
  let known = false;
  let total = 0;
  const sizes = new Map();
  function scan(dir) {
    let entries;
    try {
      entries = io.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(file);
      else {
        const bytes = io.lstatSync(file).size;
        sizes.set(file, bytes);
        total += bytes;
      }
    }
  }
  function ready() {
    if (known) return;
    total = 0;
    sizes.clear();
    scan(root);
    known = true;
  }
  let collected = false;
  function collectRetired() {
    if (collected) return;
    let entries;
    try {
      entries = io.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        collected = true;
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}\.removed\.[a-f0-9-]{36}$/.test(entry.name)) continue;
      io.rmSync(path.join(root, entry.name), { recursive: true });
      known = false;
    }
    collected = true;
  }
  return {
    check(bytes) {
      collectRetired();
      ready();
      if (total + bytes > maxBytes) throw full();
    },
    /** Reserve the resulting length before writing, including atomic-replacement temporary files. */
    reserve(file, bytes, append = false) {
      collectRetired();
      ready();
      const previous = sizes.get(file) ?? 0;
      const next = append ? previous + bytes : bytes;
      if (total + next - previous > maxBytes) throw full();
      sizes.set(file, next);
      total += next - previous;
    },
    /** A rename replaces the prior destination and retains exactly the temporary file's bytes. */
    renamed(from, to) {
      ready();
      total -= sizes.get(to) ?? 0;
      sizes.set(to, /** @type {number} */ (sizes.get(from)));
      sizes.delete(from);
    },
    /** The next write reconciles actual filesystem state after an uncertain mutation. */
    invalidate() {
      known = false;
    },
  };
}
