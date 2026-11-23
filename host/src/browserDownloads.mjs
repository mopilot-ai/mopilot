// Where a Host's browser downloads land (package 2.6): one folder per chat, Chromium saves under a guid, and a finished file gets the name the page suggested.
import { createHash } from 'node:crypto';
import path from 'node:path';

/** A directory name for a chat id: ids may hold any character, so the name is a digest. @param {string} chatId */
export const dirName = (chatId) => createHash('sha256').update(chatId).digest('hex').slice(0, 24);

/** A file name the page suggested, as a plain name that cannot leave the folder it is saved in. @param {unknown} name */
export const safeName = (name) => path.basename(String(name ?? '').replace(/[\u0000-\u001f]/g, '')).replace(/^\.+$/, '') || 'download';

/**
 * Renames a finished download from its guid to its name, `name (2)` when that is taken; '' when it cannot.
 * @param {{ name: string, dir: string }} d
 * @param {string} guid
 * @param {{ existsSync: (file: string) => boolean, renameSync: (from: string, to: string) => void }} files
 */
export function nameDownload(d, guid, files) {
  const ext = path.extname(d.name);
  const stem = d.name.slice(0, d.name.length - ext.length);
  let to = path.join(d.dir, d.name);
  for (let n = 2; files.existsSync(to); n++) to = path.join(d.dir, `${stem} (${n})${ext}`);
  try {
    files.renameSync(path.join(d.dir, guid), to);
    return to;
  } catch {
    return '';
  }
}
