// Discover probe streams independently of the always-on stall and renderer logs' live and rotated files.
import fs from 'node:fs';
import path from 'node:path';

/** Probe filenames in a launch's user-data folder, including an empty result before its first flush. @param {string} userData */
export function probeFiles(userData) {
  const dir = path.join(userData, 'perf');
  // the always-on logs (electron/perf/stalls.cjs, rendererLog.cjs) share the folder and carry no probe fields such as coreLoaded
  return (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter(
    (f) => f.endsWith('.jsonl') && !/^(?:stalls|renderer)(?:\.\d+)?\.jsonl$/.test(f),
  );
}
