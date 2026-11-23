// Validated Host maps: reread on access, recover from a good backup and replace through an fsynced file.
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} file
 * @param {{ valid: (value: unknown) => boolean, kind: string, unreadable: (file: string) => Error, report: (problem: string) => void }} o
 */
export function createMapFile(file, { valid, kind, unreadable, report }) {
  const backup = `${file}.bak`;
  /** @param {string} source */
  function read(source) {
    let text;
    try {
      text = fs.readFileSync(source, 'utf8');
    } catch (e) {
      return /** @type {any} */ (e).code === 'ENOENT' ? { map: new Map(), missing: true } : null;
    }
    try {
      const value = JSON.parse(text);
      return valid(value) ? { map: new Map(Object.entries(value)), missing: false } : null;
    } catch {
      return null;
    }
  }
  return {
    load() {
      const main = read(file);
      if (main) return main.map;
      const copy = read(backup);
      if (!copy || copy.missing) throw unreadable(file);
      report(`The ${kind} file ${file} was unreadable; its last good copy was used.`);
      return copy.map;
    },
    /** @param {Map<string, any>} map */
    save(map) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      // Replace the backup only with a validated main file.
      if (read(file)?.missing === false) fs.copyFileSync(file, backup);
      const tmp = `${file}.${process.pid}.tmp`;
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(Object.fromEntries(map)));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    },
  };
}
