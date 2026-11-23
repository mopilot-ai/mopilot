// Discover probe streams independently of the always-on stall logger's live and rotated files.
import fs from 'node:fs';
import path from 'node:path';

/** Probe filenames in a launch's user-data folder, including an empty result before its first flush. @param {string} userData */
export function probeFiles(userData) {
  const dir = path.join(userData, 'perf');
  return (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => f.endsWith('.jsonl') && !/^stalls(?:\.\d+)?\.jsonl$/.test(f));
}
