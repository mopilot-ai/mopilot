// The release of the app that built this Host's archive, as the archive recorded it (`APP_VERSION` beside the bundle): read once; '' for a Host that was not unpacked from one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** One file the archive recorded beside the bundle ('' when there is none). @param {string} file */
export const recorded = (file) => {
  try {
    return fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', file), 'utf8').trim();
  } catch {
    return '';
  }
};

/** The version of the app that built this Host's archive ('' for one that was not unpacked from one, or from before archives recorded it): a build id has no order, a version does. */
export const hostAppVersion = recorded('APP_VERSION');
