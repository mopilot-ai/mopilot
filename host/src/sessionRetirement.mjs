// Durable chat tombstones fence late vendor events and restart recovery before journal directories are retired and collected.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export function createSessionRetirement({ root, io = fs, syncDir, deleted }) {
  const name = (id) => createHash('sha256').update(id).digest('hex');
  const marker = (id) => path.join(root, `${name(id)}.deleted`);
  return {
    has(id) {
      return io.existsSync(marker(id));
    },
    check(id) {
      if (io.existsSync(marker(id))) throw deleted();
    },
    remove(id) {
      io.mkdirSync(root, { recursive: true, mode: 0o700 });
      syncDir(path.dirname(root));
      const file = marker(id);
      // A retry fsyncs an existing marker too: a prior fsync failure must not be acknowledged as durable.
      const fd = io.openSync(file, 'a', 0o600);
      try {
        io.fsyncSync(fd);
      } finally {
        io.closeSync(fd);
      }
      syncDir(root);
      const retired = path.join(root, `${name(id)}.removed.${randomUUID()}`);
      try {
        io.renameSync(path.join(root, name(id)), retired);
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      syncDir(root);
      io.rmSync(retired, { recursive: true });
      syncDir(root);
    },
  };
}
