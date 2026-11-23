// Which ACP harnesses this Host knows to be signed in: set when a sign-in here completes or a turn ran to its end, cleared when a turn failed for want of a login. A small file in the data dir (no secret in it), so a restart does not forget.
import fs from 'node:fs';
import path from 'node:path';

/** @param {string} dataDir */
export function createSignedIn(dataDir) {
  const file = path.join(dataDir, 'signed-in.json');
  /** @returns {Record<string, boolean>} */
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // none recorded yet, or a damaged file: nothing is known to be signed in
      return {};
    }
  };
  return {
    /** @param {string} id */
    get: (id) => read()[id] === true,
    /** @param {string} id @param {boolean} on */
    set(id, on) {
      const all = read();
      if (all[id] === on) return;
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...all, [id]: on }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}
