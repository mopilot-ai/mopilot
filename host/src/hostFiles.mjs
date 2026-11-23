// Read-only views of the files in a chat's folder on the Host (#4104): a folder's entries for the Files tree and one file's text for the preview. Nothing here writes. The folder is not trusted: every path is checked by its real path against the roots (a link inside a root that leaves it is refused, one that stays is followed), only regular files are opened (a FIFO or a device would hang the read), a file is read only to a bound, and every request has a time limit.
import fs from 'node:fs';
import path from 'node:path';
import { HostRefusal, isInside } from './hostFs.mjs';

/** A read that takes longer than this answers `read_timed_out`: a hung mount cannot hold the panel. */
export const READ_MS = 10_000;
/** The most bytes of one file a read returns, by default and at most. */
export const DEFAULT_READ_BYTES = 262_144;
export const MAX_READ_BYTES = 1_000_000;
/** The most entries of one folder an answer lists. */
export const MAX_TREE_ENTRIES = 2000;
/** The first bytes looked at for a NUL, which marks a file as binary. */
const SNIFF_BYTES = 8000;

/**
 * @param {{ hostFs: ReturnType<typeof import('./hostFs.mjs').createHostFs>, fsp?: typeof fs.promises, timeoutMs?: number }} o
 */
export function createHostFiles({ hostFs, fsp = fs.promises, timeoutMs = READ_MS }) {
  /** `work` with a time limit; the work is not cancelled, its answer is dropped. @template T @param {() => Promise<T>} work */
  function bounded(work) {
    /** @type {ReturnType<typeof setTimeout>} */
    let timer;
    const late = new Promise((_ok, no) => {
      timer = setTimeout(() => no(new HostRefusal('read_timed_out', 'The machine took too long to read that.')), timeoutMs);
    });
    return /** @type {Promise<T>} */ (Promise.race([work(), late]).finally(() => clearTimeout(timer)));
  }

  /**
   * The entries of the folder `path`, folders first: files and folders only, a link that leaves the roots left out, and `truncated` when the folder holds more than the bound.
   * @param {{ path: string }} q
   */
  async function tree({ path: p }) {
    return bounded(async () => {
      const dir = await hostFs.requireDirectory(p);
      const roots = await hostFs.roots();
      /** @type {{ name: string, isDirectory: boolean }[]} */
      const entries = [];
      let truncated = false;
      // by name before the bound, so a folder past it always shows the same names
      for (const e of (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        let isDirectory = e.isDirectory();
        let isFile = e.isFile();
        if (e.isSymbolicLink()) {
          try {
            const real = await fsp.realpath(path.join(dir, e.name));
            if (!roots.some((r) => isInside(r, real))) continue;
            const st = await fsp.stat(real);
            isDirectory = st.isDirectory();
            isFile = st.isFile();
          } catch {
            continue;
          }
        }
        if (!isDirectory && !isFile) continue;
        if (entries.length >= MAX_TREE_ENTRIES) {
          truncated = true;
          break;
        }
        entries.push({ name: e.name, isDirectory });
      }
      entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
      return { path: dir, entries, truncated };
    });
  }

  /**
   * The start of the file `path` as text, or its size when it is binary. Refuses a folder or a special file (`not_a_file`) and a path outside the roots by its real path.
   * @param {{ path: string, limit?: number }} q `limit`: the most bytes returned (default 256 KB, at most 1 MB)
   */
  async function read({ path: p, limit = DEFAULT_READ_BYTES }) {
    return bounded(async () => {
      const real = await hostFs.resolve(p);
      const want = Math.min(limit, MAX_READ_BYTES);
      // opened without blocking, and judged on the open handle: a path swapped for a pipe between a look and the open cannot hold the read
      const fh = await fsp.open(real, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      try {
        const st = await fh.stat();
        if (!st.isFile()) throw new HostRefusal('not_a_file', 'That is not a file.');
        // a file that says it is empty (procfs, sysfs) may still have content: it is read to the bound
        const buf = Buffer.alloc(st.size === 0 ? want : Math.min(want, st.size));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const got = buf.subarray(0, bytesRead);
        if (got.subarray(0, SNIFF_BYTES).includes(0)) return { kind: 'binary', size: Math.max(st.size, bytesRead) };
        const truncated = st.size > bytesRead || (st.size === 0 && bytesRead === want);
        let text = got.toString('utf8');
        // a cut can end inside a character: that half is dropped, not drawn as a replacement mark
        if (truncated && text.endsWith('�')) text = text.slice(0, -1);
        return { kind: 'text', text, size: Math.max(st.size, bytesRead), truncated };
      } finally {
        await fh.close();
      }
    });
  }

  return { tree, read };
}
