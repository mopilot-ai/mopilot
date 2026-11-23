// A crash in the middle of a file write, for tests of state files: a write into `dir` lands half its data, then throws.
import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'node:test';

/**
 * Until restored, every fs.writeFileSync to a path inside `dir` writes the first half of its data and throws
 * ENOSPC, as a full disk or a crash would leave it. Writes elsewhere (and to file descriptors) go through.
 * Returns the restore function.
 */
export function tornWrites(dir: string): () => void {
  const real = fs.writeFileSync;
  const inside = path.resolve(dir) + path.sep;
  const m = mock.method(fs, 'writeFileSync', (file: any, data: any, ...rest: any[]) => {
    if (typeof file === 'string' && path.resolve(file).startsWith(inside)) {
      const bytes = Buffer.from(data);
      real(file, bytes.subarray(0, Math.floor(bytes.length / 2)), ...rest);
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    }
    return real(file, data, ...rest);
  });
  return () => m.mock.restore();
}
