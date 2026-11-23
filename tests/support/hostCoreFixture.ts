// A Host version's core for a test archive: right for this machine by its record, and never loaded, since tests stage with `coreLoads`.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOST_CORE_ADDON, HOST_CORE_DIR, HOST_CORE_RECORD, coreBuildHere } from '../../shared/host/coreBuild.mjs';

/** Writes the core into the version at `dir`. @param build the machine it is for */
export function writeHostCore(dir: string, build = coreBuildHere()) {
  const core = path.join(dir, HOST_CORE_DIR);
  fs.mkdirSync(core, { recursive: true });
  fs.writeFileSync(path.join(core, HOST_CORE_ADDON), 'an addon');
  const sha256 = createHash('sha256').update('an addon').digest('hex');
  fs.writeFileSync(path.join(core, HOST_CORE_RECORD), JSON.stringify({ build, sha256 }));
}

/** What `stageUpdate` and `main` take in place of loading that file. */
export const coreLoads = () => '';
